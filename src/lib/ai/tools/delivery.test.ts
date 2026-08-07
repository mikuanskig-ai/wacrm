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
  placeOrderTool,
  calculateDeliveryFeeTool,
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
    /** Overrides what `ai_cart` reads back as, bypassing the `cart`
     *  typing — for regression-testing readCart() against a corrupted
     *  (non-array) value already sitting in the column. */
    rawAiCart?: unknown
    products?: FakeProduct[]
    businessHours?: FakeBusinessHours | null
    /** Overrides the `delivery_fee_configs` row — keep the method
     *  geocode-free (`fixed`, or `neighborhood` with `max_distance:
     *  null` and an explicit neighbourhood name) or a test will hit the
     *  real network via the real DistanceProvider. Full calculation
     *  coverage lives in fee-engine.test.ts (fake provider, no I/O). */
    feeConfig?: Record<string, unknown> | null
  } = {},
) {
  let cart = opts.cart ?? []
  const hasRawOverride = 'rawAiCart' in opts
  const products = opts.products ?? []
  const businessHours = opts.businessHours ?? null
  const feeConfig = opts.feeConfig ?? null
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
      // No row = permissive default (fixed @ 0, no address needed) —
      // see getDeliveryFeeConfig. Tests that care about a real
      // calculation live in fee-engine.test.ts.
      if (table === 'delivery_fee_configs') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: feeConfig, error: null }),
            }),
          }),
        }
      }
      if (table === 'conversations') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: { ai_cart: hasRawOverride ? opts.rawAiCart : cart },
                  error: null,
                }),
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

  it('treats a corrupted (non-array) ai_cart as empty instead of crashing — regression, 2026-08-06', async () => {
    // A past bug wrote the literal string "[]" instead of an array on
    // handoff; readCart() blindly cast it back to CartLineItem[] and
    // any tool that then called .reduce on it crashed the whole turn.
    const { db } = makeDb({ rawAiCart: '[]' })
    const res = await viewCartTool.execute({}, ctxFor(db))
    expect(res.content).toMatch(/empty/i)
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

  it('merges into the existing line instead of duplicating it when the model re-adds the same product+customization — regression, 2026-08-06', async () => {
    // The model has no memory of tool calls from earlier turns (only
    // the text transcript), so it sometimes calls add_to_cart again for
    // something already in the cart. Confirmed live: without merging,
    // one customer request for "uma marmita" ended up as three separate
    // 1x lines (R$60 instead of R$20) after the model re-added it on
    // later turns — and then got stuck with no way to undo it.
    h.loadProductWithAddonGroups.mockResolvedValue({
      id: 'p1',
      name: 'Marmita P',
      price: 20,
      addon_groups: [],
    })
    const { db, writes, getCart } = makeDb({
      cart: [{ product_id: 'p1', product_name: 'Marmita P', unit_price: 20, quantity: 1, addons: [], notes: null }],
    })
    const res = await addToCartTool.execute({ product_id: 'p1', quantity: 1 }, ctxFor(db))
    expect(getCart()).toHaveLength(1)
    expect(getCart()[0]).toMatchObject({ product_id: 'p1', quantity: 2 })
    expect(writes[0]).toHaveLength(1)
    // Deliberately NOT "already in the cart" / "merged" — that framing
    // read as an anomaly to the model and triggered a handoff right
    // after a perfectly correct merge (confirmed live, 2026-08-06). The
    // message must sound like a routine running-total update.
    expect(res.content).not.toMatch(/already in the cart|merged/i)
    expect(res.content).toMatch(/now 2x total/i)
  })

  it('attaches a note to the existing bare line instead of duplicating it — regression, 2026-08-07', async () => {
    // Live incident: customer said "1 marmita P" (added bare, no notes),
    // then in the next message described how they wanted it prepared
    // ("sem carne, com ovo frito, sem macarrão"). The model, with no
    // memory of the first call, re-called add_to_cart with that as
    // `notes` — since notes differ from the existing (empty) line, the
    // exact-match merge above didn't catch it, so it created a SECOND
    // 1x line: R$20 x 2 shown as a R$40 subtotal for one R$20 marmita.
    h.loadProductWithAddonGroups.mockResolvedValue({
      id: 'p1',
      name: 'Marmita P',
      price: 20,
      addon_groups: [],
    })
    const { db, writes, getCart } = makeDb({
      cart: [{ product_id: 'p1', product_name: 'Marmita P', unit_price: 20, quantity: 1, addons: [], notes: null }],
    })
    const res = await addToCartTool.execute(
      { product_id: 'p1', quantity: 1, notes: 'Sem carne, com ovo frito, sem macarrão' },
      ctxFor(db),
    )
    expect(getCart()).toHaveLength(1)
    expect(getCart()[0]).toMatchObject({
      product_id: 'p1',
      quantity: 1,
      notes: 'Sem carne, com ovo frito, sem macarrão',
    })
    expect(writes[0]).toHaveLength(1)
    expect(res.content).toMatch(/noted for the 1x marmita p/i)
    expect(res.content).not.toMatch(/added 1x marmita p to the cart/i)
  })

  it('keeps a different customization of the same product as its own line', async () => {
    h.loadProductWithAddonGroups.mockResolvedValue({
      id: 'p1',
      name: 'Marmita',
      price: 20,
      addon_groups: [
        {
          id: 'g1',
          name: 'Tamanho',
          selection_type: 'single',
          is_required: true,
          position: 0,
          options: [
            { id: 'o-p', name: 'P', price_delta: 0, group_id: 'g1' },
            { id: 'o-g', name: 'G', price_delta: 5, group_id: 'g1' },
          ],
        },
      ],
    })
    const { db, getCart } = makeDb({
      cart: [
        {
          product_id: 'p1',
          product_name: 'Marmita',
          unit_price: 20,
          quantity: 1,
          addons: [{ group_id: 'g1', group_name: 'Tamanho', option_id: 'o-p', option_name: 'P', price_delta: 0 }],
          notes: null,
        },
      ],
    })
    await addToCartTool.execute({ product_id: 'p1', quantity: 1, addon_option_ids: ['o-g'] }, ctxFor(db))
    expect(getCart()).toHaveLength(2)
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
    const res = await placeOrderTool.execute({ is_pickup: true }, ctxFor(db))
    expect(h.finalizeDeliveryOrder).toHaveBeenCalled()
    expect(res.data).toMatchObject({ id: 'order-2' })
  })

  it('places the order when no business-hours config exists at all', async () => {
    h.finalizeDeliveryOrder.mockResolvedValue({ id: 'order-3', total: 30, currency: 'BRL' })
    const { db } = makeDb({ cart, businessHours: null })
    const res = await placeOrderTool.execute({ is_pickup: true }, ctxFor(db))
    expect(h.finalizeDeliveryOrder).toHaveBeenCalled()
    expect(res.data).toMatchObject({ id: 'order-3' })
  })

  it('refuses a delivery order with no address and no is_pickup, instead of silently requiring one via the fee calculation — regression, 2026-08-06', async () => {
    // Every account on a distance-based fee method (per_km,
    // distance_range, or neighborhood without an explicit name) always
    // needs an address to compute distance — so before this guard,
    // place_order for a stated pickup order still called the fee
    // engine, which demanded an address the customer had already said
    // wasn't needed. Confirmed live: a real pickup order got stuck here.
    const { db } = makeDb({ cart, businessHours: null })
    const res = await placeOrderTool.execute({}, ctxFor(db))
    expect(res.content).toMatch(/missing delivery_address|is_pickup/i)
    expect(h.finalizeDeliveryOrder).not.toHaveBeenCalled()
  })

  it('skips fee calculation entirely for a pickup order — no address needed', async () => {
    h.finalizeDeliveryOrder.mockResolvedValue({ id: 'order-4', total: 30, currency: 'BRL' })
    // A geocode-requiring method would hang/hit the network if the fee
    // engine were reached at all — proving is_pickup bypasses it, not
    // just happens to succeed on a permissive default config.
    const { db } = makeDb({
      cart,
      businessHours: null,
      feeConfig: { delivery_method: 'per_km', max_distance: null, free_shipping_above: null, origin_lat: -25, origin_lng: -49, settings: { base_price: 0, price_per_km: 2 } },
    })
    const res = await placeOrderTool.execute({ is_pickup: true }, ctxFor(db))
    expect(h.finalizeDeliveryOrder).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ deliveryFee: 0, deliveryAddress: null }),
    )
    expect(res.data).toMatchObject({ id: 'order-4', deliveryFee: 0 })
  })
})

describe('calculateDeliveryFeeTool', () => {
  it('passes an explicit neighborhood through, skipping geocode entirely for a neighborhood-method account — regression, 2026-08-06', async () => {
    // Before this, the tool only ever sent free-text `address` to the
    // fee engine, so a "fixed price per bairro" account still depended
    // on the external geocoder to guess the neighbourhood from that
    // address — even when the model already knew it as its own answer.
    // max_distance: null here is what proves no distance/geocode step
    // ran: a geocode-requiring config would hit the real network in
    // this test (no DistanceProvider mock in this file) and hang/fail.
    const { db } = makeDb({
      cart: [],
      feeConfig: {
        delivery_method: 'neighborhood',
        max_distance: null,
        free_shipping_above: null,
        origin_lat: null,
        origin_lng: null,
        settings: { neighborhoods: [{ id: 'n1', name: 'Centro', price: 7 }] },
      },
    })
    const res = await calculateDeliveryFeeTool.execute(
      { address: 'Rua X, 100, Centro', neighborhood: 'Centro' },
      ctxFor(db),
    )
    expect(res.content).toMatch(/7/)
    expect(res.content).not.toMatch(/could not locate|not in our delivery list/i)
  })

  it('returns subtotal and a pre-added total alongside the fee — regression, 2026-08-06', async () => {
    // Confirmed live: the model hallucinated a R$100 subtotal for a
    // single R$25 item when left to compute the order-summary numbers
    // itself. The fee tool now hands back subtotal + total already
    // added up, so there is no arithmetic left for the model to get
    // wrong when it copies them into the summary.
    const { db } = makeDb({
      cart: [{ product_id: 'p1', product_name: 'Marmita M', unit_price: 25, quantity: 1, addons: [], notes: null }],
      feeConfig: {
        delivery_method: 'neighborhood',
        max_distance: null,
        free_shipping_above: null,
        origin_lat: null,
        origin_lng: null,
        settings: { neighborhoods: [{ id: 'n1', name: 'Coqueiral', price: 2 }] },
      },
    })
    const res = await calculateDeliveryFeeTool.execute(
      { address: 'Rua Pedro Miranda 646, Coqueiral', neighborhood: 'Coqueiral' },
      ctxFor(db),
    )
    expect(res.content).toMatch(/subtotal.*25/i)
    expect(res.content).toMatch(/total.*27/i)
  })

  it('accepts latitude/longitude from a WhatsApp location share in place of address — regression, 2026-08-07', async () => {
    // Passing an explicit neighborhood alongside lat/lng keeps this
    // network-free (same reasoning as the max_distance: null test
    // above) while proving the tool no longer requires `address` when
    // coordinates are given.
    const { db } = makeDb({
      cart: [],
      feeConfig: {
        delivery_method: 'neighborhood',
        max_distance: null,
        free_shipping_above: null,
        origin_lat: null,
        origin_lng: null,
        settings: { neighborhoods: [{ id: 'n1', name: 'Centro', price: 5 }] },
      },
    })
    const res = await calculateDeliveryFeeTool.execute(
      { latitude: -24.9532935, longitude: -53.4699534, neighborhood: 'Centro' },
      ctxFor(db),
    )
    expect(res.content).toMatch(/5/)
    expect(res.content).not.toMatch(/missing address/i)
  })

  it('rejects when neither address nor latitude/longitude are given', async () => {
    const { db } = makeDb({ cart: [] })
    const res = await calculateDeliveryFeeTool.execute({}, ctxFor(db))
    expect(res.content).toMatch(/missing address/i)
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
