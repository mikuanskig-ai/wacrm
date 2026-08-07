// ============================================================
// Distance provider abstraction — the fee engine (fee-engine.ts) never
// talks to a mapping API directly, so swapping OpenRouteService for
// Google Maps/Mapbox later is a new file + one line in
// `getDistanceProvider()`, not a rewrite of the calculation logic.
// ============================================================

export interface GeocodeResult {
  lat: number
  lng: number
  /** Best-effort neighbourhood/borough name from the provider's
   *  address components, when it returns one. Used to auto-match the
   *  `neighborhood` method against a raw address — never guaranteed. */
  neighborhood: string | null
  /** Human-readable label the provider actually matched against — lets
   *  a caller show "resolved to: X" so a wrong-city match (a real,
   *  observed failure mode for small Brazilian towns) can be caught
   *  instead of silently trusted. */
  label: string | null
  /** Pelias-style match-precision layer (e.g. "address", "street",
   *  "neighbourhood", "locality", "region"), null when the provider
   *  doesn't report one. See `isPreciseGeocode` — a coarse layer looks
   *  exactly like a successful match (a real label, real coordinates)
   *  but can be kilometers from the actual address. */
  layer: string | null
}

/** Layers precise enough to trust as a specific address, not a
 *  city/region fallback. Real, observed failure mode: the structured
 *  geocoder resolved "Rua Presidente Kennedy 2237, Centro, Cascavel,
 *  PR" all the way down to a bare "Cascavel, PR, Brazil" — no error,
 *  no low-confidence flag, just a city-level point silently used as
 *  the store's exact location for every distance-based fee since.
 *  `layer: null` (provider reports no layer at all) is treated as
 *  imprecise too — we'd rather over-flag than trust a match we can't
 *  actually verify. */
const PRECISE_GEOCODE_LAYERS = new Set(['venue', 'address', 'street'])

export function isPreciseGeocode(layer: string | null): boolean {
  return layer !== null && PRECISE_GEOCODE_LAYERS.has(layer)
}

/** Street/city/state broken into separate fields — dramatically more
 *  accurate than a single free-text blob for small towns, where a
 *  geocoder can otherwise match the right street name in a same-named
 *  but wrong city hundreds of km away. Used for the restaurant's own
 *  origin address (entered once, in Settings), where structured input
 *  is practical. Customer delivery addresses stay free-text (there's
 *  no form to structure a WhatsApp message) — see `GeocodeOptions.focus`
 *  for how those get disambiguated instead. */
export interface StructuredAddressParts {
  /** Street + number, e.g. "Rua Gonsalves Dias, 105". */
  address?: string
  neighbourhood?: string
  /** City — required. An unqualified street/neighbourhood alone is
   *  too ambiguous across Brazil (many small towns share names). */
  locality: string
  /** State (full name or UF) — resolves ties between same-named
   *  cities in different states. */
  region?: string
  postalCode?: string
}

export interface GeocodeOptions {
  /** Bias results toward this point. Critical for free-text customer
   *  addresses: with several same-named places across Brazil and no
   *  state given, "closest to the restaurant" is the only reliable
   *  disambiguator available. NOTE: observed live to be too weak on
   *  its own — a same-named street 1000+km away still outranked the
   *  correct one at confidence 1 ("exact"). Pair with `radiusKm` for
   *  a hard cutoff, not just a ranking nudge. */
  focus?: { lat: number; lng: number }
  /** Hard-excludes any match further than this from `focus` (requires
   *  `focus` to also be set — a radius with no center is meaningless).
   *  Safe to set to the account's configured max delivery distance:
   *  driving distance is never shorter than straight-line distance, so
   *  a genuinely in-range address can never fall outside this circle. */
  radiusKm?: number
}

export interface DistanceProvider {
  /** Resolves a free-text address to coordinates (+ neighbourhood
   *  guess, when available). Returns null when the address can't be
   *  resolved at all — never a fabricated coordinate. */
  geocode(address: string, options?: GeocodeOptions): Promise<GeocodeResult | null>
  /** Structured variant — see `StructuredAddressParts`. Meaningfully
   *  more accurate than `geocode()` when the caller can supply
   *  separate fields (the origin-address form in Settings). */
  geocodeStructured(parts: StructuredAddressParts, options?: GeocodeOptions): Promise<GeocodeResult | null>
  /** Resolves coordinates back to a human-readable address/neighbourhood
   *  — used when the caller already has exact coordinates (e.g. a
   *  customer's WhatsApp location share) and needs a label to show
   *  them for confirmation, or a neighbourhood name for the
   *  `neighborhood` fee method. Returns null when nothing is found
   *  nearby — never a fabricated address. */
  reverseGeocode(point: { lat: number; lng: number }): Promise<GeocodeResult | null>
  /** Real driving distance in kilometers between two points. */
  calculateDistance(
    origin: { lat: number; lng: number },
    destination: { lat: number; lng: number },
  ): Promise<number>
}

export class DistanceProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DistanceProviderError'
  }
}
