import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CartLineItem } from '@/lib/delivery/create-order'

const mocks = vi.hoisted(() => ({ supabaseAdmin: vi.fn() }))
vi.mock('@/lib/delivery/admin-client', () => ({ supabaseAdmin: mocks.supabaseAdmin }))

import { GET } from './route'

const SECRET = 'test-cron-secret'

function req(headers: Record<string, string> = { 'x-cron-secret': SECRET }) {
  return new Request('http://localhost/api/delivery/cron', { headers })
}

type ConvRow = { id: string; account_id: string; ai_cart: CartLineItem[] }

function makeDb(rows: ConvRow[]) {
  const updates: { id: string; ai_cart: unknown }[] = []
  const db = {
    from: (table: string) => {
      if (table !== 'conversations') throw new Error(`unexpected table: ${table}`)
      const chain = {
        select: () => chain,
        // Only rows with a non-empty cart survive the real query's
        // `.neq('ai_cart', '[]')` — mirrored here in the fake so a bug
        // that forgot the filter wouldn't be caught by a fake that
        // just returns everything regardless.
        neq: (_col: string, _val: string) =>
          Promise.resolve({ data: rows.filter((r) => r.ai_cart.length > 0), error: null }),
        update: (payload: { ai_cart: unknown }) => ({
          eq: (_col: string, id: string) => {
            updates.push({ id, ai_cart: payload.ai_cart })
            const row = rows.find((r) => r.id === id)
            if (row) row.ai_cart = payload.ai_cart as CartLineItem[]
            return Promise.resolve({ error: null })
          },
        }),
      }
      return chain
    },
  } as unknown as SupabaseClient
  return { db, updates }
}

function staleLine(overrides: Partial<CartLineItem> = {}): CartLineItem {
  return {
    product_id: 'p1',
    product_name: 'Marmita M',
    unit_price: 25,
    quantity: 1,
    addons: [],
    addedAt: '2026-08-21T14:08:57.000Z', // days before "now" in every test below
    ...overrides,
  }
}

function freshLine(overrides: Partial<CartLineItem> = {}): CartLineItem {
  return {
    product_id: 'p2',
    product_name: 'Marmita P',
    unit_price: 20,
    quantity: 1,
    addons: [],
    addedAt: new Date().toISOString(),
    ...overrides,
  }
}

beforeEach(() => {
  process.env.AUTOMATION_CRON_SECRET = SECRET
  mocks.supabaseAdmin.mockReset()
})

describe('GET /api/delivery/cron', () => {
  it('rejects a missing/wrong secret', async () => {
    const res = await GET(req({ 'x-cron-secret': 'wrong' }))
    expect(res.status).toBe(401)
  })

  it('503s when the secret is not configured', async () => {
    delete process.env.AUTOMATION_CRON_SECRET
    const res = await GET(req())
    expect(res.status).toBe(503)
  })

  it('clears an abandoned cart (every line stale) and reports it swept', async () => {
    const { db, updates } = makeDb([
      { id: 'conv-1', account_id: 'acct-1', ai_cart: [staleLine(), staleLine({ product_id: 'p3' })] },
    ])
    mocks.supabaseAdmin.mockReturnValue(db)

    const res = await GET(req())
    const data = await res.json()

    expect(data).toEqual({ swept: 1 })
    expect(updates).toEqual([{ id: 'conv-1', ai_cart: [] }])
  })

  it('leaves a cart with any recent activity completely alone — an order actively in progress is never swept', async () => {
    const { db, updates } = makeDb([
      { id: 'conv-1', account_id: 'acct-1', ai_cart: [staleLine(), freshLine()] },
    ])
    mocks.supabaseAdmin.mockReturnValue(db)

    const res = await GET(req())
    const data = await res.json()

    expect(data).toEqual({ swept: 0 })
    expect(updates).toHaveLength(0)
  })

  it('reports 0 swept with no non-empty carts to scan', async () => {
    const { db } = makeDb([])
    mocks.supabaseAdmin.mockReturnValue(db)

    const res = await GET(req())
    expect(await res.json()).toEqual({ swept: 0 })
  })

  it('sweeps across multiple accounts in one pass', async () => {
    const { db, updates } = makeDb([
      { id: 'conv-1', account_id: 'acct-1', ai_cart: [staleLine()] },
      { id: 'conv-2', account_id: 'acct-2', ai_cart: [staleLine()] },
    ])
    mocks.supabaseAdmin.mockReturnValue(db)

    const res = await GET(req())
    expect(await res.json()).toEqual({ swept: 2 })
    expect(updates.map((u) => u.id).sort()).toEqual(['conv-1', 'conv-2'])
  })
})
