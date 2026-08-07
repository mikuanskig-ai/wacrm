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
// Also de-duplicates truly CONCURRENT identical lookups (in-flight
// requests share one provider call, not one each) — the cache above
// only protects sequential retries; two callers arriving before either
// has finished both miss the cache the same way one would. Confirmed
// live (2026-08-07, right after LocationIQ replaced ORS): two test
// conversations sent the same address seconds apart, both calculate_
// delivery_fee calls landed concurrently, and the resulting duplicate
// request tripped LocationIQ's per-second concurrency limit — exactly
// the kind of collision this second mechanism exists to avoid.
//
// Deliberately NOT caching failures: if the inner provider throws
// (rate limit, timeout, ORS down), that error propagates uncached — a
// cached failure would lock a customer out of ordering for the whole
// TTL even after the provider recovers, which is worse than the
// problem this exists to fix. Only a genuine answer (a match, or a
// confirmed "no match" `null`) is worth remembering. Concurrent callers
// sharing an in-flight call that ends up rejecting all see the same
// rejection — no worse than each having failed independently, and the
// in-flight entry is cleared either way so the next call gets a fresh
// attempt rather than being stuck replaying a dead promise.
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

  // Concurrent calls for the same key share one in-flight provider
  // call instead of each firing their own — see the file header for
  // the live incident this fixes. Cleared (success or failure) as soon
  // as the shared call settles, so the next call after that always
  // gets a fresh attempt rather than reusing a resolved/rejected one.
  private readonly geocodeInFlight = new Map<string, Promise<GeocodeResult | null>>()
  private readonly reverseGeocodeInFlight = new Map<string, Promise<GeocodeResult | null>>()
  private readonly distanceInFlight = new Map<string, Promise<number>>()

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

  /** Cache check → in-flight join → fresh call, in that order. The
   *  in-flight map holds the RAW fetch-in-progress promise (not this
   *  wrapper method's own returned promise, which is one more async-
   *  function-adopts-a-promise hop away) — every joined caller `await`s
   *  that same raw promise directly, so a rejection reaches all of them
   *  without ever reaching `write` (never cached, see file header). The
   *  `finally` below always clears the in-flight entry, success or
   *  failure, so the next call after this one settles gets a fresh
   *  attempt rather than replaying a dead promise. */
  private dedupe<T>(
    cache: Map<string, CacheEntry<T>>,
    inFlight: Map<string, Promise<T>>,
    key: string,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    const cached = this.read(cache, key)
    if (cached.hit) return Promise.resolve(cached.value)
    const pending = inFlight.get(key)
    if (pending) return pending

    const promise = fetcher()
    // Attach BEFORE storing — every caller (including this one) always
    // awaits the exact promise below, so cache-write/cleanup runs once
    // regardless of how many callers joined it.
    const tracked = promise.then(
      (result) => {
        inFlight.delete(key)
        this.write(cache, key, result)
        return result
      },
      (err) => {
        inFlight.delete(key)
        throw err
      },
    )
    inFlight.set(key, tracked)
    return tracked
  }

  geocode(address: string, options?: GeocodeOptions): Promise<GeocodeResult | null> {
    const key = geocodeKey(address, options)
    return this.dedupe(this.geocodeCache, this.geocodeInFlight, key, () => this.inner.geocode(address, options))
  }

  // Only used for the account's own origin address (Settings form) — a
  // rare, admin-driven, one-at-a-time call with no retry-storm risk.
  // Passed straight through rather than adding a fourth cache for a
  // path that was never the problem.
  geocodeStructured(parts: StructuredAddressParts, options?: GeocodeOptions): Promise<GeocodeResult | null> {
    return this.inner.geocodeStructured(parts, options)
  }

  reverseGeocode(point: { lat: number; lng: number }): Promise<GeocodeResult | null> {
    const key = pointKey(point)
    return this.dedupe(this.reverseGeocodeCache, this.reverseGeocodeInFlight, key, () =>
      this.inner.reverseGeocode(point),
    )
  }

  calculateDistance(
    origin: { lat: number; lng: number },
    destination: { lat: number; lng: number },
  ): Promise<number> {
    const key = `${pointKey(origin)}>${pointKey(destination)}`
    return this.dedupe(this.distanceCache, this.distanceInFlight, key, () =>
      this.inner.calculateDistance(origin, destination),
    )
  }
}
