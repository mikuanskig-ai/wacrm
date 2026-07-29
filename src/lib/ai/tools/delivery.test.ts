import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CartLineItem } from '@/lib/delivery/create-order'
import type { ToolContext } from './types'

const h = vi.hoisted(() => ({
  loadProductWithAddonGroups: vi.fn(),
  finalizeDeliveryOrder: vi.fn(),
}))

vi.mock('@/lib/flows/engine', () => ({
  loadProductWithAddonGroups: h.loadProductWithAddonGroups,
}))
vi.mock('@/lib/delivery/create-order', async () => {
  const actual = await vi.importActual<typeof import('@/lib/delivery/create-order')>(
    '@/lib/delivery/create-order',
  )
  return { ...actual, finalizeDeliveryOrder: h.finalizeDeliveryOrder }
})

import {
  searchMenuTool,
  viewCartTool,
  addToCartTool,
  placeOrderTool,
  getAvailableTools,
} from './delivery'

interface FakeProduct {
  id: string
  name: string
  description: string | null
  price: number
}

interface FakeBusinessHours {
  enabled: boolean
  timezone: string
  hours: Record<string, { open: string; close: string } | null>
}

function makeDb(
  opts: {
    cart?: CartLineItem[]
    products?: FakeProduct[]
    businessHours?: FakeBusinessHours | null
  } = {},
) {
  let cart = opts.cart ?? []
  const products = opts.products ?? []
  const businessHours = opts.businessHours ?? null
  const writes: CartLineItem[][] = []

  const db = {
    from: (table: string) => {
      if (table === 'delivery_business_hours') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: businessHours, error: null }),
            }),
          }),
        }
      }
      if (table === 'conversations') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: { ai_cart: cart }, error: null }),
            }),
          }),
          update: (payload: { ai_cart: CartLineItem[] }) => {
            cart = payload.ai_cart
            writes.push(payload.ai_cart)
            return { eq: () => Promise.resolve({ error: null }) }
          },
        }
      }
      if (table === 'delivery_products') {
        let filtered = products
        // `.limit()` doesn't terminate the real postgrest builder — a
        // caller can chain `.ilike()` after it, and the query only
        // resolves once awaited. Make the chain itself thenable so
        // `await query` works regardless of call order.
        const chain = {
          select: () => chain,
          eq: () => chain,
          ilike: (_col: string, pattern: string) => {
            const needle = String(pattern).replace(/%/g, '').toLowerCase()
            filtered = filtered.filter((p) => p.name.toLowerCase().includes(needle))
            return chain
          },
          order: () => chain,
          limit: () => chain,
          then: (resolve: (v: { data: FakeProduct[]; error: null }) => void) =>
            resolve({ data: filtered, error: null }),
        }
        return chain
      }
      throw new Error(`unexpected table in test fake db: ${table}`)
    },
  } as unknown as SupabaseClient

  return { db, writes, getCart: () => cart }
}

function ctxFor(db: SupabaseClient, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    db,
    accountId: 'acct-1',
    conversationId: 'conv-1',
    contactId: 'contact-1',
    currency: 'BRL',
    allowSideEffects: true,
    ...overrides,
  }
}

beforeEach(() => {
  h.loadProductWithAddonGroups.mockReset()
  h.finalizeDeliveryOrder.mockReset()
})

describe('searchMenuTool', () => {
  it('lists active products with id and price', async () => {
    const { db } = makeDb({
      products: [{ id: 'p1', name: 'Pizza', description: 'Cheesy', price: 30 }],
    })
    const res = await searchMenuTool.execute({}, ctxFor(db))
    expect(res.content).toContain('Pizza')
    expect(res.content).toContain('product_id: p1')
  })

  it('reports no matches without throwing', async () => {
    const { db } = makeDb({ products: [] })
    const res = await searchMenuTool.execute({ query: 'sushi' }, ctxFor(db))
    expect(res.content).toMatch(/no active menu items/i)
  })
})

describe('viewCartTool', () => {
  it('reports an empty cart', async () => {
    const { db } = makeDb({ cart: [] })
    const res = await viewCartTool.execute({}, ctxFor(db))
    expect(res.content).toMatch(/empty/i)
  })

  it('itemizes the cart and totals it', async () => {
    const { db } = makeDb({
      cart: [
        { product_id: 'p1', product_name: 'Pizza', unit_price: 30, quantity: 2, addons: [] },
      ],
    })
    const res = await viewCartTool.execute({}, ctxFor(db))
    expect(res.content).toContain('2x Pizza')
    expect(res.content).toContain('60')
  })
})

describe('addToCartTool', () => {
  it('rejects a product_id that does not resolve for this account', async () => {
    h.loadProductWithAddonGroups.mockResolvedValue(null)
    const { db, writes } = makeDb({ cart: [] })
    const res = await addToCartTool.execute({ product_id: 'not-mine' }, ctxFor(db))
    expect(res.content).toMatch(/doesn't exist|does not exist/i)
    expect(writes).toHaveLength(0)
    expect(h.loadProductWithAddonGroups).toHaveBeenCalledWith(db, 'acct-1', 'not-mine')
  })

  it('appends a line item with server-computed price and clamps quantity', async () => {
    h.loadProductWithAddonGroups.mockResolvedValue({
      id: 'p1',
      name: 'Pizza',
      price: 30,
      addon_groups: [],
    })
    const { db, writes } = makeDb({ cart: [] })
    const res = await addToCartTool.execute({ product_id: 'p1', quantity: 999 }, ctxFor(db))
    expect(writes).toHaveLength(1)
    expect(writes[0][0]).toMatchObject({ product_id: 'p1', unit_price: 30, quantity: 20 })
    expect(res.content).toMatch(/added 20x pizza/i)
  })

  it('only applies addon_option_ids that actually belong to the product', async () => {
    h.loadProductWithAddonGroups.mockResolvedValue({
      id: 'p1',
      name: 'Pizza',
      price: 30,
      addon_groups: [
        {
          id: 'g1',
          name: 'Size',
          selection_type: 'single',
          is_required: false,
          position: 0,
          options: [{ id: 'o1', name: 'Large', price_delta: 5, group_id: 'g1' }],
        },
      ],
    })
    const { db, writes } = makeDb({ cart: [] })
    await addToCartTool.execute(
      { product_id: 'p1', addon_option_ids: ['o1', 'not-a-real-option'] },
      ctxFor(db),
    )
    expect(writes[0][0].addons).toEqual([
      { group_id: 'g1', group_name: 'Size', option_id: 'o1', option_name: 'Large', price_delta: 5 },
    ])
  })
})

describe('placeOrderTool', () => {
  it('refuses to place an order from an empty cart', async () => {
    const { db } = makeDb({ cart: [] })
    const res = await placeOrderTool.execute({}, ctxFor(db))
    expect(res.content).toMatch(/empty/i)
    expect(h.finalizeDeliveryOrder).not.toHaveBeenCalled()
  })

  it('finalizes the order with source ai_chat and clears the cart', async () => {
    const cart: CartLineItem[] = [
      { product_id: 'p1', product_name: 'Pizza', unit_price: 30, quantity: 1, addons: [] },
    ]
    h.finalizeDeliveryOrder.mockResolvedValue({ id: 'order-1', total: 30, currency: 'BRL' })
    const { db, writes } = makeDb({ cart })
    const res = await placeOrderTool.execute({ delivery_address: 'Rua X, 123' }, ctxFor(db))

    expect(h.finalizeDeliveryOrder).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ accountId: 'acct-1', source: 'ai_chat', cart, currency: 'BRL' }),
    )
    expect(writes[writes.length - 1]).toEqual([]) // cart cleared
    expect(res.data).toMatchObject({ id: 'order-1', total: 30, currency: 'BRL' })
  })

  const cart: CartLineItem[] = [
    { product_id: 'p1', product_name: 'Pizza', unit_price: 30, quantity: 1, addons: [] },
  ]

  it('refuses to place an order when business hours are enabled and currently closed', async () => {
    const { db } = makeDb({
      cart,
      businessHours: { enabled: true, timezone: 'UTC', hours: {} }, // empty schedule = always closed
    })
    const res = await placeOrderTool.execute({}, ctxFor(db))
    expect(res.content).toMatch(/fechados/i)
    expect(h.finalizeDeliveryOrder).not.toHaveBeenCalled()
  })

  it('places the order when business hours are configured but not enabled', async () => {
    h.finalizeDeliveryOrder.mockResolvedValue({ id: 'order-2', total: 30, currency: 'BRL' })
    const { db } = makeDb({
      cart,
      businessHours: { enabled: false, timezone: 'UTC', hours: {} },
    })
    const res = await placeOrderTool.execute({}, ctxFor(db))
    expect(h.finalizeDeliveryOrder).toHaveBeenCalled()
    expect(res.data).toMatchObject({ id: 'order-2' })
  })

  it('places the order when no business-hours config exists at all', async () => {
    h.finalizeDeliveryOrder.mockResolvedValue({ id: 'order-3', total: 30, currency: 'BRL' })
    const { db } = makeDb({ cart, businessHours: null })
    const res = await placeOrderTool.execute({}, ctxFor(db))
    expect(h.finalizeDeliveryOrder).toHaveBeenCalled()
    expect(res.data).toMatchObject({ id: 'order-3' })
  })
})

describe('getAvailableTools', () => {
  it('returns nothing when the account has not enabled the delivery module', () => {
    expect(
      getAvailableTools({ accountHasDeliveryModule: false, toolsEnabled: true, allowSideEffects: true }),
    ).toEqual([])
  })

  it('returns only read-only tools for draft/playground regardless of tools_enabled', () => {
    const tools = getAvailableTools({
      accountHasDeliveryModule: true,
      toolsEnabled: false,
      allowSideEffects: false,
    })
    expect(tools.map((t) => t.name).sort()).toEqual(['search_menu', 'view_cart'])
  })

  it('returns nothing for live chat when tools_enabled is off', () => {
    expect(
      getAvailableTools({ accountHasDeliveryModule: true, toolsEnabled: false, allowSideEffects: true }),
    ).toEqual([])
  })

  it('returns all four tools for live chat once tools_enabled is on', () => {
    const tools = getAvailableTools({
      accountHasDeliveryModule: true,
      toolsEnabled: true,
      allowSideEffects: true,
    })
    expect(tools.map((t) => t.name).sort()).toEqual([
      'add_to_cart',
      'place_order',
      'search_menu',
      'view_cart',
    ])
  })
})
