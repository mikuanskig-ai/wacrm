import { describe, it, expect, vi } from 'vitest'
import { CachingDistanceProvider } from './caching-distance-provider'
import { DistanceProviderError, type DistanceProvider, type GeocodeResult } from '../distance-provider'

const RESULT: GeocodeResult = {
  lat: -24.95,
  lng: -53.47,
  neighborhood: 'Centro',
  label: 'Rua X, 123, Pato Branco, PR, Brazil',
  layer: 'address',
}

function fakeInner(overrides: Partial<DistanceProvider> = {}): DistanceProvider {
  return {
    geocode: vi.fn(async () => RESULT),
    geocodeStructured: vi.fn(async () => RESULT),
    reverseGeocode: vi.fn(async () => RESULT),
    calculateDistance: vi.fn(async () => 5),
    ...overrides,
  }
}

describe('CachingDistanceProvider — geocode', () => {
  it('serves a second identical lookup from cache — no second call to the inner provider', async () => {
    // The exact scenario this exists for: a customer resending the
    // same address (confirmed live 2026-08-07, up to 4x in one
    // conversation) shouldn't burn a fresh ORS call every time.
    const inner = fakeInner()
    const cache = new CachingDistanceProvider(inner)
    const first = await cache.geocode('Rua X, 123')
    const second = await cache.geocode('Rua X, 123')
    expect(first).toEqual(RESULT)
    expect(second).toEqual(RESULT)
    expect(inner.geocode).toHaveBeenCalledTimes(1)
  })

  it('is case/whitespace-insensitive on the address text', async () => {
    const inner = fakeInner()
    const cache = new CachingDistanceProvider(inner)
    await cache.geocode('Rua X, 123')
    await cache.geocode('  RUA x, 123  ')
    expect(inner.geocode).toHaveBeenCalledTimes(1)
  })

  it('treats different addresses as different cache entries', async () => {
    const inner = fakeInner()
    const cache = new CachingDistanceProvider(inner)
    await cache.geocode('Rua X, 123')
    await cache.geocode('Rua Y, 456')
    expect(inner.geocode).toHaveBeenCalledTimes(2)
  })

  it('treats the same address text under a different focus bias as different entries', async () => {
    // Two accounts (different restaurants, different origin bias) share
    // the one process-wide cache via getDistanceProvider() — the same
    // free-text address must not leak a result resolved for a
    // different account's disambiguation bias.
    const inner = fakeInner()
    const cache = new CachingDistanceProvider(inner)
    await cache.geocode('Centro', { focus: { lat: -24.95, lng: -53.47 } })
    await cache.geocode('Centro', { focus: { lat: -23.5, lng: -46.6 } })
    expect(inner.geocode).toHaveBeenCalledTimes(2)
  })

  it('caches a confirmed "not found" (null) result too — a repeat of a genuinely bad address is still one call', async () => {
    const inner = fakeInner({ geocode: vi.fn(async () => null) })
    const cache = new CachingDistanceProvider(inner)
    expect(await cache.geocode('nonsense')).toBeNull()
    expect(await cache.geocode('nonsense')).toBeNull()
    expect(inner.geocode).toHaveBeenCalledTimes(1)
  })

  it('never caches a thrown error — a rate-limited/down provider gets a fresh try next time', async () => {
    // The one thing this cache must NOT do: lock a customer out for the
    // whole TTL because of a transient ORS failure. See file header.
    const inner = fakeInner({
      geocode: vi.fn(async () => {
        throw new DistanceProviderError('rate limited')
      }),
    })
    const cache = new CachingDistanceProvider(inner)
    await expect(cache.geocode('Rua X, 123')).rejects.toThrow(DistanceProviderError)
    await expect(cache.geocode('Rua X, 123')).rejects.toThrow(DistanceProviderError)
    expect(inner.geocode).toHaveBeenCalledTimes(2)
  })

  it('re-queries once the TTL has elapsed', async () => {
    let now = 1_000_000
    const inner = fakeInner()
    const cache = new CachingDistanceProvider(inner, 60_000, () => now)
    await cache.geocode('Rua X, 123')
    now += 59_000
    await cache.geocode('Rua X, 123')
    expect(inner.geocode).toHaveBeenCalledTimes(1) // still fresh

    now += 2_000 // past the 60s TTL now
    await cache.geocode('Rua X, 123')
    expect(inner.geocode).toHaveBeenCalledTimes(2)
  })
})

describe('CachingDistanceProvider — reverseGeocode', () => {
  it('caches identical coordinates', async () => {
    const inner = fakeInner()
    const cache = new CachingDistanceProvider(inner)
    await cache.reverseGeocode({ lat: -24.95, lng: -53.47 })
    await cache.reverseGeocode({ lat: -24.95, lng: -53.47 })
    expect(inner.reverseGeocode).toHaveBeenCalledTimes(1)
  })

  it('treats different coordinates as different entries', async () => {
    const inner = fakeInner()
    const cache = new CachingDistanceProvider(inner)
    await cache.reverseGeocode({ lat: -24.95, lng: -53.47 })
    await cache.reverseGeocode({ lat: -25.0, lng: -53.5 })
    expect(inner.reverseGeocode).toHaveBeenCalledTimes(2)
  })

  it('never caches a thrown error', async () => {
    const inner = fakeInner({
      reverseGeocode: vi.fn(async () => {
        throw new DistanceProviderError('down')
      }),
    })
    const cache = new CachingDistanceProvider(inner)
    await expect(cache.reverseGeocode({ lat: 0, lng: 0 })).rejects.toThrow(DistanceProviderError)
    await expect(cache.reverseGeocode({ lat: 0, lng: 0 })).rejects.toThrow(DistanceProviderError)
    expect(inner.reverseGeocode).toHaveBeenCalledTimes(2)
  })
})

describe('CachingDistanceProvider — calculateDistance', () => {
  it('caches the same origin/destination pair', async () => {
    const inner = fakeInner()
    const cache = new CachingDistanceProvider(inner)
    const origin = { lat: -24.95, lng: -53.47 }
    const destination = { lat: -24.96, lng: -53.48 }
    await cache.calculateDistance(origin, destination)
    await cache.calculateDistance(origin, destination)
    expect(inner.calculateDistance).toHaveBeenCalledTimes(1)
  })

  it('does not confuse origin/destination order', async () => {
    const inner = fakeInner()
    const cache = new CachingDistanceProvider(inner)
    const a = { lat: -24.95, lng: -53.47 }
    const b = { lat: -24.96, lng: -53.48 }
    await cache.calculateDistance(a, b)
    await cache.calculateDistance(b, a)
    expect(inner.calculateDistance).toHaveBeenCalledTimes(2)
  })

  it('never caches a thrown error', async () => {
    const inner = fakeInner({
      calculateDistance: vi.fn(async () => {
        throw new DistanceProviderError('directions down')
      }),
    })
    const cache = new CachingDistanceProvider(inner)
    const origin = { lat: 0, lng: 0 }
    const destination = { lat: 1, lng: 1 }
    await expect(cache.calculateDistance(origin, destination)).rejects.toThrow(DistanceProviderError)
    await expect(cache.calculateDistance(origin, destination)).rejects.toThrow(DistanceProviderError)
    expect(inner.calculateDistance).toHaveBeenCalledTimes(2)
  })
})

describe('CachingDistanceProvider — geocodeStructured', () => {
  it('passes straight through, uncached — a rare admin-driven call, never the retry-storm path', async () => {
    const inner = fakeInner()
    const cache = new CachingDistanceProvider(inner)
    await cache.geocodeStructured({ locality: 'Pato Branco' })
    await cache.geocodeStructured({ locality: 'Pato Branco' })
    expect(inner.geocodeStructured).toHaveBeenCalledTimes(2)
  })
})

describe('CachingDistanceProvider — bounded size', () => {
  it('evicts the oldest entry once the per-cache cap is exceeded, rather than growing unbounded', async () => {
    const inner = fakeInner()
    const cache = new CachingDistanceProvider(inner)
    // Internals aren't exposed publicly — drive it through the public
    // API with a small enough loop to prove eviction happens without
    // hardcoding the exact cap value here.
    for (let i = 0; i < 2001; i++) {
      await cache.geocode(`Rua ${i}`)
    }
    // The very first address should have been evicted by now — asking
    // for it again must hit the inner provider once more.
    const callsBefore = (inner.geocode as ReturnType<typeof vi.fn>).mock.calls.length
    await cache.geocode('Rua 0')
    expect((inner.geocode as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore + 1)
  })
})

/** A promise the test controls the resolution of — used to simulate two
 *  callers arriving while the first provider call is still in flight,
 *  which `await`ing a fast-resolving mock can't reliably reproduce. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('CachingDistanceProvider — concurrent request de-duplication', () => {
  // Confirmed live (2026-08-07, right after switching to LocationIQ):
  // two test conversations sent the same address seconds apart, both
  // calculate_delivery_fee calls landed concurrently before either had
  // a chance to populate the cache above, and the resulting duplicate
  // request tripped the provider's per-second concurrency limit. The
  // TTL cache alone only protects sequential retries — this is what
  // protects genuinely simultaneous ones.
  it('two concurrent geocode calls for the same key share one inner call', async () => {
    const d = deferred<GeocodeResult | null>()
    const inner = fakeInner({ geocode: vi.fn(() => d.promise) })
    const cache = new CachingDistanceProvider(inner)

    const first = cache.geocode('Rua X, 123')
    const second = cache.geocode('Rua X, 123') // fires before `first` has resolved
    expect(inner.geocode).toHaveBeenCalledTimes(1) // not 2 — joined the same call

    d.resolve(RESULT)
    expect(await first).toEqual(RESULT)
    expect(await second).toEqual(RESULT)
  })

  it('concurrent calls for different keys are never joined together', async () => {
    const inner = fakeInner()
    const cache = new CachingDistanceProvider(inner)
    await Promise.all([cache.geocode('Rua X, 123'), cache.geocode('Rua Y, 456')])
    expect(inner.geocode).toHaveBeenCalledTimes(2)
  })

  it('two concurrent calls that both join a failing in-flight request both see the rejection', async () => {
    const inner = fakeInner({
      geocode: vi.fn(async () => {
        throw new DistanceProviderError('overloaded')
      }),
    })
    const cache = new CachingDistanceProvider(inner)
    const [firstResult, secondResult] = await Promise.allSettled([
      cache.geocode('Rua X, 123'),
      cache.geocode('Rua X, 123'),
    ])
    expect(firstResult.status).toBe('rejected')
    expect(secondResult.status).toBe('rejected')
    // Only ONE inner call for both joined callers — the whole point of
    // de-duplication — not one each.
    expect(inner.geocode).toHaveBeenCalledTimes(1)
  })

  it('a failed call is not cached, and clears so the NEXT (sequential) call gets a fresh attempt', async () => {
    const inner = fakeInner({
      geocode: vi.fn(async () => {
        throw new DistanceProviderError('overloaded')
      }),
    })
    const cache = new CachingDistanceProvider(inner)
    await expect(cache.geocode('Rua X, 123')).rejects.toThrow(DistanceProviderError)
    // The failed in-flight entry must be gone — a call after it settles
    // gets a brand new attempt, not stuck replaying the dead promise.
    await expect(cache.geocode('Rua X, 123')).rejects.toThrow(DistanceProviderError)
    expect(inner.geocode).toHaveBeenCalledTimes(2)
  })

  it('does the same for reverseGeocode and calculateDistance', async () => {
    const dReverse = deferred<GeocodeResult | null>()
    const dDistance = deferred<number>()
    const inner = fakeInner({
      reverseGeocode: vi.fn(() => dReverse.promise),
      calculateDistance: vi.fn(() => dDistance.promise),
    })
    const cache = new CachingDistanceProvider(inner)
    const point = { lat: -24.95, lng: -53.47 }

    const r1 = cache.reverseGeocode(point)
    const r2 = cache.reverseGeocode(point)
    const dist1 = cache.calculateDistance(point, point)
    const dist2 = cache.calculateDistance(point, point)
    expect(inner.reverseGeocode).toHaveBeenCalledTimes(1)
    expect(inner.calculateDistance).toHaveBeenCalledTimes(1)

    dReverse.resolve(RESULT)
    dDistance.resolve(5)
    await Promise.all([r1, r2, dist1, dist2])
  })
})
