import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  calculateDeliveryFee,
  getDeliveryFeeConfig,
  type DeliveryFeeConfig,
} from './fee-engine'
import { DistanceProviderError, type DistanceProvider, type GeocodeResult } from './distance-provider'

function fakeProvider(overrides: Partial<DistanceProvider> = {}): DistanceProvider {
  return {
    geocode: vi.fn(
      async (): Promise<GeocodeResult | null> => ({
        lat: -23.5,
        lng: -46.6,
        neighborhood: null,
        label: null,
        layer: 'address',
      }),
    ),
    geocodeStructured: vi.fn(async (): Promise<GeocodeResult | null> => null),
    reverseGeocode: vi.fn(async (): Promise<GeocodeResult | null> => null),
    calculateDistance: vi.fn(async () => 5),
    ...overrides,
  }
}

const BASE_CONFIG: DeliveryFeeConfig = {
  method: 'fixed',
  maxDistance: null,
  freeShippingAbove: null,
  originLat: -23.5,
  originLng: -46.6,
  originCity: null,
  originState: null,
  settings: { fixed_price: 8 },
}

describe('calculateDeliveryFee — fixed', () => {
  it('returns the fixed price without ever calling the distance provider', async () => {
    const provider = fakeProvider()
    const result = await calculateDeliveryFee(BASE_CONFIG, { subtotal: 30 }, provider)
    expect(result).toEqual({
      ok: true,
      fee: 8,
      distanceKm: null,
      resolvedLabel: null,
      freeShipping: false,
      method: 'fixed',
      distanceEstimated: false,
    })
    expect(provider.geocode).not.toHaveBeenCalled()
    expect(provider.calculateDistance).not.toHaveBeenCalled()
  })

  it('defaults to 0 when fixed_price is missing', async () => {
    const config: DeliveryFeeConfig = { ...BASE_CONFIG, settings: {} }
    const result = await calculateDeliveryFee(config, { subtotal: 30 }, fakeProvider())
    expect(result).toEqual({
      ok: true,
      fee: 0,
      distanceKm: null,
      resolvedLabel: null,
      freeShipping: false,
      method: 'fixed',
      distanceEstimated: false,
    })
  })
})

describe('calculateDeliveryFee — neighborhood', () => {
  const config: DeliveryFeeConfig = {
    ...BASE_CONFIG,
    method: 'neighborhood',
    settings: {
      neighborhoods: [
        { id: '1', name: 'Centro', price: 5 },
        { id: '2', name: 'São Paulo', price: 12 },
      ],
    },
  }

  it('matches an explicit neighborhoodName case-insensitively', async () => {
    const result = await calculateDeliveryFee(config, { neighborhoodName: 'centro', subtotal: 30 }, fakeProvider())
    expect(result).toEqual({
      ok: true,
      fee: 5,
      distanceKm: null,
      resolvedLabel: null,
      freeShipping: false,
      method: 'neighborhood',
      distanceEstimated: false,
    })
  })

  it('matches accent-insensitively', async () => {
    const result = await calculateDeliveryFee(
      config,
      { neighborhoodName: 'sao paulo', subtotal: 30 },
      fakeProvider(),
    )
    expect(result).toEqual({
      ok: true,
      fee: 12,
      distanceKm: null,
      resolvedLabel: null,
      freeShipping: false,
      method: 'neighborhood',
      distanceEstimated: false,
    })
  })

  it('falls back to the geocoded neighbourhood guess when none is given explicitly', async () => {
    const provider = fakeProvider({
      geocode: vi.fn(async () => ({ lat: -23.5, lng: -46.6, neighborhood: 'Centro', label: null, layer: 'address' })),
    })
    const result = await calculateDeliveryFee(config, { address: 'Rua X, 100', subtotal: 30 }, provider)
    expect(result).toEqual({
      ok: true,
      fee: 5,
      distanceKm: null,
      resolvedLabel: null,
      freeShipping: false,
      method: 'neighborhood',
      distanceEstimated: false,
    })
  })

  it('surfaces the provider-resolved label so an admin can spot a wrong geocode pin', async () => {
    const provider = fakeProvider({
      geocode: vi.fn(async () => ({
        lat: -24.95,
        lng: -53.45,
        neighborhood: 'Centro',
        label: 'Av. Papagaios, 1395, Cascavel - PR, Brazil',
        layer: 'address',
      })),
    })
    const result = await calculateDeliveryFee(config, { address: 'Av. Papagaios, 1395', subtotal: 30 }, provider)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.resolvedLabel).toBe('Av. Papagaios, 1395, Cascavel - PR, Brazil')
    }
  })

  it('matches even when the customer answers with the "Bairro" label attached — confirmed live 2026-08-10', async () => {
    const config2: DeliveryFeeConfig = {
      ...BASE_CONFIG,
      method: 'neighborhood',
      settings: { neighborhoods: [{ id: '3', name: 'Santo Onofre', price: 12 }] },
    }
    const result = await calculateDeliveryFee(
      config2,
      { neighborhoodName: 'Bairro Santo Onofre', subtotal: 30 },
      fakeProvider(),
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.fee).toBe(12)
  })

  it('fails with neighborhood_not_found when nothing matches', async () => {
    const result = await calculateDeliveryFee(
      config,
      { neighborhoodName: 'Nowhereland', subtotal: 30 },
      fakeProvider(),
    )
    expect(result).toEqual({ ok: false, reason: 'neighborhood_not_found' })
  })

  it('requires an address when no neighborhoodName is given', async () => {
    const result = await calculateDeliveryFee(config, { subtotal: 30 }, fakeProvider())
    expect(result).toEqual({ ok: false, reason: 'address_required' })
  })
})

describe('calculateDeliveryFee — distance_range', () => {
  const config: DeliveryFeeConfig = {
    ...BASE_CONFIG,
    method: 'distance_range',
    settings: {
      rules: [
        { from: 0, to: 3, price: 5 },
        { from: 3, to: 5, price: 8 },
        { from: 5, to: 8, price: 12 },
      ],
    },
  }

  it('picks the range matching the computed distance', async () => {
    const provider = fakeProvider({ calculateDistance: vi.fn(async () => 4) })
    const result = await calculateDeliveryFee(config, { address: 'Rua X, 100', subtotal: 30 }, provider)
    expect(result).toEqual({
      ok: true,
      fee: 8,
      distanceKm: 4,
      resolvedLabel: null,
      freeShipping: false,
      method: 'distance_range',
      distanceEstimated: false,
    })
  })

  it('is inclusive on range boundaries, first match wins on an overlapping edge', async () => {
    // 3km sits on the boundary between the first two rules — the
    // first rule tested (0–3) wins ties, same "first match" semantics
    // as Array.prototype.find.
    const atOverlap = fakeProvider({ calculateDistance: vi.fn(async () => 3) })
    expect(await calculateDeliveryFee(config, { address: 'X', subtotal: 30 }, atOverlap)).toEqual({
      ok: true,
      fee: 5,
      distanceKm: 3,
      resolvedLabel: null,
      freeShipping: false,
      method: 'distance_range',
      distanceEstimated: false,
    })

    const atUpperBound = fakeProvider({ calculateDistance: vi.fn(async () => 8) })
    expect(await calculateDeliveryFee(config, { address: 'X', subtotal: 30 }, atUpperBound)).toEqual({
      ok: true,
      fee: 12,
      distanceKm: 8,
      resolvedLabel: null,
      freeShipping: false,
      method: 'distance_range',
      distanceEstimated: false,
    })
  })

  it('fails with no_matching_distance_range beyond the configured ranges', async () => {
    const provider = fakeProvider({ calculateDistance: vi.fn(async () => 20) })
    const result = await calculateDeliveryFee(config, { address: 'Rua X, 100', subtotal: 30 }, provider)
    expect(result).toEqual({ ok: false, reason: 'no_matching_distance_range' })
  })
})

describe('calculateDeliveryFee — per_km', () => {
  const config: DeliveryFeeConfig = {
    ...BASE_CONFIG,
    method: 'per_km',
    settings: { base_price: 4, price_per_km: 1.5 },
  }

  it('charges distance * price_per_km, rounded to cents, once that exceeds the minimum — regression, 2026-08-08', async () => {
    // base_price is a floor, not an addend (confirmed with the account
    // owner): the original `base + distance * price_per_km` formula
    // overcharged every single order regardless of distance. 3.333km
    // at R$1.5/km = R$5.00, already above the R$4 minimum — the
    // minimum must NOT also be added on top of that.
    const provider = fakeProvider({ calculateDistance: vi.fn(async () => 3.333) })
    const result = await calculateDeliveryFee(config, { address: 'Rua X, 100', subtotal: 30 }, provider)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.fee).toBeCloseTo(3.333 * 1.5, 2)
      expect(result.distanceKm).toBe(3.333)
    }
  })

  it('charges the minimum floor instead when distance * price_per_km would come in under it', async () => {
    // A short trip (e.g. ≤1km) — distance * price_per_km (0.5 * 1.5 =
    // 0.75) is below the R$4 minimum, so the minimum wins.
    const provider = fakeProvider({ calculateDistance: vi.fn(async () => 0.5) })
    const result = await calculateDeliveryFee(config, { address: 'Rua X, 100', subtotal: 30 }, provider)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.fee).toBe(4)
  })
})

describe('calculateDeliveryFee — origin-city enrichment', () => {
  // Confirmed live (2026-08-07): a customer typed a real, in-range
  // street with no city ("Av Carlos Gomes 2166, Parque São Paulo") and
  // it kept failing to geocode — nobody names their own city when
  // giving a local address. The account's registered origin city/state
  // now gets appended automatically when the customer's text doesn't
  // already have one.
  const config: DeliveryFeeConfig = { ...BASE_CONFIG, method: 'per_km', originCity: 'Cascavel', originState: 'PR' }

  it('appends the account\'s registered city + state when the address has neither', async () => {
    const provider = fakeProvider()
    await calculateDeliveryFee(config, { address: 'Av Carlos Gomes 2166, Parque São Paulo', subtotal: 30 }, provider)
    expect(provider.geocode).toHaveBeenCalledWith(
      'Av Carlos Gomes 2166, Parque São Paulo, Cascavel, PR',
      expect.anything(),
    )
  })

  it('does not duplicate the city when the customer already named it — accent/case-insensitive', async () => {
    const provider = fakeProvider()
    await calculateDeliveryFee(config, { address: 'Av Carlos Gomes 2166, cascável', subtotal: 30 }, provider)
    expect(provider.geocode).toHaveBeenCalledWith('Av Carlos Gomes 2166, cascável', expect.anything())
  })

  it('is a no-op when the account has no registered city', async () => {
    const noCityConfig: DeliveryFeeConfig = { ...BASE_CONFIG, method: 'per_km', originCity: null, originState: null }
    const provider = fakeProvider()
    await calculateDeliveryFee(noCityConfig, { address: 'Av Carlos Gomes 2166', subtotal: 30 }, provider)
    expect(provider.geocode).toHaveBeenCalledWith('Av Carlos Gomes 2166', expect.anything())
  })

  it('appends just the city when no state is registered', async () => {
    const cityOnlyConfig: DeliveryFeeConfig = { ...BASE_CONFIG, method: 'per_km', originCity: 'Cascavel', originState: null }
    const provider = fakeProvider()
    await calculateDeliveryFee(cityOnlyConfig, { address: 'Av Carlos Gomes 2166', subtotal: 30 }, provider)
    expect(provider.geocode).toHaveBeenCalledWith('Av Carlos Gomes 2166, Cascavel', expect.anything())
  })
})

describe('calculateDeliveryFee — location (WhatsApp share)', () => {
  it('computes distance straight from coordinates, never calling geocode at all', async () => {
    const config: DeliveryFeeConfig = { ...BASE_CONFIG, method: 'per_km', settings: { base_price: 4, price_per_km: 1.5 } }
    const provider = fakeProvider({ calculateDistance: vi.fn(async () => 3) })
    const result = await calculateDeliveryFee(
      config,
      { location: { lat: -24.95, lng: -53.47 }, subtotal: 30 },
      provider,
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.fee).toBeCloseTo(3 * 1.5, 2) // above the R$4 minimum
    expect(provider.geocode).not.toHaveBeenCalled()
    expect(provider.calculateDistance).toHaveBeenCalledWith(
      { lat: BASE_CONFIG.originLat, lng: BASE_CONFIG.originLng },
      { lat: -24.95, lng: -53.47 },
    )
  })

  it('reverse-geocodes to resolve the neighbourhood method and surfaces the label for confirmation', async () => {
    const config: DeliveryFeeConfig = {
      ...BASE_CONFIG,
      method: 'neighborhood',
      settings: { neighborhoods: [{ id: '1', name: 'Centro', price: 3 }] },
    }
    const provider = fakeProvider({
      reverseGeocode: vi.fn(async () => ({
        lat: -24.95,
        lng: -53.47,
        neighborhood: 'Centro',
        label: 'Rua Presidente Kennedy 183, Centro, Pato Branco - PR',
        layer: 'address',
      })),
    })
    const result = await calculateDeliveryFee(
      config,
      { location: { lat: -24.95, lng: -53.47 }, subtotal: 30 },
      provider,
    )
    expect(result).toEqual({
      ok: true,
      fee: 3,
      distanceKm: null,
      resolvedLabel: 'Rua Presidente Kennedy 183, Centro, Pato Branco - PR',
      freeShipping: false,
      method: 'neighborhood',
      distanceEstimated: false,
    })
  })

  it('still computes the fee off raw coordinates when reverse geocode fails — distance never depended on it', async () => {
    const config: DeliveryFeeConfig = { ...BASE_CONFIG, method: 'per_km', settings: { base_price: 4, price_per_km: 1.5 } }
    const provider = fakeProvider({
      reverseGeocode: vi.fn(async () => {
        throw new DistanceProviderError('reverse geocode down')
      }),
      calculateDistance: vi.fn(async () => 10), // well above the R$4 minimum
    })
    const result = await calculateDeliveryFee(
      config,
      { location: { lat: -24.95, lng: -53.47 }, subtotal: 30 },
      provider,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.fee).toBeCloseTo(10 * 1.5, 2)
      expect(result.resolvedLabel).toBeNull()
    }
  })

  it('skips reverse geocode entirely for a fixed fee with no max_distance — nothing to resolve', async () => {
    const config: DeliveryFeeConfig = { ...BASE_CONFIG, method: 'fixed', settings: { fixed_price: 8 } }
    const provider = fakeProvider()
    const result = await calculateDeliveryFee(
      config,
      { location: { lat: -24.95, lng: -53.47 }, subtotal: 30 },
      provider,
    )
    expect(result.ok).toBe(true)
    expect(provider.reverseGeocode).not.toHaveBeenCalled()
    expect(provider.calculateDistance).not.toHaveBeenCalled()
  })
})

describe('calculateDeliveryFee — global rules', () => {
  it('rejects with out_of_range before ever checking free shipping', async () => {
    const config: DeliveryFeeConfig = {
      ...BASE_CONFIG,
      method: 'per_km',
      maxDistance: 5,
      freeShippingAbove: 0, // subtotal always "qualifies" — must not short-circuit past the range check
      settings: { base_price: 4, price_per_km: 1.5 },
    }
    const provider = fakeProvider({ calculateDistance: vi.fn(async () => 10) })
    const result = await calculateDeliveryFee(config, { address: 'Rua X, 100', subtotal: 30 }, provider)
    expect(result).toEqual({ ok: false, reason: 'out_of_range' })
  })

  it('free shipping takes priority over the method once distance is within range', async () => {
    const config: DeliveryFeeConfig = {
      ...BASE_CONFIG,
      method: 'per_km',
      maxDistance: 20,
      freeShippingAbove: 50,
      settings: { base_price: 4, price_per_km: 1.5 },
    }
    const provider = fakeProvider({ calculateDistance: vi.fn(async () => 10) })
    const result = await calculateDeliveryFee(config, { address: 'Rua X, 100', subtotal: 60 }, provider)
    expect(result).toEqual({
      ok: true,
      fee: 0,
      distanceKm: 10,
      resolvedLabel: null,
      freeShipping: true,
      method: 'per_km',
      distanceEstimated: false,
    })
  })

  it('fixed method with a configured max_distance still requires a real distance check', async () => {
    const config: DeliveryFeeConfig = { ...BASE_CONFIG, method: 'fixed', maxDistance: 5 }
    const tooFar = fakeProvider({ calculateDistance: vi.fn(async () => 6) })
    expect(await calculateDeliveryFee(config, { address: 'Rua X', subtotal: 30 }, tooFar)).toEqual({
      ok: false,
      reason: 'out_of_range',
    })

    const closeEnough = fakeProvider({ calculateDistance: vi.fn(async () => 4) })
    expect(await calculateDeliveryFee(config, { address: 'Rua X', subtotal: 30 }, closeEnough)).toEqual({
      ok: true,
      fee: 8,
      distanceKm: 4,
      resolvedLabel: null,
      freeShipping: false,
      method: 'fixed',
      distanceEstimated: false,
    })
  })

  it('fails with origin_not_configured when distance is needed but no origin is set', async () => {
    const config: DeliveryFeeConfig = { ...BASE_CONFIG, method: 'per_km', originLat: null, originLng: null }
    const provider = fakeProvider()
    const result = await calculateDeliveryFee(config, { address: 'Rua X', subtotal: 30 }, provider)
    expect(result).toEqual({ ok: false, reason: 'origin_not_configured' })
    expect(provider.calculateDistance).not.toHaveBeenCalled()
  })

  it('biases the destination geocode toward the configured origin, with a hard radius fallback when max_distance is not set', async () => {
    const config: DeliveryFeeConfig = { ...BASE_CONFIG, method: 'per_km' }
    const provider = fakeProvider()
    await calculateDeliveryFee(config, { address: 'Rua X', subtotal: 30 }, provider)
    expect(provider.geocode).toHaveBeenCalledWith('Rua X', {
      focus: { lat: -23.5, lng: -46.6 },
      radiusKm: 50,
    })
  })

  it('uses the account\'s own max_distance as the hard geocode radius when configured', async () => {
    const config: DeliveryFeeConfig = { ...BASE_CONFIG, method: 'per_km', maxDistance: 12 }
    const provider = fakeProvider()
    await calculateDeliveryFee(config, { address: 'Rua X', subtotal: 30 }, provider)
    expect(provider.geocode).toHaveBeenCalledWith('Rua X', {
      focus: { lat: -23.5, lng: -46.6 },
      radiusKm: 12,
    })
  })

  it('does not pass a focus bias or radius when no origin is configured', async () => {
    const config: DeliveryFeeConfig = { ...BASE_CONFIG, method: 'neighborhood', originLat: null, originLng: null }
    const provider = fakeProvider()
    await calculateDeliveryFee(config, { address: 'Rua X', subtotal: 30 }, provider)
    expect(provider.geocode).toHaveBeenCalledWith('Rua X', { focus: undefined, radiusKm: undefined })
  })

  it('fails with geocode_failed when the provider cannot resolve the address', async () => {
    const config: DeliveryFeeConfig = { ...BASE_CONFIG, method: 'per_km' }
    const provider = fakeProvider({ geocode: vi.fn(async () => null) })
    const result = await calculateDeliveryFee(config, { address: 'nonsense', subtotal: 30 }, provider)
    expect(result).toEqual({ ok: false, reason: 'geocode_failed' })
  })

  it('fails with geocode_failed when the provider throws a DistanceProviderError, and logs it — regression, 2026-08-07', async () => {
    // Confirmed live: this failure used to be completely silent server-
    // side — a burst of ORS quota/rate-limit errors during heavy
    // testing showed up to real customers as "não consegui localizar
    // esse endereço" (for addresses that geocode fine moments later),
    // with nothing in journalctl to explain why. At least two customers
    // abandoned their order over it before this was ever noticed.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const config: DeliveryFeeConfig = { ...BASE_CONFIG, method: 'per_km' }
    const provider = fakeProvider({
      geocode: vi.fn(async () => {
        throw new DistanceProviderError('boom')
      }),
    })
    const result = await calculateDeliveryFee(config, { address: 'Rua X', subtotal: 30 }, provider)
    expect(result).toEqual({ ok: false, reason: 'geocode_failed' })
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('geocode failed'), 'boom')
    errorSpy.mockRestore()
  })
})

describe('calculateDeliveryFee — geocode retry (strips the house number)', () => {
  const config: DeliveryFeeConfig = { ...BASE_CONFIG, method: 'per_km' }

  it('retries without the house number when the full address has no match at all', async () => {
    const geocode = vi.fn(async (addr: string) =>
      addr === 'Av Carlos Gomes Parque São Paulo Cascavel'
        ? { lat: -24.95, lng: -53.46, neighborhood: null, label: 'Av Carlos Gomes, Cascavel - PR', layer: 'street' }
        : null,
    )
    const provider = fakeProvider({ geocode })
    const result = await calculateDeliveryFee(
      config,
      { address: 'Av Carlos Gomes 2166, Parque São Paulo Cascavel', subtotal: 30 },
      provider,
    )
    expect(geocode).toHaveBeenCalledTimes(2)
    expect(geocode).toHaveBeenNthCalledWith(
      2,
      'Av Carlos Gomes Parque São Paulo Cascavel',
      expect.anything(),
    )
    expect(result.ok).toBe(true)
  })

  it('upgrades a coarse (city-level) match to a precise one from the retry', async () => {
    const geocode = vi.fn(async (addr: string) =>
      addr.includes('2166')
        ? { lat: -24.9, lng: -53.4, neighborhood: null, label: 'Cascavel, PR, Brazil', layer: 'locality' }
        : { lat: -24.95, lng: -53.46, neighborhood: null, label: 'Av Carlos Gomes, Cascavel', layer: 'street' },
    )
    const provider = fakeProvider({ geocode })
    const result = await calculateDeliveryFee(
      config,
      { address: 'Av Carlos Gomes 2166, Cascavel', subtotal: 30 },
      provider,
    )
    expect(geocode).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.resolvedLabel).toBe('Av Carlos Gomes, Cascavel')
  })

  it('keeps the original coarse match when the retry does not improve on it', async () => {
    const geocode = vi.fn(async () => ({
      lat: -24.9,
      lng: -53.4,
      neighborhood: null,
      label: 'Cascavel, PR, Brazil',
      layer: 'locality',
    }))
    const provider = fakeProvider({ geocode })
    const result = await calculateDeliveryFee(
      config,
      { address: 'Rua Sem Nome 42, Cascavel', subtotal: 30 },
      provider,
    )
    expect(geocode).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.resolvedLabel).toBe('Cascavel, PR, Brazil')
  })

  it('does not retry when the address has no house number to strip', async () => {
    const geocode = vi.fn(async () => null)
    const provider = fakeProvider({ geocode })
    await calculateDeliveryFee(config, { address: 'Centro, Cascavel', subtotal: 30 }, provider)
    expect(geocode).toHaveBeenCalledTimes(1)
  })

  it('still fails with geocode_failed when both the original and the retry come up empty', async () => {
    const geocode = vi.fn(async () => null)
    const provider = fakeProvider({ geocode })
    const result = await calculateDeliveryFee(
      config,
      { address: 'Rua Inexistente 999, Cascavel', subtotal: 30 },
      provider,
    )
    expect(geocode).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ ok: false, reason: 'geocode_failed' })
  })
})

describe('calculateDeliveryFee — global rules (cont.)', () => {
  it('falls back to a padded straight-line estimate instead of failing when calculateDistance itself throws — regression, 2026-08-08', async () => {
    // Confirmed live: even with a widened retry schedule (see
    // locationiq.ts's fetchWithRetry), the routing call kept
    // intermittently failing for one particular route several times
    // within the same hour — repeatedly dead-ending a real order even
    // though the address had already geocoded fine. An order should
    // never block on a routing-provider hiccup when a reasonable
    // estimate (see estimateStraightLineDistanceKm) is one
    // multiplication away.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const config: DeliveryFeeConfig = {
      ...BASE_CONFIG,
      method: 'per_km',
      originLat: 0,
      originLng: 0,
      settings: { base_price: 4, price_per_km: 1.5 },
    }
    const provider = fakeProvider({
      geocode: vi.fn(async () => ({ lat: 1, lng: 0, neighborhood: null, label: null, layer: 'address' })),
      calculateDistance: vi.fn(async () => {
        throw new DistanceProviderError('directions boom')
      }),
    })
    const result = await calculateDeliveryFee(config, { address: 'Rua X', subtotal: 30 }, provider)
    expect(result.ok).toBe(true)
    if (result.ok) {
      // ~111.2km great-circle for 1° of latitude, padded 35% — not
      // asserted to the exact decimal, just the right ballpark.
      expect(result.distanceKm).toBeGreaterThan(140)
      expect(result.distanceKm).toBeLessThan(160)
      expect(result.distanceEstimated).toBe(true)
      expect(result.fee).toBeCloseTo(result.distanceKm! * 1.5, 2) // well above the R$4 minimum
    }
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('calculateDistance failed, falling back to straight-line estimate'),
      'directions boom',
      expect.any(String),
    )
    errorSpy.mockRestore()
  })

  it('never estimates when calculateDistance succeeds — distanceEstimated only ever true on the fallback path', async () => {
    const config: DeliveryFeeConfig = { ...BASE_CONFIG, method: 'per_km' }
    const provider = fakeProvider({ calculateDistance: vi.fn(async () => 5) })
    const result = await calculateDeliveryFee(config, { address: 'Rua X', subtotal: 30 }, provider)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.distanceEstimated).toBe(false)
  })
})

describe('getDeliveryFeeConfig', () => {
  function fakeDb(row: unknown) {
    return {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: row, error: null }),
          }),
        }),
      }),
    } as unknown as SupabaseClient
  }

  it('returns a permissive fixed-@-0 default when no row exists', async () => {
    const config = await getDeliveryFeeConfig(fakeDb(null), 'acct-1')
    expect(config).toEqual({
      method: 'fixed',
      maxDistance: null,
      freeShippingAbove: null,
      originLat: null,
      originLng: null,
      originCity: null,
      originState: null,
      settings: { fixed_price: 0 },
    })
  })

  it('maps a configured row through', async () => {
    const config = await getDeliveryFeeConfig(
      fakeDb({
        delivery_method: 'per_km',
        max_distance: 10,
        free_shipping_above: 100,
        origin_lat: -23.5,
        origin_lng: -46.6,
        origin_city: 'Cascavel',
        origin_state: 'PR',
        settings: { base_price: 4, price_per_km: 1.5 },
      }),
      'acct-1',
    )
    expect(config).toEqual({
      method: 'per_km',
      maxDistance: 10,
      freeShippingAbove: 100,
      originLat: -23.5,
      originLng: -46.6,
      originCity: 'Cascavel',
      originState: 'PR',
      settings: { base_price: 4, price_per_km: 1.5 },
    })
  })
})
