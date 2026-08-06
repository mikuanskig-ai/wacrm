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
    })

    const atUpperBound = fakeProvider({ calculateDistance: vi.fn(async () => 8) })
    expect(await calculateDeliveryFee(config, { address: 'X', subtotal: 30 }, atUpperBound)).toEqual({
      ok: true,
      fee: 12,
      distanceKm: 8,
      resolvedLabel: null,
      freeShipping: false,
      method: 'distance_range',
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

  it('computes base_price + distance * price_per_km, rounded to cents', async () => {
    const provider = fakeProvider({ calculateDistance: vi.fn(async () => 3.333) })
    const result = await calculateDeliveryFee(config, { address: 'Rua X, 100', subtotal: 30 }, provider)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.fee).toBeCloseTo(4 + 3.333 * 1.5, 2)
      expect(result.distanceKm).toBe(3.333)
    }
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

  it('fails with geocode_failed when the provider throws a DistanceProviderError', async () => {
    const config: DeliveryFeeConfig = { ...BASE_CONFIG, method: 'per_km' }
    const provider = fakeProvider({
      geocode: vi.fn(async () => {
        throw new DistanceProviderError('boom')
      }),
    })
    const result = await calculateDeliveryFee(config, { address: 'Rua X', subtotal: 30 }, provider)
    expect(result).toEqual({ ok: false, reason: 'geocode_failed' })
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
      settings: { base_price: 4, price_per_km: 1.5 },
    })
  })
})
