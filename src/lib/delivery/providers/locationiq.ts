// ============================================================
// LocationIQ — the default distance provider as of 2026-08-07,
// replacing OpenRouteService: ORS's free tier shares one small quota
// (2,500 requests/day) across geocode + directions + everything else,
// and that quota was repeatedly exhausted by real testing traffic the
// same day, which cost at least two real customer orders (see
// fee-engine.ts's geocode-failure logging, added the same incident,
// for how that shows up in journalctl next time). LocationIQ's free
// tier is 5,000 requests/day, split across geocode/reverse/directions
// rather than shared, and needs no card to sign up.
//
// Verified by hand against the exact addresses that failed live that
// day before switching: comparable Brazil coverage for this account's
// actual delivery area (Nominatim/OpenStreetMap-backed) once the same
// hard-bounding-box discipline ORS already used is applied here too —
// without it, a same-named place in a completely different state can
// still win (confirmed live: "14 de novembro" matched a square 700km
// away in Santana de Parnaíba-SP before `bounded=1` was added).
//
// Same "one platform key, not per-tenant" model as ORS_API_KEY — see
// that file's header for the reasoning; unchanged here. ORS itself
// stays in the codebase (openrouteservice.ts) as a documented fallback
// — see getDistanceProvider()'s DISTANCE_PROVIDER branch — in case
// LocationIQ ever needs to be rolled back.
// ============================================================

import {
  DistanceProviderError,
  type DistanceProvider,
  type GeocodeOptions,
  type GeocodeResult,
  type StructuredAddressParts,
} from '../distance-provider'

const BASE_URL = 'https://us1.locationiq.com/v1'

function apiKey(): string {
  const key = process.env.LOCATIONIQ_API_KEY?.trim()
  if (!key) {
    throw new DistanceProviderError(
      'LOCATIONIQ_API_KEY is not configured — distance-based delivery fee methods are unavailable until it is set.',
    )
  }
  return key
}

/** Caps how many LocationIQ requests THIS PROCESS has in flight at
 *  once. Confirmed live 2026-08-07: retries alone (below) weren't
 *  enough under sustained contention — two test conversations both
 *  retrying every few seconds kept re-colliding, because every retry
 *  was itself just another uncoordinated concurrent request. A limiter
 *  is the actual fix for a self-inflicted burst: it stops OUR process
 *  from ever sending more than `max` simultaneous requests in the
 *  first place, rather than reactively recovering after the provider
 *  rejects one. `max: 2` is deliberately conservative — a burst-replay
 *  against the real key showed 2 concurrent requests succeeding
 *  reliably and higher counts starting to fail — a busy restaurant's
 *  real traffic is nowhere near enough to notice a 2-wide queue, this
 *  is sized for defending against this app's own worst case, not
 *  normal load. */
class ConcurrencyLimiter {
  private inFlight = 0
  private readonly queue: (() => void)[] = []

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve))
    }
    this.inFlight++
    try {
      return await task()
    } finally {
      this.inFlight--
      const next = this.queue.shift()
      if (next) next()
    }
  }
}

const limiter = new ConcurrencyLimiter(2)

/** Retries with increasing backoff on 429 and — confirmed live
 *  2026-08-07 — 400: LocationIQ's free tier caps concurrent/per-second
 *  throughput tighter than its 5,000/day headline number suggests, and
 *  under concurrent load from this app it was observed returning 400
 *  rather than 429 for what a burst-replay proved was the exact same
 *  transient overload. Every attempt (including retries) goes through
 *  `limiter` above, which is the primary defense; this retry is the
 *  secondary one, for whatever a real customer's genuinely independent
 *  concurrent request still collides with (the limiter caps OUR
 *  concurrency, not everyone else hitting the same shared free-tier
 *  key/IP). A genuine 400 (malformed input) fails identically on every
 *  attempt and still surfaces as an error, just up to ~1.2s later. */
async function fetchWithRetry(url: string): Promise<Response> {
  const delaysMs = [300, 900]
  let res = await limiter.run(() => fetch(url))
  for (const delay of delaysMs) {
    if (res.status !== 429 && res.status !== 400) return res
    await new Promise((resolve) => setTimeout(resolve, delay))
    res = await limiter.run(() => fetch(url))
  }
  return res
}

interface LocationIqAddress {
  suburb?: string
  neighbourhood?: string
  city_district?: string
  [key: string]: unknown
}

interface LocationIqPlace {
  lat: string
  lon: string
  display_name?: string
  address?: LocationIqAddress
}

interface LocationIqDirectionsResponse {
  routes?: { distance?: number }[]
}

function placeToResult(place: LocationIqPlace | undefined): GeocodeResult | null {
  if (!place) return null
  const neighborhood =
    place.address?.suburb ?? place.address?.neighbourhood ?? place.address?.city_district ?? null
  return {
    lat: Number(place.lat),
    lng: Number(place.lon),
    neighborhood: typeof neighborhood === 'string' ? neighborhood : null,
    label: place.display_name ?? null,
    // Nominatim (what LocationIQ's search/reverse are built on) doesn't
    // report a Pelias-style match-precision layer the way ORS does —
    // `isPreciseGeocode` already treats a missing layer as imprecise-
    // until-proven-otherwise, same as ORS when it omits one too.
    layer: null,
  }
}

/** LocationIQ has no radius-around-a-point primitive like ORS's
 *  `boundary.circle` — approximated here with a `viewbox` + `bounded=1`
 *  (hard-excludes anything outside it, not just a ranking nudge — same
 *  "never trust a same-named place hundreds of km away" discipline ORS
 *  needed, see distance-provider.ts's GeocodeOptions doc). The box is
 *  built from the radius using ~111km per degree of latitude everywhere
 *  and per degree of longitude scaled by cos(latitude) — good enough for
 *  disambiguation, not survey-grade. */
function applyBoundingBox(url: URL, options?: GeocodeOptions): void {
  if (!options?.focus) return
  const radiusKm = options.radiusKm ?? 50
  const { lat, lng } = options.focus
  const latDelta = radiusKm / 111
  const cos = Math.cos((lat * Math.PI) / 180)
  const lngDelta = radiusKm / (111 * (Math.abs(cos) > 0.01 ? cos : 0.01))
  // viewbox = left,top,right,bottom (lon,lat,lon,lat)
  url.searchParams.set('viewbox', `${lng - lngDelta},${lat + latDelta},${lng + lngDelta},${lat - latDelta}`)
  url.searchParams.set('bounded', '1')
}

export class LocationIqProvider implements DistanceProvider {
  async geocode(address: string, options?: GeocodeOptions): Promise<GeocodeResult | null> {
    const trimmed = address.trim()
    if (!trimmed) return null

    const url = new URL(`${BASE_URL}/search`)
    url.searchParams.set('key', apiKey())
    url.searchParams.set('q', trimmed)
    url.searchParams.set('countrycodes', 'br')
    url.searchParams.set('format', 'json')
    url.searchParams.set('limit', '1')
    applyBoundingBox(url, options)

    const res = await fetchWithRetry(url.toString())
    // LocationIQ answers "no match" as a 404 (unlike ORS's 200 + empty
    // features array) — treated the same way here: null, not an error.
    if (res.status === 404) return null
    if (!res.ok) {
      throw new DistanceProviderError(`LocationIQ geocode failed with status ${res.status}`)
    }
    const body = (await res.json()) as LocationIqPlace[]
    return placeToResult(body[0])
  }

  async geocodeStructured(
    parts: StructuredAddressParts,
    options?: GeocodeOptions,
  ): Promise<GeocodeResult | null> {
    const locality = parts.locality.trim()
    if (!locality) return null

    const url = new URL(`${BASE_URL}/search`)
    url.searchParams.set('key', apiKey())
    if (parts.address?.trim()) url.searchParams.set('street', parts.address.trim())
    url.searchParams.set('city', locality)
    if (parts.region?.trim()) url.searchParams.set('state', parts.region.trim())
    if (parts.postalCode?.trim()) url.searchParams.set('postalcode', parts.postalCode.trim())
    url.searchParams.set('country', 'Brazil')
    url.searchParams.set('format', 'json')
    url.searchParams.set('limit', '1')
    applyBoundingBox(url, options)

    const res = await fetchWithRetry(url.toString())
    if (res.status === 404) return null
    if (!res.ok) {
      throw new DistanceProviderError(`LocationIQ structured geocode failed with status ${res.status}`)
    }
    const body = (await res.json()) as LocationIqPlace[]
    return placeToResult(body[0])
  }

  async reverseGeocode(point: { lat: number; lng: number }): Promise<GeocodeResult | null> {
    const url = new URL(`${BASE_URL}/reverse`)
    url.searchParams.set('key', apiKey())
    url.searchParams.set('lat', String(point.lat))
    url.searchParams.set('lon', String(point.lng))
    url.searchParams.set('format', 'json')

    const res = await fetchWithRetry(url.toString())
    if (res.status === 404) return null
    if (!res.ok) {
      throw new DistanceProviderError(`LocationIQ reverse geocode failed with status ${res.status}`)
    }
    const body = (await res.json()) as LocationIqPlace
    return placeToResult(body)
  }

  async calculateDistance(
    origin: { lat: number; lng: number },
    destination: { lat: number; lng: number },
  ): Promise<number> {
    const url = new URL(
      `${BASE_URL}/directions/driving/${origin.lng},${origin.lat};${destination.lng},${destination.lat}`,
    )
    url.searchParams.set('key', apiKey())
    url.searchParams.set('overview', 'false')

    const res = await fetchWithRetry(url.toString())
    if (!res.ok) {
      throw new DistanceProviderError(`LocationIQ directions failed with status ${res.status}`)
    }
    const body = (await res.json()) as LocationIqDirectionsResponse
    const meters = body.routes?.[0]?.distance
    if (typeof meters !== 'number') {
      throw new DistanceProviderError('LocationIQ directions response missing a distance value')
    }
    return meters / 1000
  }
}
