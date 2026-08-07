import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocationIqProvider } from './locationiq'
import { DistanceProviderError } from '../distance-provider'

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('LocationIqProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const originalKey = process.env.LOCATIONIQ_API_KEY

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    process.env.LOCATIONIQ_API_KEY = 'test-key'
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    process.env.LOCATIONIQ_API_KEY = originalKey
  })

  describe('geocode', () => {
    it('resolves an address to coordinates + neighbourhood + label', async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse([
          {
            lat: '-24.9527731',
            lon: '-53.4887912',
            display_name: 'Rua Paraná, Coqueiral, Cascavel, Paraná, Brazil',
            address: { suburb: 'Coqueiral' },
          },
        ]),
      )

      const provider = new LocationIqProvider()
      const result = await provider.geocode('Rua Paraná 6537, Coqueiral, Cascavel')

      expect(result).toEqual({
        lat: -24.9527731,
        lng: -53.4887912,
        neighborhood: 'Coqueiral',
        label: 'Rua Paraná, Coqueiral, Cascavel, Paraná, Brazil',
        layer: null,
      })
      const [url] = fetchMock.mock.calls[0]
      const parsed = new URL(String(url))
      expect(parsed.origin + parsed.pathname).toBe('https://us1.locationiq.com/v1/search')
      expect(parsed.searchParams.get('key')).toBe('test-key')
      expect(parsed.searchParams.get('q')).toBe('Rua Paraná 6537, Coqueiral, Cascavel')
      expect(parsed.searchParams.get('countrycodes')).toBe('br')
    })

    it('falls back to neighbourhood, then city_district, when suburb is absent', async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse([{ lat: '0', lon: '0', address: { neighbourhood: 'Zona Sul' } }]),
      )
      const provider = new LocationIqProvider()
      expect((await provider.geocode('X'))?.neighborhood).toBe('Zona Sul')

      fetchMock.mockResolvedValueOnce(
        okResponse([{ lat: '0', lon: '0', address: { city_district: 'Centro' } }]),
      )
      expect((await new LocationIqProvider().geocode('X'))?.neighborhood).toBe('Centro')
    })

    it('applies a hard bounding box built from focus + radiusKm — never just a ranking nudge', async () => {
      // Confirmed live (2026-08-07): without a HARD box (not just a
      // bias), a same-named place hundreds of km away can still win —
      // exactly the failure mode this mirrors from ORS's boundary.circle.
      fetchMock.mockResolvedValueOnce(okResponse([]))
      const provider = new LocationIqProvider()
      await provider.geocode('Centro', { focus: { lat: -24.95, lng: -53.48 }, radiusKm: 50 })

      const [url] = fetchMock.mock.calls[0]
      const parsed = new URL(String(url))
      expect(parsed.searchParams.get('bounded')).toBe('1')
      expect(parsed.searchParams.has('viewbox')).toBe(true)
      const [left, top, right, bottom] = parsed.searchParams.get('viewbox')!.split(',').map(Number)
      // left < right (lng), bottom < top (lat) — a real box around the focus point.
      expect(left).toBeLessThan(right)
      expect(bottom).toBeLessThan(top)
    })

    it('omits the bounding box when no focus is given', async () => {
      fetchMock.mockResolvedValueOnce(okResponse([]))
      const provider = new LocationIqProvider()
      await provider.geocode('Centro')
      const [url] = fetchMock.mock.calls[0]
      const parsed = new URL(String(url))
      expect(parsed.searchParams.has('viewbox')).toBe(false)
      expect(parsed.searchParams.has('bounded')).toBe(false)
    })

    it('returns null on a 404 (LocationIQ\'s "no match" response) rather than throwing', async () => {
      fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }))
      const provider = new LocationIqProvider()
      expect(await provider.geocode('nonsense address')).toBeNull()
    })

    it('returns null for an empty/blank address without calling fetch', async () => {
      const provider = new LocationIqProvider()
      expect(await provider.geocode('   ')).toBeNull()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('throws DistanceProviderError on a non-2xx, non-404 response', async () => {
      fetchMock.mockResolvedValueOnce(new Response('', { status: 500 }))
      const provider = new LocationIqProvider()
      await expect(provider.geocode('Rua X, 123')).rejects.toThrow(DistanceProviderError)
    })

    it('throws DistanceProviderError when LOCATIONIQ_API_KEY is not configured', async () => {
      delete process.env.LOCATIONIQ_API_KEY
      const provider = new LocationIqProvider()
      await expect(provider.geocode('Rua X, 123')).rejects.toThrow(DistanceProviderError)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe('geocodeStructured', () => {
    it('sends each field as a separate structured param', async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse([{ lat: '-25.049452', lon: '-53.613413', display_name: 'Santa Tereza do Oeste, PR, Brazil' }]),
      )
      const provider = new LocationIqProvider()
      await provider.geocodeStructured({
        address: 'Rua Gonsalves Dias, 105',
        locality: 'Santa Tereza do Oeste',
        region: 'Parana',
        postalCode: '85957-000',
      })

      const [url] = fetchMock.mock.calls[0]
      const parsed = new URL(String(url))
      expect(parsed.searchParams.get('street')).toBe('Rua Gonsalves Dias, 105')
      expect(parsed.searchParams.get('city')).toBe('Santa Tereza do Oeste')
      expect(parsed.searchParams.get('state')).toBe('Parana')
      expect(parsed.searchParams.get('postalcode')).toBe('85957-000')
      expect(parsed.searchParams.get('country')).toBe('Brazil')
    })

    it('returns null without calling fetch when locality is blank', async () => {
      const provider = new LocationIqProvider()
      expect(await provider.geocodeStructured({ locality: '  ' })).toBeNull()
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe('reverseGeocode', () => {
    it('resolves coordinates to a label + neighbourhood', async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse({
          lat: '-24.9527731',
          lon: '-53.4887912',
          display_name: 'Rua Paraná, Coqueiral, Cascavel, Paraná, Brazil',
          address: { suburb: 'Coqueiral' },
        }),
      )
      const provider = new LocationIqProvider()
      const result = await provider.reverseGeocode({ lat: -24.9527731, lng: -53.4887912 })
      expect(result).toEqual({
        lat: -24.9527731,
        lng: -53.4887912,
        neighborhood: 'Coqueiral',
        label: 'Rua Paraná, Coqueiral, Cascavel, Paraná, Brazil',
        layer: null,
      })
      const [url] = fetchMock.mock.calls[0]
      const parsed = new URL(String(url))
      expect(parsed.origin + parsed.pathname).toBe('https://us1.locationiq.com/v1/reverse')
      expect(parsed.searchParams.get('lat')).toBe('-24.9527731')
      expect(parsed.searchParams.get('lon')).toBe('-53.4887912')
    })

    it('returns null when nothing is found nearby', async () => {
      fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }))
      const provider = new LocationIqProvider()
      expect(await provider.reverseGeocode({ lat: 0, lng: 0 })).toBeNull()
    })

    it('throws DistanceProviderError on a non-2xx, non-404 response', async () => {
      fetchMock.mockResolvedValueOnce(new Response('', { status: 500 }))
      const provider = new LocationIqProvider()
      await expect(provider.reverseGeocode({ lat: 0, lng: 0 })).rejects.toThrow(DistanceProviderError)
    })
  })

  describe('calculateDistance', () => {
    it('hits the directions endpoint with lon,lat pairs and converts meters to km', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({ routes: [{ distance: 1532.8, duration: 126.8 }] }))
      const provider = new LocationIqProvider()
      const km = await provider.calculateDistance({ lat: -24.949824, lng: -53.479192 }, { lat: -24.952773, lng: -53.488791 })
      expect(km).toBeCloseTo(1.5328, 4)

      const [url] = fetchMock.mock.calls[0]
      expect(String(url)).toContain('/directions/driving/-53.479192,-24.949824;-53.488791,-24.952773')
    })

    it('throws DistanceProviderError on a non-2xx response', async () => {
      fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }))
      const provider = new LocationIqProvider()
      await expect(
        provider.calculateDistance({ lat: 0, lng: 0 }, { lat: 1, lng: 1 }),
      ).rejects.toThrow(DistanceProviderError)
    })

    it('throws DistanceProviderError when the response has no distance value', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({ routes: [{}] }))
      const provider = new LocationIqProvider()
      await expect(
        provider.calculateDistance({ lat: 0, lng: 0 }, { lat: 1, lng: 1 }),
      ).rejects.toThrow(DistanceProviderError)
    })

    it('throws DistanceProviderError when routes is empty', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({ routes: [] }))
      const provider = new LocationIqProvider()
      await expect(
        provider.calculateDistance({ lat: 0, lng: 0 }, { lat: 1, lng: 1 }),
      ).rejects.toThrow(DistanceProviderError)
    })
  })
})
