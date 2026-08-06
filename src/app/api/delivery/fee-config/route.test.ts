import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { GeocodeResult } from '@/lib/delivery/distance-provider'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getCurrentAccount: vi.fn(),
  geocodeStructured: vi.fn(),
  geocode: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  getCurrentAccount: mocks.getCurrentAccount,
  toErrorResponse: vi.fn(() => Response.json({ error: 'auth failed' }, { status: 403 })),
}))

vi.mock('@/lib/delivery/providers/openrouteservice', () => ({
  getDistanceProvider: () => ({
    geocodeStructured: mocks.geocodeStructured,
    geocode: mocks.geocode,
    calculateDistance: vi.fn(),
  }),
}))

import { POST } from './route'

function makeDb(existing: Record<string, unknown> | null = null) {
  let updatePayload: Record<string, unknown> | null = null
  let insertPayload: Record<string, unknown> | null = null

  const db = {
    from: (table: string) => {
      if (table !== 'delivery_fee_configs') throw new Error(`unexpected table: ${table}`)
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: existing, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          updatePayload = payload
          return { eq: () => Promise.resolve({ error: null }) }
        },
        insert: (payload: Record<string, unknown>) => {
          insertPayload = payload
          return Promise.resolve({ error: null })
        },
      }
    },
  } as unknown as SupabaseClient

  return { db, getUpdatePayload: () => updatePayload, getInsertPayload: () => insertPayload }
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    delivery_method: 'per_km',
    settings: { base_price: 4, price_per_km: 1.5 },
    origin_street: 'Rua Presidente Kennedy 2237',
    origin_neighbourhood: 'Centro',
    origin_city: 'Cascavel',
    origin_state: 'PR',
    origin_postal_code: '85810-041',
    ...overrides,
  }
}

function request(payload: unknown) {
  return new Request('http://localhost/api/delivery/fee-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

const coarse: GeocodeResult = { lat: -24.95, lng: -53.46, neighborhood: null, label: 'Cascavel, PR, Brazil', layer: 'locality' }
const precise: GeocodeResult = {
  lat: -24.9488,
  lng: -53.4752,
  neighborhood: 'Centro',
  label: 'Rua Presidente Kennedy 2237, Cascavel, PR, Brazil',
  layer: 'address',
}

beforeEach(() => {
  mocks.requireRole.mockReset()
  mocks.geocodeStructured.mockReset()
  mocks.geocode.mockReset()
})

describe('POST /api/delivery/fee-config — origin geocode precision', () => {
  it('retries with free-text search and uses it when the structured match is only city-level', async () => {
    const { db, getInsertPayload } = makeDb(null)
    mocks.requireRole.mockResolvedValue({ supabase: db, accountId: 'acct-1', userId: 'user-1' })
    mocks.geocodeStructured.mockResolvedValue(coarse)
    mocks.geocode.mockResolvedValue(precise)

    const res = await POST(request(body()))
    const data = await res.json()

    expect(mocks.geocode).toHaveBeenCalledWith('Rua Presidente Kennedy 2237, Centro, Cascavel - PR, 85810-041')
    expect(data.geocodeWarning).toBeNull()
    expect(data.resolvedLabel).toBe(precise.label)
    expect(getInsertPayload()).toMatchObject({ origin_lat: precise.lat, origin_lng: precise.lng })
  })

  it('does not retry when the structured match is already precise', async () => {
    const { db } = makeDb(null)
    mocks.requireRole.mockResolvedValue({ supabase: db, accountId: 'acct-1', userId: 'user-1' })
    mocks.geocodeStructured.mockResolvedValue(precise)

    await POST(request(body()))

    expect(mocks.geocode).not.toHaveBeenCalled()
  })

  it('warns and keeps the coarse result when the retry is also coarse', async () => {
    const { db, getInsertPayload } = makeDb(null)
    mocks.requireRole.mockResolvedValue({ supabase: db, accountId: 'acct-1', userId: 'user-1' })
    mocks.geocodeStructured.mockResolvedValue(coarse)
    mocks.geocode.mockResolvedValue({ ...coarse, label: 'Parana, Brazil', layer: 'region' })

    const res = await POST(request(body()))
    const data = await res.json()

    expect(data.geocodeWarning).toMatch(/city\/region level/)
    expect(getInsertPayload()).toMatchObject({ origin_lat: coarse.lat, origin_lng: coarse.lng })
  })

  it('warns and keeps the coarse result when the retry throws instead of failing the save', async () => {
    const { db, getUpdatePayload, getInsertPayload } = makeDb(null)
    mocks.requireRole.mockResolvedValue({ supabase: db, accountId: 'acct-1', userId: 'user-1' })
    mocks.geocodeStructured.mockResolvedValue(coarse)
    mocks.geocode.mockRejectedValue(new Error('network blip'))

    const res = await POST(request(body()))
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.geocodeWarning).toMatch(/city\/region level/)
    const saved = getUpdatePayload() ?? getInsertPayload()
    expect(saved).toMatchObject({ origin_lat: coarse.lat, origin_lng: coarse.lng })
  })

  it('does not re-geocode when the origin address fields are unchanged', async () => {
    const { db } = makeDb({
      origin_street: 'Rua Presidente Kennedy 2237',
      origin_neighbourhood: 'Centro',
      origin_city: 'Cascavel',
      origin_state: 'PR',
      origin_postal_code: '85810-041',
      origin_lat: precise.lat,
      origin_lng: precise.lng,
      origin_resolved_label: precise.label,
    })
    mocks.requireRole.mockResolvedValue({ supabase: db, accountId: 'acct-1', userId: 'user-1' })

    const res = await POST(request(body()))
    const data = await res.json()

    expect(mocks.geocodeStructured).not.toHaveBeenCalled()
    expect(data.resolvedLabel).toBe(precise.label)
  })
})
