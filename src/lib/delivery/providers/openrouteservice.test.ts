import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenRouteServiceProvider } from './openrouteservice'
import { DistanceProviderError } from '../distance-provider'

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('OpenRouteServiceProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const originalKey = process.env.ORS_API_KEY

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    process.env.ORS_API_KEY = 'test-key'
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    process.env.ORS_API_KEY = originalKey
  })

  describe('geocode', () => {
    it('resolves an address to coordinates + neighbourhood + label', async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse({
          features: [
            {
              geometry: { coordinates: [-46.6, -23.5] },
              properties: { neighbourhood: 'Centro', label: 'Rua X, 123, São Paulo, SP, Brazil' },
            },
          ],
        }),
      )

      const provider = new OpenRouteServiceProvider()
      const result = await provider.geocode('Rua X, 123')

      expect(result).toEqual({
        lat: -23.5,
        lng: -46.6,
        neighborhood: 'Centro',
        label: 'Rua X, 123, São Paulo, SP, Brazil',
        layer: null,
      })
      const [url] = fetchMock.mock.calls[0]
      const parsed = new URL(String(url))
      expect(parsed.origin + parsed.pathname).toBe('https://api.openrouteservice.org/geocode/search')
      expect(parsed.searchParams.get('api_key')).toBe('test-key')
      expect(parsed.searchParams.get('text')).toBe('Rua X, 123')
      expect(parsed.searchParams.get('boundary.country')).toBe('BR')
    })

    it('surfaces the Pelias match-precision layer, null when absent', async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse({
          features: [{ geometry: { coordinates: [-53.6, -25.0] }, properties: { layer: 'locality' } }],
        }),
      )
      const provider = new OpenRouteServiceProvider()
      const result = await provider.geocode('Cascavel, PR')
      expect(result?.layer).toBe('locality')

      fetchMock.mockResolvedValueOnce(
        okResponse({ features: [{ geometry: { coordinates: [-53.6, -25.0] }, properties: {} }] }),
      )
      const noLayer = await new OpenRouteServiceProvider().geocode('Cascavel, PR')
      expect(noLayer?.layer).toBeNull()
    })

    it('falls back to borough when neighbourhood is absent', async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse({
          features: [{ geometry: { coordinates: [-46.6, -23.5] }, properties: { borough: 'Zona Sul' } }],
        }),
      )
      const provider = new OpenRouteServiceProvider()
      const result = await provider.geocode('Rua X, 123')
      expect(result?.neighborhood).toBe('Zona Sul')
    })

    it('applies a focus.point bias when given, to disambiguate same-named places', async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse({ features: [{ geometry: { coordinates: [-53.6, -25.0] }, properties: {} }] }),
      )
      const provider = new OpenRouteServiceProvider()
      await provider.geocode('Centro', { focus: { lat: -25.05, lng: -53.61 } })

      const [url] = fetchMock.mock.calls[0]
      const parsed = new URL(String(url))
      expect(parsed.searchParams.get('focus.point.lat')).toBe('-25.05')
      expect(parsed.searchParams.get('focus.point.lon')).toBe('-53.61')
    })

    it('omits focus.point when no bias is given', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({ features: [] }))
      const provider = new OpenRouteServiceProvider()
      await provider.geocode('Centro')
      const [url] = fetchMock.mock.calls[0]
      const parsed = new URL(String(url))
      expect(parsed.searchParams.has('focus.point.lat')).toBe(false)
    })

    it('applies a hard boundary.circle radius when given, on top of the focus bias', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({ features: [] }))
      const provider = new OpenRouteServiceProvider()
      await provider.geocode('Centro', { focus: { lat: -25.05, lng: -53.61 }, radiusKm: 12 })

      const [url] = fetchMock.mock.calls[0]
      const parsed = new URL(String(url))
      expect(parsed.searchParams.get('boundary.circle.lat')).toBe('-25.05')
      expect(parsed.searchParams.get('boundary.circle.lon')).toBe('-53.61')
      expect(parsed.searchParams.get('boundary.circle.radius')).toBe('12')
    })

    it('omits boundary.circle when a radius is given but no focus (a radius needs a center)', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({ features: [] }))
      const provider = new OpenRouteServiceProvider()
      await provider.geocode('Centro', { radiusKm: 12 })
      const [url] = fetchMock.mock.calls[0]
      const parsed = new URL(String(url))
      expect(parsed.searchParams.has('boundary.circle.radius')).toBe(false)
    })

    it('returns null when the address has no matching feature', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({ features: [] }))
      const provider = new OpenRouteServiceProvider()
      expect(await provider.geocode('nonsense address')).toBeNull()
    })

    it('returns null for an empty/blank address without calling fetch', async () => {
      const provider = new OpenRouteServiceProvider()
      expect(await provider.geocode('   ')).toBeNull()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('throws DistanceProviderError on a non-2xx response', async () => {
      fetchMock.mockResolvedValueOnce(new Response('', { status: 500 }))
      const provider = new OpenRouteServiceProvider()
      await expect(provider.geocode('Rua X, 123')).rejects.toThrow(DistanceProviderError)
    })

    it('throws DistanceProviderError when ORS_API_KEY is not configured', async () => {
      delete process.env.ORS_API_KEY
      const provider = new OpenRouteServiceProvider()
      await expect(provider.geocode('Rua X, 123')).rejects.toThrow(DistanceProviderError)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe('geocodeStructured', () => {
    it('sends each field as a separate structured param, hitting the structured endpoint', async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse({
          features: [
            {
              geometry: { coordinates: [-53.613413, -25.049452] },
              properties: { label: 'Santa Tereza do Oeste, PR, Brazil', neighbourhood: 'Malucelli' },
            },
          ],
        }),
      )

      const provider = new OpenRouteServiceProvider()
      const result = await provider.geocodeStructured({
        address: 'Rua Gonsalves Dias, 105',
        neighbourhood: 'Malucelli',
        locality: 'Santa Tereza do Oeste',
        region: 'Parana',
        postalCode: '85957-000',
      })

      expect(result).toEqual({
        lat: -25.049452,
        lng: -53.613413,
        neighborhood: 'Malucelli',
        label: 'Santa Tereza do Oeste, PR, Brazil',
        layer: null,
      })

      const [url] = fetchMock.mock.calls[0]
      const parsed = new URL(String(url))
      expect(parsed.origin + parsed.pathname).toBe('https://api.openrouteservice.org/geocode/search/structured')
      expect(parsed.searchParams.get('address')).toBe('Rua Gonsalves Dias, 105')
      expect(parsed.searchParams.get('neighbourhood')).toBe('Malucelli')
      expect(parsed.searchParams.get('locality')).toBe('Santa Tereza do Oeste')
      expect(parsed.searchParams.get('region')).toBe('Parana')
      expect(parsed.searchParams.get('postalcode')).toBe('85957-000')
      expect(parsed.searchParams.get('country')).toBe('Brazil')
    })

    it('omits blank optional fields rather than sending empty params', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({ features: [] }))
      const provider = new OpenRouteServiceProvider()
      await provider.geocodeStructured({ locality: 'Santa Tereza do Oeste' })

      const [url] = fetchMock.mock.calls[0]
      const parsed = new URL(String(url))
      expect(parsed.searchParams.has('address')).toBe(false)
      expect(parsed.searchParams.has('neighbourhood')).toBe(false)
      expect(parsed.searchParams.has('region')).toBe(false)
      expect(parsed.searchParams.has('postalcode')).toBe(false)
    })

    it('returns null without calling fetch when locality is blank', async () => {
      const provider = new OpenRouteServiceProvider()
      expect(await provider.geocodeStructured({ locality: '  ' })).toBeNull()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('throws DistanceProviderError on a non-2xx response', async () => {
      fetchMock.mockResolvedValueOnce(new Response('', { status: 500 }))
      const provider = new OpenRouteServiceProvider()
      await expect(
        provider.geocodeStructured({ locality: 'Santa Tereza do Oeste' }),
      ).rejects.toThrow(DistanceProviderError)
    })
  })

  describe('calculateDistance', () => {
    it('posts both coordinates to the directions endpoint and converts meters to km', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({ routes: [{ summary: { distance: 4200, duration: 600 } }] }))

      const provider = new OpenRouteServiceProvider()
      const km = await provider.calculateDistance({ lat: -23.5, lng: -46.6 }, { lat: -23.6, lng: -46.7 })

      expect(km).toBe(4.2)
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('https://api.openrouteservice.org/v2/directions/driving-car')
      expect(init.headers.Authorization).toBe('test-key')
      const body = JSON.parse(init.body)
      expect(body.coordinates).toEqual([
        [-46.6, -23.5],
        [-46.7, -23.6],
      ])
      expect(body.units).toBe('m')
    })

    it('throws DistanceProviderError on a non-2xx response', async () => {
      fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }))
      const provider = new OpenRouteServiceProvider()
      await expect(
        provider.calculateDistance({ lat: 0, lng: 0 }, { lat: 1, lng: 1 }),
      ).rejects.toThrow(DistanceProviderError)
    })

    it('throws DistanceProviderError when the response has no distance value', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({ routes: [{ summary: {} }] }))
      const provider = new OpenRouteServiceProvider()
      await expect(
        provider.calculateDistance({ lat: 0, lng: 0 }, { lat: 1, lng: 1 }),
      ).rejects.toThrow(DistanceProviderError)
    })

    it('throws DistanceProviderError when routes is empty', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({ routes: [] }))
      const provider = new OpenRouteServiceProvider()
      await expect(
        provider.calculateDistance({ lat: 0, lng: 0 }, { lat: 1, lng: 1 }),
      ).rejects.toThrow(DistanceProviderError)
    })
  })
})
