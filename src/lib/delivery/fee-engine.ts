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
import { DistanceProviderError, type DistanceProvider } from './distance-provider'
import { getDistanceProvider } from './providers/openrouteservice'

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
   *  the neighborhood method. */
  address?: string | null
  /** Explicit neighbourhood pick (e.g. the customer chose one from a
   *  list) — skips the geocode-based auto-match entirely. */
  neighborhoodName?: string | null
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
  | { ok: true; fee: number; distanceKm: number | null; freeShipping: boolean; method: DeliveryMethod }
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
  const needsGeocode =
    needsDistance || (config.method === 'neighborhood' && !args.neighborhoodName?.trim())

  let distanceKm: number | null = null
  let geocodedNeighborhood: string | null = null

  if (needsGeocode) {
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

    let destination
    try {
      destination = await provider.geocode(address, { focus, radiusKm })
    } catch (err) {
      if (err instanceof DistanceProviderError) return { ok: false, reason: 'geocode_failed' }
      throw err
    }
    if (!destination) return { ok: false, reason: 'geocode_failed' }
    geocodedNeighborhood = destination.neighborhood

    if (needsDistance) {
      if (config.originLat == null || config.originLng == null) {
        return { ok: false, reason: 'origin_not_configured' }
      }
      try {
        distanceKm = await provider.calculateDistance(
          { lat: config.originLat, lng: config.originLng },
          { lat: destination.lat, lng: destination.lng },
        )
      } catch {
        return { ok: false, reason: 'geocode_failed' }
      }
    }
  }

  if (config.maxDistance != null && distanceKm != null && distanceKm > config.maxDistance) {
    return { ok: false, reason: 'out_of_range' }
  }

  if (config.freeShippingAbove != null && args.subtotal >= config.freeShippingAbove) {
    return { ok: true, fee: 0, distanceKm, freeShipping: true, method: config.method }
  }

  switch (config.method) {
    case 'fixed': {
      const fee = roundCents(config.settings.fixed_price ?? 0)
      return { ok: true, fee, distanceKm, freeShipping: false, method: 'fixed' }
    }
    case 'neighborhood': {
      const name = args.neighborhoodName?.trim() || geocodedNeighborhood
      if (!name) return { ok: false, reason: 'neighborhood_not_found' }
      const match = matchNeighborhood(config.settings.neighborhoods ?? [], name)
      if (!match) return { ok: false, reason: 'neighborhood_not_found' }
      return { ok: true, fee: roundCents(match.price), distanceKm, freeShipping: false, method: 'neighborhood' }
    }
    case 'distance_range': {
      if (distanceKm == null) return { ok: false, reason: 'address_required' }
      const match = matchDistanceRange(config.settings.rules ?? [], distanceKm)
      if (!match) return { ok: false, reason: 'no_matching_distance_range' }
      return { ok: true, fee: roundCents(match.price), distanceKm, freeShipping: false, method: 'distance_range' }
    }
    case 'per_km': {
      if (distanceKm == null) return { ok: false, reason: 'address_required' }
      const base = config.settings.base_price ?? 0
      const perKm = config.settings.price_per_km ?? 0
      return {
        ok: true,
        fee: roundCents(base + distanceKm * perKm),
        distanceKm,
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
