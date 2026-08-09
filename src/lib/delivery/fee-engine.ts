// ============================================================
// Delivery fee engine — the single place that turns a
// `delivery_fee_configs` row + a customer address/subtotal into a
// concrete fee. Every channel that creates an order (manual form,
// WhatsApp Flow, AI chat, public cardápio checkout, N8N) calls
// `calculateDeliveryFeeForAccount` — never re-derives this logic.
//
// `calculateDeliveryFee` itself is pure (no I/O): it takes an already-
// loaded config, a `DistanceProvider` instance, and the request args,
// and returns a result. This is what fee-engine.test.ts exercises
// directly with a fake in-memory provider — the network wrapper
// (providers/openrouteservice.ts) is tested separately, same split as
// mercadopago-api.ts vs the code that calls it.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DistanceProviderError,
  isPreciseGeocode,
  type DistanceProvider,
  type GeocodeOptions,
  type GeocodeResult,
} from './distance-provider'
import { getDistanceProvider } from './providers/openrouteservice'

/** Geocodes one address, swallowing a provider/network failure into
 *  `null` (logged) rather than throwing — lets the caller retry with a
 *  simplified query instead of failing outright on the first attempt.
 *  A non-DistanceProviderError (a real bug) still propagates. */
async function tryGeocode(
  provider: DistanceProvider,
  address: string,
  options: GeocodeOptions,
): Promise<GeocodeResult | null> {
  try {
    return await provider.geocode(address, options)
  } catch (err) {
    if (err instanceof DistanceProviderError) {
      // Never silently discard *why* — a real address the provider
      // genuinely can't match looks identical to our own key being
      // invalid/rate-limited/the provider being down (both surface as
      // the same 'geocode_failed' reason to the customer), but they
      // need completely different fixes. This is the only place that
      // ever sees the provider's actual error detail for this call.
      console.error(`[fee-engine] geocode failed for "${address}":`, err.message)
      return null
    }
    throw err
  }
}

// Real, observed failure: a customer's complete, correct address
// ("Av Carlos Gomes 2166, Parque São Paulo Cascavel") failed to
// geocode outright via free-text search — Pelias's exact-housenumber
// coverage is thin for some streets (the same failure mode already
// worked around for the store's own origin address, see
// distance-provider.ts's isPreciseGeocode / fee-config/route.ts's
// retry). Stripping the house number and retrying often recovers at
// least a street-level match — an approximate point is far better
// than blocking the order entirely on "address not found" when the
// address was fine. Only strips the FIRST standalone 1-6 digit run
// (the house number, virtually always near the start) — deliberately
// conservative so it doesn't mangle a postal code elsewhere in the
// string; worst case the retry just doesn't help, it can never make
// the result worse (see the two call sites: the retry is only ever
// used when it beats what's already there).
function stripFirstHouseNumber(address: string): string | null {
  const stripped = address
    .replace(/,?\s*\b\d{1,6}\b\s*,?/, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return stripped && stripped !== address.trim() ? stripped : null
}

export type DeliveryMethod = 'fixed' | 'neighborhood' | 'distance_range' | 'per_km'

export interface NeighborhoodRule {
  id: string
  name: string
  price: number
}

export interface DistanceRangeRule {
  from: number
  to: number
  price: number
}

export interface DeliveryFeeSettings {
  fixed_price?: number
  neighborhoods?: NeighborhoodRule[]
  rules?: DistanceRangeRule[]
  base_price?: number
  price_per_km?: number
}

export interface DeliveryFeeConfig {
  method: DeliveryMethod
  maxDistance: number | null
  freeShippingAbove: number | null
  originLat: number | null
  originLng: number | null
  settings: DeliveryFeeSettings
}

export interface CalculateFeeArgs {
  /** Customer's free-text delivery address. Required whenever the
   *  config needs a distance (max_distance set, or method is
   *  distance_range/per_km) or when `neighborhoodName` is omitted for
   *  the neighborhood method — unless `destinationLat`/`destinationLng`
   *  are given instead. */
  address?: string | null
  /** Explicit neighbourhood pick (e.g. the customer chose one from a
   *  list) — skips the geocode-based auto-match entirely. */
  neighborhoodName?: string | null
  /** Exact destination coordinates — e.g. from a shared WhatsApp
   *  location pin. Strictly more accurate than any address-text
   *  geocode (device GPS vs a street-level guess), so when both are
   *  set this always wins over `address` and skips geocoding
   *  entirely. Doesn't help the `neighborhood` method without an
   *  explicit `neighborhoodName` — matching a name from coordinates
   *  alone would need reverse geocoding, which this doesn't do. */
  destinationLat?: number | null
  destinationLng?: number | null
  subtotal: number
}

export type DeliveryFeeFailureReason =
  | 'address_required'
  | 'origin_not_configured'
  | 'geocode_failed'
  | 'out_of_range'
  | 'neighborhood_not_found'
  | 'no_matching_distance_range'

export type DeliveryFeeResult =
  | {
      ok: true
      fee: number
      distanceKm: number | null
      /** Label the provider actually geocoded the destination address
       *  to (e.g. "Av. Papagaios, 1395, Cascavel - PR, Brazil"), null
       *  when no geocode was needed. Surfaced end-to-end to the
       *  simulator UI so an admin can tell a wrong-pin geocode apart
       *  from a correct-pin-but-wrong-route distance — see the
       *  origin_resolved_label precedent in fee-config/route.ts. */
      resolvedLabel: string | null
      freeShipping: boolean
      method: DeliveryMethod
    }
  | { ok: false; reason: DeliveryFeeFailureReason }

const DEFAULT_CONFIG: DeliveryFeeConfig = {
  method: 'fixed',
  maxDistance: null,
  freeShippingAbove: null,
  originLat: null,
  originLng: null,
  settings: { fixed_price: 0 },
}

/** Loads the account's delivery-fee config. No row = permissive
 *  default (free delivery, `fixed` @ 0) — same "no row = feature off"
 *  convention as delivery_business_hours/payment_configs, just with a
 *  permissive rather than a blocking default: an account that enabled
 *  the delivery module but hasn't configured fees yet should never
 *  have order creation silently break. */
export async function getDeliveryFeeConfig(
  db: SupabaseClient,
  accountId: string,
): Promise<DeliveryFeeConfig> {
  const { data } = await db
    .from('delivery_fee_configs')
    .select('delivery_method, max_distance, free_shipping_above, origin_lat, origin_lng, settings')
    .eq('account_id', accountId)
    .maybeSingle()

  if (!data) return DEFAULT_CONFIG

  return {
    method: data.delivery_method as DeliveryMethod,
    maxDistance: data.max_distance,
    freeShippingAbove: data.free_shipping_above,
    originLat: data.origin_lat,
    originLng: data.origin_lng,
    settings: (data.settings ?? {}) as DeliveryFeeSettings,
  }
}

/** Rounds to cents the same way computeCartTotal (create-order.ts)
 *  does, so a delivery fee never lands a fractional-cent value on the
 *  NUMERIC(12,2) column. */
function roundCents(value: number): number {
  return Math.round(value * 100) / 100
}

/** Accent/case-insensitive match — "São Paulo" matches "sao paulo". */
function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
}

function matchNeighborhood(rules: NeighborhoodRule[], name: string): NeighborhoodRule | null {
  const target = normalizeName(name)
  return rules.find((r) => normalizeName(r.name) === target) ?? null
}

function matchDistanceRange(rules: DistanceRangeRule[], distanceKm: number): DistanceRangeRule | null {
  return rules.find((r) => distanceKm >= r.from && distanceKm <= r.to) ?? null
}

/**
 * Pure — no I/O beyond the injected `provider`. Order of operations is
 * fixed by the product spec's own flowchart and explicit business
 * rules: distance → max-distance gate → free-shipping (always takes
 * priority over the method) → the method itself.
 */
export async function calculateDeliveryFee(
  config: DeliveryFeeConfig,
  args: CalculateFeeArgs,
  provider: DistanceProvider,
): Promise<DeliveryFeeResult> {
  const needsDistance =
    config.maxDistance != null || config.method === 'distance_range' || config.method === 'per_km'
  const hasExactCoords = args.destinationLat != null && args.destinationLng != null
  const needsGeocode =
    !hasExactCoords && (needsDistance || (config.method === 'neighborhood' && !args.neighborhoodName?.trim()))

  let distanceKm: number | null = null
  let geocodedNeighborhood: string | null = null
  let resolvedLabel: string | null = null
  let destinationPoint: { lat: number; lng: number } | null = null

  if (hasExactCoords) {
    // Ground-truth GPS — e.g. a shared WhatsApp location pin. Always
    // wins over `address` when both are present and needs no geocode
    // call at all: a device's own GPS is strictly more accurate than
    // any text-address geocode could be.
    destinationPoint = { lat: args.destinationLat as number, lng: args.destinationLng as number }
    resolvedLabel = 'Shared WhatsApp location'
  } else if (needsGeocode) {
    const address = args.address?.trim()
    if (!address) return { ok: false, reason: 'address_required' }

    // Bias toward the restaurant's own location, AND hard-exclude
    // anything outside a sane radius — with no state/city given,
    // "closest to the restaurant" is the only reliable way to pick
    // between same-named places scattered across Brazil, and the bias
    // alone isn't enough (observed live: a same-street match 1000+km
    // away still outranked the correct one at confidence 1). Radius
    // defaults to the account's own max delivery distance when set —
    // driving distance is never shorter than straight-line, so a
    // genuinely in-range address can never be excluded by this — or a
    // generous fallback when the account has no max distance configured
    // (see openrouteservice.ts's header comment for the full story).
    const focus =
      config.originLat != null && config.originLng != null
        ? { lat: config.originLat, lng: config.originLng }
        : undefined
    const radiusKm = focus ? (config.maxDistance ?? 50) : undefined

    let destination = await tryGeocode(provider, address, { focus, radiusKm })

    // Total failure, or a match too coarse to trust (see
    // isPreciseGeocode) — retry once with the house number stripped
    // before giving up. Only ever adopts the retry when it's an
    // improvement (fills a null, or upgrades a coarse match to a
    // precise one); a worse/equal retry result is discarded and the
    // original stands.
    if (!destination || !isPreciseGeocode(destination.layer)) {
      const simplified = stripFirstHouseNumber(address)
      if (simplified) {
        const retry = await tryGeocode(provider, simplified, { focus, radiusKm })
        if (retry && (!destination || isPreciseGeocode(retry.layer))) destination = retry
      }
    }

    if (!destination) {
      console.error(`[fee-engine] geocode returned no match for "${address}"`)
      return { ok: false, reason: 'geocode_failed' }
    }
    geocodedNeighborhood = destination.neighborhood
    resolvedLabel = destination.label
    destinationPoint = { lat: destination.lat, lng: destination.lng }
  }

  if (needsDistance) {
    if (!destinationPoint) return { ok: false, reason: 'address_required' }
    if (config.originLat == null || config.originLng == null) {
      return { ok: false, reason: 'origin_not_configured' }
    }
    try {
      distanceKm = await provider.calculateDistance(
        { lat: config.originLat, lng: config.originLng },
        destinationPoint,
      )
    } catch (err) {
      // Same reasoning as the geocode catch above — this fires
      // regardless of whether destinationPoint came from geocoding
      // text or from an exact shared-location pin, so if the root
      // cause is a broken/rate-limited provider key, a location share
      // fails here too. Log so that's distinguishable from "this one
      // address is unreachable" in production.
      const detail = err instanceof Error ? err.message : String(err)
      console.error('[fee-engine] calculateDistance failed:', detail)
      return { ok: false, reason: 'geocode_failed' }
    }
  }

  if (config.maxDistance != null && distanceKm != null && distanceKm > config.maxDistance) {
    return { ok: false, reason: 'out_of_range' }
  }

  if (config.freeShippingAbove != null && args.subtotal >= config.freeShippingAbove) {
    return { ok: true, fee: 0, distanceKm, resolvedLabel, freeShipping: true, method: config.method }
  }

  switch (config.method) {
    case 'fixed': {
      const fee = roundCents(config.settings.fixed_price ?? 0)
      return { ok: true, fee, distanceKm, resolvedLabel, freeShipping: false, method: 'fixed' }
    }
    case 'neighborhood': {
      const name = args.neighborhoodName?.trim() || geocodedNeighborhood
      if (!name) return { ok: false, reason: 'neighborhood_not_found' }
      const match = matchNeighborhood(config.settings.neighborhoods ?? [], name)
      if (!match) return { ok: false, reason: 'neighborhood_not_found' }
      return {
        ok: true,
        fee: roundCents(match.price),
        distanceKm,
        resolvedLabel,
        freeShipping: false,
        method: 'neighborhood',
      }
    }
    case 'distance_range': {
      if (distanceKm == null) return { ok: false, reason: 'address_required' }
      const match = matchDistanceRange(config.settings.rules ?? [], distanceKm)
      if (!match) return { ok: false, reason: 'no_matching_distance_range' }
      return {
        ok: true,
        fee: roundCents(match.price),
        distanceKm,
        resolvedLabel,
        freeShipping: false,
        method: 'distance_range',
      }
    }
    case 'per_km': {
      if (distanceKm == null) return { ok: false, reason: 'address_required' }
      const base = config.settings.base_price ?? 0
      const perKm = config.settings.price_per_km ?? 0
      return {
        ok: true,
        fee: roundCents(base + distanceKm * perKm),
        distanceKm,
        resolvedLabel,
        freeShipping: false,
        method: 'per_km',
      }
    }
  }
}

/** Thin wrapper — loads the account's config and the real distance
 *  provider, then delegates to the pure function above. This is the
 *  one entry point every channel (manual form, Flow engine, AI tool,
 *  public checkout, N8N) calls. */
export async function calculateDeliveryFeeForAccount(
  db: SupabaseClient,
  accountId: string,
  args: CalculateFeeArgs,
): Promise<DeliveryFeeResult> {
  const config = await getDeliveryFeeConfig(db, accountId)
  return calculateDeliveryFee(config, args, getDistanceProvider())
}
