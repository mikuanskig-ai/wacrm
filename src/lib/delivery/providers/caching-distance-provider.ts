// ============================================================
// Short-lived in-memory cache around any DistanceProvider. Added after
// a live incident (2026-08-07): a customer whose address wouldn't
// geocode resent the exact same address up to 4 times over a few
// minutes, and each retry burned a fresh ORS geocode + directions call
// — during a burst of heavy testing, that's exactly the pattern that
// exhausts ORS's free-tier quota/rate-limit (already hit twice this
// session on other endpoints) and turns a transient hiccup into a
// customer-visible "não consegui localizar esse endereço" for an
// address that resolves fine moments later. Caching identical lookups
// for a few minutes turns a retry storm into one real API call.
//
// Deliberately NOT caching failures: if the inner provider throws
// (rate limit, timeout, ORS down), that error propagates uncached — a
// cached failure would lock a customer out of ordering for the whole
// TTL even after the provider recovers, which is worse than the
// problem this exists to fix. Only a genuine answer (a match, or a
// confirmed "no match" `null`) is worth remembering.
//
// Process-local and unpersisted — a restart clears it, which is fine;
// this is a rate-limit shock absorber, not a source of truth. Shared
// across every account through the single `getDistanceProvider()`
// singleton (see openrouteservice.ts), so it protects the one ORS
// quota the whole app shares, not just one conversation's retries.
// ============================================================

import type {
  DistanceProvider,
  GeocodeOptions,
  GeocodeResult,
  StructuredAddressParts,
} from '../distance-provider'

/** How long a resolved (or confirmed-empty) lookup is trusted before
 *  asking the provider again. Long enough to absorb a customer resending
 *  the same address a few times while placing one order; short enough
 *  that a real-world change (a new street added to the provider's data,
 *  a corrected account origin) doesn't stay stale for long. */
export const DISTANCE_CACHE_TTL_MS = 15 * 60 * 1000

/** Hard cap per cache — a low-cardinality workload (one restaurant's
 *  delivery area) will never get close to this; it only exists so a
 *  long-running process can't grow these maps unbounded if usage ever
 *  scales up. Evicts the oldest entry (Map preserves insertion order)
 *  rather than implementing a real LRU — good enough for a safety net. */
const MAX_ENTRIES_PER_CACHE = 2000

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

function geocodeKey(address: string, options?: GeocodeOptions): string {
  const focus = options?.focus ? `${options.focus.lat},${options.focus.lng}` : ''
  return `${address.trim().toLowerCase()}|${focus}|${options?.radiusKm ?? ''}`
}

function pointKey(point: { lat: number; lng: number }): string {
  return `${point.lat},${point.lng}`
}

export class CachingDistanceProvider implements DistanceProvider {
  private readonly geocodeCache = new Map<string, CacheEntry<GeocodeResult | null>>()
  private readonly reverseGeocodeCache = new Map<string, CacheEntry<GeocodeResult | null>>()
  private readonly distanceCache = new Map<string, CacheEntry<number>>()

  constructor(
    private readonly inner: DistanceProvider,
    private readonly ttlMs: number = DISTANCE_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  private read<T>(cache: Map<string, CacheEntry<T>>, key: string): { hit: true; value: T } | { hit: false } {
    const entry = cache.get(key)
    if (!entry) return { hit: false }
    if (entry.expiresAt <= this.now()) {
      cache.delete(key)
      return { hit: false }
    }
    return { hit: true, value: entry.value }
  }

  private write<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): void {
    if (cache.size >= MAX_ENTRIES_PER_CACHE && !cache.has(key)) {
      const oldestKey = cache.keys().next().value
      if (oldestKey !== undefined) cache.delete(oldestKey)
    }
    cache.set(key, { value, expiresAt: this.now() + this.ttlMs })
  }

  async geocode(address: string, options?: GeocodeOptions): Promise<GeocodeResult | null> {
    const key = geocodeKey(address, options)
    const cached = this.read(this.geocodeCache, key)
    if (cached.hit) return cached.value
    // Not try/catch-wrapped on purpose — a thrown error propagates to
    // the caller without ever reaching `write`, so failures are never
    // cached (see file header).
    const result = await this.inner.geocode(address, options)
    this.write(this.geocodeCache, key, result)
    return result
  }

  // Only used for the account's own origin address (Settings form) — a
  // rare, admin-driven, one-at-a-time call with no retry-storm risk.
  // Passed straight through rather than adding a fourth cache for a
  // path that was never the problem.
  geocodeStructured(parts: StructuredAddressParts, options?: GeocodeOptions): Promise<GeocodeResult | null> {
    return this.inner.geocodeStructured(parts, options)
  }

  async reverseGeocode(point: { lat: number; lng: number }): Promise<GeocodeResult | null> {
    const key = pointKey(point)
    const cached = this.read(this.reverseGeocodeCache, key)
    if (cached.hit) return cached.value
    const result = await this.inner.reverseGeocode(point)
    this.write(this.reverseGeocodeCache, key, result)
    return result
  }

  async calculateDistance(
    origin: { lat: number; lng: number },
    destination: { lat: number; lng: number },
  ): Promise<number> {
    const key = `${pointKey(origin)}>${pointKey(destination)}`
    const cached = this.read(this.distanceCache, key)
    if (cached.hit) return cached.value
    const result = await this.inner.calculateDistance(origin, destination)
    this.write(this.distanceCache, key, result)
    return result
  }
}
