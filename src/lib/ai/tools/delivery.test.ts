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
  getProductDetailsTool,
  viewCartTool,
  addToCartTool,
  calculateDeliveryFeeTool,
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
    /** The customer's last few messages, most-recent-first — feeds
     *  mostRecentSharedLocation's lookback. */
    recentCustomerMessages?: { content_type: string; content_text: string | null }[]
  } = {},
) {
  let cart = opts.cart ?? []
  const products = opts.products ?? []
  const businessHours = opts.businessHours ?? null
  const recentCustomerMessages = opts.recentCustomerMessages ?? []
  const writes: CartLineItem[][] = []

  const db = {
    from: (table: string) => {
      if (table === 'messages') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: () => Promise.resolve({ data: recentCustomerMessages, error: null }),
        }
        return chain
      }
      if (table === 'delivery_business_hours') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: businessHours, error: null }),
            }),
          }),
        }
      }
      // No row = permissive default (fixed @ 0, no address needed) —
      // see getDeliveryFeeConfig. Tests that care about a real
      // calculation live in fee-engine.test.ts.
      if (table === 'delivery_fee_configs') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
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

describe('getProductDetailsTool', () => {
  it('rejects a product_id that does not resolve for this account', async () => {
    h.loadProductWithAddonGroups.mockResolvedValue(null)
    const { db } = makeDb({})
    const res = await getProductDetailsTool.execute({ product_id: 'not-mine' }, ctxFor(db))
    expect(res.content).toMatch(/doesn't exist|does not exist/i)
  })

  it('reports no customization options for a plain product', async () => {
    h.loadProductWithAddonGroups.mockResolvedValue({
      id: 'p1',
      name: 'Coxinha',
      price: 8,
      addon_groups: [],
    })
    const { db } = makeDb({})
    const res = await getProductDetailsTool.execute({ product_id: 'p1' }, ctxFor(db))
    expect(res.content).toMatch(/no customization options/i)
  })

  it('lists every addon group with cardinality and option ids — generic, not menu-specific', async () => {
    h.loadProductWithAddonGroups.mockResolvedValue({
      id: 'p1',
      name: 'X-Burguer',
      price: 22,
      addon_groups: [
        {
          id: 'g1',
          name: 'Ponto da carne',
          selection_type: 'single',
          is_required: true,
          position: 0,
          options: [
            { id: 'o1', name: 'Ao ponto', price_delta: 0, group_id: 'g1' },
            { id: 'o2', name: 'Bem passado', price_delta: 0, group_id: 'g1' },
          ],
        },
        {
          id: 'g2',
          name: 'Adicionais',
          selection_type: 'multiple',
          is_required: false,
          position: 1,
          options: [{ id: 'o3', name: 'Bacon extra', price_delta: 4, group_id: 'g2' }],
        },
      ],
    })
    const { db } = makeDb({})
    const res = await getProductDetailsTool.execute({ product_id: 'p1' }, ctxFor(db))
    expect(res.content).toContain('Ponto da carne (required, choose exactly one)')
    expect(res.content).toContain('Ao ponto (option_id: o1, +0)')
    expect(res.content).toContain('Adicionais (optional, choose any number)')
    expect(res.content).toContain('Bacon extra (option_id: o3, +4)')
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

  const burgerWithRequiredGroup = {
    id: 'p1',
    name: 'X-Burguer',
    price: 22,
    addon_groups: [
      {
        id: 'g1',
        name: 'Ponto da carne',
        selection_type: 'single' as const,
        is_required: true,
        position: 0,
        options: [
          { id: 'o1', name: 'Ao ponto', price_delta: 0, group_id: 'g1' },
          { id: 'o2', name: 'Bem passado', price_delta: 0, group_id: 'g1' },
        ],
      },
    ],
  }

  it('rejects add_to_cart when a required addon group has no selection — regardless of business type', async () => {
    h.loadProductWithAddonGroups.mockResolvedValue(burgerWithRequiredGroup)
    const { db, writes } = makeDb({ cart: [] })
    const res = await addToCartTool.execute({ product_id: 'p1' }, ctxFor(db))
    expect(res.content).toMatch(/ponto da carne.*requires a choice/i)
    expect(res.content).toContain('Ao ponto (option_id: o1)')
    expect(writes).toHaveLength(0)
  })

  it('accepts add_to_cart once the required group is satisfied', async () => {
    h.loadProductWithAddonGroups.mockResolvedValue(burgerWithRequiredGroup)
    const { db, writes } = makeDb({ cart: [] })
    const res = await addToCartTool.execute(
      { product_id: 'p1', addon_option_ids: ['o1'] },
      ctxFor(db),
    )
    expect(writes).toHaveLength(1)
    expect(res.content).toMatch(/added/i)
  })

  it('rejects more than one selection in a single-selection group', async () => {
    h.loadProductWithAddonGroups.mockResolvedValue(burgerWithRequiredGroup)
    const { db, writes } = makeDb({ cart: [] })
    const res = await addToCartTool.execute(
      { product_id: 'p1', addon_option_ids: ['o1', 'o2'] },
      ctxFor(db),
    )
    expect(res.content).toMatch(/ponto da carne.*allows only one choice/i)
    expect(writes).toHaveLength(0)
  })
})

describe('calculateDeliveryFeeTool', () => {
  it('requires an address when nothing was shared', async () => {
    const { db } = makeDb({})
    const res = await calculateDeliveryFeeTool.execute({}, ctxFor(db))
    expect(res.content).toMatch(/missing address/i)
  })

  it('does not require an address when the customer\'s last message was a shared location pin', async () => {
    const { db } = makeDb({
      recentCustomerMessages: [{ content_type: 'location', content_text: '-24.9532935,-53.4699534' }],
    })
    const res = await calculateDeliveryFeeTool.execute({}, ctxFor(db))
    expect(res.content).not.toMatch(/missing address/i)
    expect(res.content).toMatch(/delivery fee/i)
  })

  it('finds a location shared a couple of messages back — not just the literal last one', async () => {
    // WhatsApp can't attach text to a location share, so a follow-up
    // like "apto 302" is a normal, expected next message, not a
    // replacement for the pin (most-recent-first, matching the DB
    // order the real query returns).
    const { db } = makeDb({
      recentCustomerMessages: [
        { content_type: 'text', content_text: 'apto 302' },
        { content_type: 'location', content_text: '-24.9532935,-53.4699534' },
      ],
    })
    const res = await calculateDeliveryFeeTool.execute({}, ctxFor(db))
    expect(res.content).not.toMatch(/missing address/i)
  })

  it('requires an address when no location appears in the recent history at all', async () => {
    const { db } = makeDb({
      recentCustomerMessages: [{ content_type: 'text', content_text: 'oi' }],
    })
    const res = await calculateDeliveryFeeTool.execute({}, ctxFor(db))
    expect(res.content).toMatch(/missing address/i)
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

  it('stores a tappable Maps link when only a location pin was shared, never bare digits', async () => {
    const cart: CartLineItem[] = [
      { product_id: 'p1', product_name: 'Pizza', unit_price: 30, quantity: 1, addons: [] },
    ]
    h.finalizeDeliveryOrder.mockResolvedValue({ id: 'order-loc', total: 30, currency: 'BRL' })
    const { db } = makeDb({
      cart,
      recentCustomerMessages: [{ content_type: 'location', content_text: '-24.9532935,-53.4699534' }],
    })
    await placeOrderTool.execute({}, ctxFor(db))

    expect(h.finalizeDeliveryOrder).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        deliveryAddress: 'https://www.google.com/maps?q=-24.9532935,-53.4699534',
      }),
    )
  })

  it('combines the customer-given text (house number/reference) with a Maps link when both a text address and a shared location are present — the driver needs both', async () => {
    const cart: CartLineItem[] = [
      { product_id: 'p1', product_name: 'Pizza', unit_price: 30, quantity: 1, addons: [] },
    ]
    h.finalizeDeliveryOrder.mockResolvedValue({ id: 'order-both', total: 30, currency: 'BRL' })
    const { db } = makeDb({
      cart,
      recentCustomerMessages: [{ content_type: 'location', content_text: '-24.9532935,-53.4699534' }],
    })
    await placeOrderTool.execute({ delivery_address: 'Portão azul, fundos' }, ctxFor(db))

    expect(h.finalizeDeliveryOrder).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        deliveryAddress: 'Portão azul, fundos — https://www.google.com/maps?q=-24.9532935,-53.4699534',
      }),
    )
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
    expect(tools.map((t) => t.name).sort()).toEqual([
      'calculate_delivery_fee',
      'get_product_details',
      'search_menu',
      'view_cart',
    ])
  })

  it('returns nothing for live chat when tools_enabled is off', () => {
    expect(
      getAvailableTools({ accountHasDeliveryModule: true, toolsEnabled: false, allowSideEffects: true }),
    ).toEqual([])
  })

  it('returns all six tools for live chat once tools_enabled is on', () => {
    const tools = getAvailableTools({
      accountHasDeliveryModule: true,
      toolsEnabled: true,
      allowSideEffects: true,
    })
    expect(tools.map((t) => t.name).sort()).toEqual([
      'add_to_cart',
      'calculate_delivery_fee',
      'get_product_details',
      'place_order',
      'search_menu',
      'view_cart',
    ])
  })
})
