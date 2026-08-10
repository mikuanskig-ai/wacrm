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
  /** `per_km`'s floor, not an addend — confirmed with the account owner
   *  (2026-08-08): a short trip (e.g. ≤1km) should charge just this
   *  minimum, and a longer one should charge distanceKm * price_per_km
   *  on its own, never base_price + distanceKm * price_per_km. See the
   *  'per_km' case below (`Math.max`, not `+`). */
  base_price?: number
  price_per_km?: number
}

export interface DeliveryFeeConfig {
  method: DeliveryMethod
  maxDistance: number | null
  freeShippingAbove: number | null
  originLat: number | null
  originLng: number | null
  /** The account's own registered city/state (Settings > delivery
   *  origin address) — used to fill in a customer's free-text address
   *  when it doesn't already name one. See `enrichAddressWithOriginCity`
   *  for why: confirmed live (2026-08-07) that a customer repeatedly
   *  typing a real, in-range street ("Av Carlos Gomes 2166, Parque São
   *  Paulo") with no city kept failing to geocode or landing on a
   *  same-named street elsewhere — every other account's customer will
   *  have the exact same blind spot (nobody prefixes their own
   *  neighbourhood with their city when giving a local address), so
   *  this isn't specific to one flaky address. */
  originCity: string | null
  originState: string | null
  settings: DeliveryFeeSettings
}

export interface CalculateFeeArgs {
  /** Customer's free-text delivery address. Required whenever the
   *  config needs a distance (max_distance set, or method is
   *  distance_range/per_km) or when `neighborhoodName` is omitted for
   *  the neighborhood method — unless `location` is given instead. */
  address?: string | null
  /** Explicit neighbourhood pick (e.g. the customer chose one from a
   *  list) — skips the geocode-based auto-match entirely. */
  neighborhoodName?: string | null
  /** Exact coordinates already known — e.g. a customer shared their
   *  location in WhatsApp instead of typing an address. When set, this
   *  is used as the destination directly: no forward geocoding of
   *  `address` happens at all, which is both strictly more accurate
   *  (no free-text ambiguity) and lighter on the geocode provider's
   *  quota. A reverse geocode still runs, but only when a distance or
   *  the neighbourhood method's name is actually needed, and never
   *  blocks the fee/distance result if it fails — see
   *  `calculateDeliveryFee`. */
  location?: { lat: number; lng: number } | null
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
      /** True when `distanceKm` came from the straight-line fallback
       *  (see `estimateStraightLineDistanceKm`) because the routing
       *  provider's Directions call failed on every retry — the fee is
       *  a real number the order can proceed on, just not driving-
       *  route-accurate. Always false when the method needs no
       *  distance at all (`fixed`) or the real call succeeded. */
      distanceEstimated: boolean
    }
  | { ok: false; reason: DeliveryFeeFailureReason }

const DEFAULT_CONFIG: DeliveryFeeConfig = {
  method: 'fixed',
  maxDistance: null,
  freeShippingAbove: null,
  originLat: null,
  originLng: null,
  originCity: null,
  originState: null,
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
    .select(
      'delivery_method, max_distance, free_shipping_above, origin_lat, origin_lng, origin_city, origin_state, settings',
    )
    .eq('account_id', accountId)
    .maybeSingle()

  if (!data) return DEFAULT_CONFIG

  return {
    method: data.delivery_method as DeliveryMethod,
    maxDistance: data.max_distance,
    freeShippingAbove: data.free_shipping_above,
    originLat: data.origin_lat,
    originLng: data.origin_lng,
    originCity: data.origin_city,
    originState: data.origin_state,
    settings: (data.settings ?? {}) as DeliveryFeeSettings,
  }
}

/** Rounds to cents the same way computeCartTotal (create-order.ts)
 *  does, so a delivery fee never lands a fractional-cent value on the
 *  NUMERIC(12,2) column. */
function roundCents(value: number): number {
  return Math.round(value * 100) / 100
}

/** Accent/case-insensitive match — "São Paulo" matches "sao paulo".
 *  Also strips a leading "bairro"/"b." label — confirmed live
 *  (2026-08-10): a customer asked for their bairro separately
 *  answered "Bairro Santo Onofre" (the label is a completely normal
 *  way to answer "qual o bairro?" in Portuguese), which does not match
 *  a registered "Santo Onofre" without this, even though the name
 *  itself is right there. Registered names are never stored with the
 *  label (confirmed against real account data), so this only ever
 *  strips it off the customer-facing side — never risks two distinct
 *  registered zones colliding. */
function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/^b(airro)?[.:]?\s+/, '')
    .trim()
}

/**
 * Appends the account's own registered city/state to a customer's
 * free-text address when it doesn't already name one. Confirmed live
 * (2026-08-07): a customer typed a real, in-range street ("Av Carlos
 * Gomes 2166, Parque São Paulo") with no city, and it repeatedly
 * failed to geocode or risked landing on a same-named street in a
 * different city — the exact ambiguity `focus`/`radiusKm` above only
 * partially guards against. Nobody locally gives their own city when
 * describing a nearby address ("I live on Av Carlos Gomes" — obviously
 * in Cascavel, if you're a Cascavel customer), so this isn't specific
 * to one address; every customer of every account has the same blind
 * spot the moment the account has a registered city to fall back on.
 * A no-op (returns the address unchanged) when the account hasn't set
 * one, or the customer's text already names it.
 */
function enrichAddressWithOriginCity(address: string, city: string | null, state: string | null): string {
  if (!city?.trim()) return address
  if (normalizeName(address).includes(normalizeName(city))) return address
  const suffix = state?.trim() ? `${city}, ${state}` : city
  return `${address}, ${suffix}`
}

/** A driving route is always at least as long as the straight line
 *  between two points, and in practice noticeably longer (rivers,
 *  highways forcing detours, one-way streets) — this padding
 *  approximates that gap for typical Brazilian street grids. Picked
 *  deliberately conservative (rounds the estimate UP, never down) so
 *  a customer is never undercharged for a genuinely longer route; the
 *  business absorbs the (usually small) opposite risk of a slightly
 *  padded fee on a route that happened to be close to a straight
 *  line. */
const STRAIGHT_LINE_ROAD_PADDING = 1.35

/** Great-circle distance between two points, in km (haversine
 *  formula) — the fallback used only when the real Directions call
 *  fails on every retry (see the calculateDistance catch below).
 *  Confirmed live (2026-08-08): even with a widened retry schedule,
 *  the provider's Directions endpoint kept intermittently failing for
 *  one particular route several times in under an hour, blocking a
 *  real order each time despite the address/pin having resolved just
 *  fine — an order should never dead-end on a routing hiccup when a
 *  reasonable estimate is one multiplication away. */
function estimateStraightLineDistanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371 // Earth's mean radius, km
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const sinLat = Math.sin(dLat / 2)
  const sinLng = Math.sin(dLng / 2)
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng
  const straightLineKm = 2 * R * Math.asin(Math.sqrt(h))
  return straightLineKm * STRAIGHT_LINE_ROAD_PADDING
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
  const needsNeighborhoodName = config.method === 'neighborhood' && !args.neighborhoodName?.trim()

  let distanceKm: number | null = null
  let geocodedNeighborhood: string | null = null
  let resolvedLabel: string | null = null
  let destinationPoint: { lat: number; lng: number } | null = null
  let distanceEstimated = false

  if (args.location) {
    // Exact coordinates already known (e.g. a WhatsApp location share)
    // — used as the destination directly, no forward geocoding of free
    // text at all. A reverse geocode still runs when a name/label is
    // actually needed (neighbourhood-method matching, or just a label
    // to show the customer for confirmation), but it's best-effort: if
    // it fails, the fee/distance calculation below still proceeds off
    // the raw coordinates, which the Directions call doesn't need a
    // geocode for either way.
    destinationPoint = args.location
    if (needsDistance || needsNeighborhoodName) {
      try {
        const reverse = await provider.reverseGeocode(args.location)
        geocodedNeighborhood = reverse?.neighborhood ?? null
        resolvedLabel = reverse?.label ?? null
      } catch (err) {
        if (!(err instanceof DistanceProviderError)) throw err
        // Best-effort and non-fatal (see comment above) — still worth a
        // breadcrumb, since a wave of these means the provider itself is
        // degraded (quota/outage), not that any one customer's location
        // was bad.
        console.error('[fee-engine] reverseGeocode failed (non-fatal):', err.message)
      }
    }
  } else if (needsDistance || needsNeighborhoodName) {
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
    const enrichedAddress = enrichAddressWithOriginCity(address, config.originCity, config.originState)

    // Confirmed live (2026-08-07/08): two distinct, independent failure
    // modes on an address that's actually fine — missing city (fixed by
    // enrichAddressWithOriginCity above) and the provider's thin exact-
    // housenumber coverage on some streets (fixed by the retry below).
    // Both showed up to customers as the same "não consegui localizar
    // esse endereço", at least two abandoned their order over it — see
    // tryGeocode for why the failure is always logged, never swallowed.
    let destination = await tryGeocode(provider, enrichedAddress, { focus, radiusKm })

    // Total failure, or a match too coarse to trust (see
    // isPreciseGeocode) — retry once with the house number stripped
    // before giving up. Only ever adopts the retry when it's an
    // improvement (fills a null, or upgrades a coarse match to a
    // precise one); a worse/equal retry result is discarded and the
    // original stands.
    if (!destination || !isPreciseGeocode(destination.layer)) {
      const simplified = stripFirstHouseNumber(enrichedAddress)
      if (simplified) {
        const retry = await tryGeocode(provider, simplified, { focus, radiusKm })
        if (retry && (!destination || isPreciseGeocode(retry.layer))) destination = retry
      }
    }

    if (!destination) {
      console.error(`[fee-engine] geocode returned no match for "${enrichedAddress}"`)
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
      // The routing call itself failed (not the geocode — the address/
      // pin already resolved fine above), even after every retry the
      // provider wrapper already attempts internally. Logged distinctly
      // from a geocode failure so an ops read of journalctl doesn't
      // conflate "geocode API down" with "directions API down" — same
      // provider, same free-tier fragility, but a different endpoint/
      // quota under the hood.
      //
      // Falls back to a straight-line estimate (padded — see
      // estimateStraightLineDistanceKm) rather than failing the whole
      // calculation: confirmed live (2026-08-08) that a customer whose
      // address geocoded correctly still got dead-ended repeatedly by
      // this exact failure within the same hour, even with retries. An
      // approximate fee that lets the order proceed beats blocking it
      // on a routing provider hiccup — `distanceEstimated: true` below
      // is how a caller (or a future admin view) can tell the two apart.
      const message = err instanceof Error ? err.message : String(err)
      distanceKm = estimateStraightLineDistanceKm(
        { lat: config.originLat, lng: config.originLng },
        destinationPoint,
      )
      // TEMP diagnostic (2026-08-09): logging the actual origin/
      // destination/estimate every time this fires — a live report of
      // an absurdly large fee (thousands of km) on an address that
      // geocodes to a sane point in isolated manual testing needs the
      // exact runtime coordinates to diagnose, not another guess.
      // Remove once that's root-caused.
      console.error(
        '[fee-engine] calculateDistance failed, falling back to straight-line estimate:',
        message,
        JSON.stringify({
          origin: { lat: config.originLat, lng: config.originLng },
          destination: destinationPoint,
          resolvedLabel,
          estimateKm: distanceKm,
        }),
      )
      distanceEstimated = true
    }
  }

  if (config.maxDistance != null && distanceKm != null && distanceKm > config.maxDistance) {
    return { ok: false, reason: 'out_of_range' }
  }

  if (config.freeShippingAbove != null && args.subtotal >= config.freeShippingAbove) {
    return { ok: true, fee: 0, distanceKm, resolvedLabel, freeShipping: true, method: config.method, distanceEstimated }
  }

  switch (config.method) {
    case 'fixed': {
      const fee = roundCents(config.settings.fixed_price ?? 0)
      return { ok: true, fee, distanceKm, resolvedLabel, freeShipping: false, method: 'fixed', distanceEstimated }
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
        distanceEstimated,
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
        distanceEstimated,
      }
    }
    case 'per_km': {
      if (distanceKm == null) return { ok: false, reason: 'address_required' }
      const base = config.settings.base_price ?? 0
      const perKm = config.settings.price_per_km ?? 0
      // base_price is a floor, not an addend — confirmed with the
      // account owner (2026-08-08): a short trip charges just the
      // minimum, a longer one charges distanceKm * price_per_km on its
      // own. Adding the two (the original formula) overcharged every
      // single order regardless of distance — e.g. a 6.35km trip at
      // R$6 base + R$2.20/km priced as R$19.96 instead of the correct
      // R$13.97 (just 6.35 × 2.2 — well above the R$6 floor already).
      const fee = Math.max(base, distanceKm * perKm)
      return {
        ok: true,
        fee: roundCents(fee),
        distanceKm,
        resolvedLabel,
        freeShipping: false,
        method: 'per_km',
        distanceEstimated,
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
