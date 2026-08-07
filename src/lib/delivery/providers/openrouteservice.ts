// ============================================================
// OpenRouteService — first concrete DistanceProvider. Free tier (no
// credit card) is enough to validate the fee engine before a
// restaurant-count that justifies Google Maps billing.
//
// No longer the default as of 2026-08-07 (see locationiq.ts's header
// for why — ORS's shared 2,500/day quota was exhausted by real usage
// and cost real orders) — kept here as a documented, one-env-var
// fallback via `getDistanceProvider()` below, and this file's own
// `getDistanceProvider()` export is where that switch lives, which is
// why it stays the home for the factory even though it may now hand
// back a LocationIQ-backed provider by default.
//
// Platform-level credential (ORS_API_KEY env var), not a per-tenant
// BYO key — same operating model as WuzAPI/AUTOMATION_CRON_SECRET:
// one key, shared infrastructure, no per-restaurant setup burden.
// Read lazily inside each call (not at module load) so a missing key
// only breaks accounts that actually need distance, never the build.
//
// Real-world failure mode this file works around: ORS's Pelias-based
// geocoder has thin coverage for small Brazilian towns and will match
// a same-named street/city in the WRONG state with high self-reported
// confidence (observed live: "Rua Gonsalves Dias, 105, Malucelli,
// Santa Tereza do Oeste" matched a "Rua Gonsalves Dias" in Herval
// d'Oeste, SC — a different city entirely, ~400km off). Mitigations,
// none of which is a confidence/layer filter (the wrong, the fallback,
// AND the eventually-correct match have all been observed with
// identical-looking metadata — it doesn't distinguish them):
//   1. `geocodeStructured` — separate address/neighbourhood/locality/
//      region fields resolve the right city reliably (verified: the
//      same free-text query that picked a random wrong state matched
//      the correct city once locality+region were given explicitly).
//   2. `focus.point` bias on free-text `geocode()` calls (customer
//      addresses have no structured form) — nudges Pelias toward
//      matches near the restaurant instead of an arbitrary same-named
//      place anywhere in Brazil. Observed live to be too weak alone: a
//      street 1000+km away still outranked the correct in-town match
//      at confidence 1 ("exact").
//   3. `boundary.circle` — a HARD radius cutoff around the same focus
//      point (typically the account's configured max delivery
//      distance), not just a ranking nudge. This is what actually
//      excludes the far-away match; `focus.point` only breaks ties
//      among whatever's left inside the circle.
// ============================================================

import {
  DistanceProviderError,
  type DistanceProvider,
  type GeocodeOptions,
  type GeocodeResult,
  type StructuredAddressParts,
} from '../distance-provider'
import { CachingDistanceProvider } from './caching-distance-provider'
import { LocationIqProvider } from './locationiq'

const GEOCODE_URL = 'https://api.openrouteservice.org/geocode/search'
const GEOCODE_STRUCTURED_URL = 'https://api.openrouteservice.org/geocode/search/structured'
const REVERSE_GEOCODE_URL = 'https://api.openrouteservice.org/geocode/reverse'
// Directions, not Matrix — observed live: for the same two points, the
// Matrix endpoint (built for fast many-to-many lookups over a
// contracted graph) returned a meaningfully shorter distance than the
// Directions endpoint (single-pair, the same engine ORS's own public
// map demo uses) — 7.1km vs 8.6km for one real address in Cascavel-PR,
// against a ~9.0km real route. We only ever call this with exactly one
// origin/destination pair, so there's no batching upside to Matrix
// that would offset its lower precision.
const DIRECTIONS_URL = 'https://api.openrouteservice.org/v2/directions/driving-car'

function apiKey(): string {
  const key = process.env.ORS_API_KEY?.trim()
  if (!key) {
    throw new DistanceProviderError(
      'ORS_API_KEY is not configured — distance-based delivery fee methods are unavailable until it is set.',
    )
  }
  return key
}

interface OrsGeocodeFeature {
  geometry: { coordinates: [number, number] } // [lng, lat]
  properties: {
    label?: string
    neighbourhood?: string
    borough?: string
    /** Pelias match-precision layer — "address"/"street" for a real
     *  street match, "locality"/"region"/etc. for a coarser fallback.
     *  See distance-provider.ts's isPreciseGeocode. */
    layer?: string
    [key: string]: unknown
  }
}

interface OrsGeocodeResponse {
  features?: OrsGeocodeFeature[]
}

interface OrsDirectionsResponse {
  routes?: { summary?: { distance?: number } }[]
}

function featureToResult(feature: OrsGeocodeFeature | undefined): GeocodeResult | null {
  if (!feature) return null
  const [lng, lat] = feature.geometry.coordinates
  return {
    lat,
    lng,
    neighborhood: feature.properties.neighbourhood ?? feature.properties.borough ?? null,
    label: feature.properties.label ?? null,
    layer: typeof feature.properties.layer === 'string' ? feature.properties.layer : null,
  }
}

function applyLocationBias(url: URL, options?: GeocodeOptions): void {
  if (!options?.focus) return
  url.searchParams.set('focus.point.lat', String(options.focus.lat))
  url.searchParams.set('focus.point.lon', String(options.focus.lng))
  // A radius with no center is meaningless — only applies alongside focus.
  if (options.radiusKm != null) {
    url.searchParams.set('boundary.circle.lat', String(options.focus.lat))
    url.searchParams.set('boundary.circle.lon', String(options.focus.lng))
    url.searchParams.set('boundary.circle.radius', String(options.radiusKm))
  }
}

export class OpenRouteServiceProvider implements DistanceProvider {
  async geocode(address: string, options?: GeocodeOptions): Promise<GeocodeResult | null> {
    const trimmed = address.trim()
    if (!trimmed) return null

    const url = new URL(GEOCODE_URL)
    url.searchParams.set('api_key', apiKey())
    url.searchParams.set('text', trimmed)
    url.searchParams.set('boundary.country', 'BR')
    url.searchParams.set('size', '1')
    applyLocationBias(url, options)

    const res = await fetch(url.toString())
    if (!res.ok) {
      throw new DistanceProviderError(`OpenRouteService geocode failed with status ${res.status}`)
    }

    const body = (await res.json()) as OrsGeocodeResponse
    return featureToResult(body.features?.[0])
  }

  async geocodeStructured(
    parts: StructuredAddressParts,
    options?: GeocodeOptions,
  ): Promise<GeocodeResult | null> {
    const locality = parts.locality.trim()
    if (!locality) return null

    const url = new URL(GEOCODE_STRUCTURED_URL)
    url.searchParams.set('api_key', apiKey())
    if (parts.address?.trim()) url.searchParams.set('address', parts.address.trim())
    if (parts.neighbourhood?.trim()) url.searchParams.set('neighbourhood', parts.neighbourhood.trim())
    url.searchParams.set('locality', locality)
    if (parts.region?.trim()) url.searchParams.set('region', parts.region.trim())
    if (parts.postalCode?.trim()) url.searchParams.set('postalcode', parts.postalCode.trim())
    url.searchParams.set('country', 'Brazil')
    url.searchParams.set('size', '1')
    applyLocationBias(url, options)

    const res = await fetch(url.toString())
    if (!res.ok) {
      throw new DistanceProviderError(`OpenRouteService structured geocode failed with status ${res.status}`)
    }

    const body = (await res.json()) as OrsGeocodeResponse
    return featureToResult(body.features?.[0])
  }

  async reverseGeocode(point: { lat: number; lng: number }): Promise<GeocodeResult | null> {
    const url = new URL(REVERSE_GEOCODE_URL)
    url.searchParams.set('api_key', apiKey())
    url.searchParams.set('point.lat', String(point.lat))
    url.searchParams.set('point.lon', String(point.lng))
    url.searchParams.set('boundary.country', 'BR')
    url.searchParams.set('size', '1')

    const res = await fetch(url.toString())
    if (!res.ok) {
      throw new DistanceProviderError(`OpenRouteService reverse geocode failed with status ${res.status}`)
    }

    const body = (await res.json()) as OrsGeocodeResponse
    return featureToResult(body.features?.[0])
  }

  async calculateDistance(
    origin: { lat: number; lng: number },
    destination: { lat: number; lng: number },
  ): Promise<number> {
    const res = await fetch(DIRECTIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: apiKey(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        coordinates: [
          [origin.lng, origin.lat],
          [destination.lng, destination.lat],
        ],
        units: 'm',
      }),
    })

    if (!res.ok) {
      throw new DistanceProviderError(`OpenRouteService directions failed with status ${res.status}`)
    }

    const body = (await res.json()) as OrsDirectionsResponse
    const meters = body.routes?.[0]?.summary?.distance
    if (typeof meters !== 'number') {
      throw new DistanceProviderError('OpenRouteService directions response missing a distance value')
    }
    return meters / 1000
  }
}

let cached: DistanceProvider | null = null

/** Factory — swapping providers is a new class + a branch here, the
 *  fee engine never changes. Defaults to LocationIQ (see locationiq.ts's
 *  header for why); set `DISTANCE_PROVIDER=ors` to fall back to
 *  OpenRouteService without a code change, e.g. if LocationIQ ever has
 *  its own outage/quota problem. Either way the result is wrapped in
 *  the short-lived cache (caching-distance-provider.ts) — see that
 *  file's header for why: a customer retrying the same address burns a
 *  fresh provider call every time otherwise, and that retry pattern is
 *  exactly what exhausted ORS's free-tier quota during heavy testing
 *  (confirmed live 2026-08-07). */
export function getDistanceProvider(): DistanceProvider {
  if (!cached) {
    const inner =
      process.env.DISTANCE_PROVIDER === 'ors' ? new OpenRouteServiceProvider() : new LocationIqProvider()
    cached = new CachingDistanceProvider(inner)
  }
  return cached
}
