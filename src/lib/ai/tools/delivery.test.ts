import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CartLineItem } from '@/lib/delivery/create-order'
import type { ToolContext } from './types'

const h = vi.hoisted(() => ({
  loadProductWithAddonGroups: vi.fn(),
  finalizeDeliveryOrder: vi.fn(),
  dispatchWebhookEvent: vi.fn(async () => {}),
  runAutomationsForTrigger: vi.fn(async () => {}),
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
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: h.dispatchWebhookEvent }))
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: h.runAutomationsForTrigger }))

import {
  searchMenuTool,
  getProductDetailsTool,
  viewCartTool,
  addToCartTool,
  updateCartItemTool,
  placeOrderTool,
  calculateDeliveryFeeTool,
  updateOrderInfoTool,
  cancelOrderTool,
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
    /** Seeds `conversations.ai_order_info` (order-state.ts) — the
     *  customer-name/address/payment/last-quote object that lives
     *  alongside the cart on the same row. */
    orderInfo?: Record<string, unknown>
    products?: FakeProduct[]
    businessHours?: FakeBusinessHours | null
    /** Overrides the `delivery_fee_configs` row — keep the method
     *  geocode-free (`fixed`, or `neighborhood` with `max_distance:
     *  null` and an explicit neighbourhood name) or a test will hit the
     *  real network via the real DistanceProvider. Full calculation
     *  coverage lives in fee-engine.test.ts (fake provider, no I/O). */
    feeConfig?: Record<string, unknown> | null
    /** The customer's most recent message row, as `mostRecentSharedLocation`
     *  (tools/delivery.ts) reads it — defaults to none, so every
     *  existing test that never shared a location keeps behaving
     *  exactly as before. Set `content_type: 'location'` to simulate a
     *  just-shared WhatsApp pin. */
    lastCustomerMessage?: { content_type: string; content_text: string | null } | null
    /** Customer messages `customerMentionedProductSince` (tools/delivery.ts)
     *  reads when add_to_cart is about to merge into an existing line —
     *  the re-add duplicate-guard's evidence window. Defaults to none, so
     *  any test that never sets this exercises the "nothing mentioned it
     *  again" (blocked) path whenever a seeded cart line has `addedAt`. */
    customerMessagesSince?: { content_text: string | null }[]
    /** Seeds `delivery_orders` — cancelOrderTool's own lookup/update
     *  target. Keyed by id since a test may need more than one row. */
    deliveryOrders?: Record<string, unknown>[]
  } = {},
) {
  let cart = opts.cart ?? []
  const hasRawOverride = 'rawAiCart' in opts
  let orderInfo: Record<string, unknown> = opts.orderInfo ?? {}
  const products = opts.products ?? []
  const businessHours = opts.businessHours ?? null
  const feeConfig = opts.feeConfig ?? null
  const lastCustomerMessage = opts.lastCustomerMessage ?? null
  const customerMessagesSince = opts.customerMessagesSince ?? []
  const deliveryOrders = opts.deliveryOrders ?? []
  const writes: CartLineItem[][] = []
  const orderInfoWrites: Record<string, unknown>[] = []
  const deliveryOrderUpdates: Record<string, unknown>[] = []

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
                  data: {
                    ai_cart: hasRawOverride ? opts.rawAiCart : cart,
                    ai_order_info: orderInfo,
                  },
                  error: null,
                }),
            }),
          }),
          // A single mocked `conversations` row backs both `ai_cart`
          // (readCart/writeCart) and `ai_order_info` (order-state.ts) —
          // real code updates them independently (never both in the
          // same call), so this only ever touches whichever key the
          // payload actually has.
          update: (payload: Record<string, unknown>) => {
            if ('ai_cart' in payload) {
              cart = payload.ai_cart as CartLineItem[]
              writes.push(payload.ai_cart as CartLineItem[])
            }
            if ('ai_order_info' in payload) {
              orderInfo = payload.ai_order_info as Record<string, unknown>
              orderInfoWrites.push(orderInfo)
            }
            return { eq: () => Promise.resolve({ error: null }) }
          },
        }
      }
      if (table === 'messages') {
        // Thenable chain (same pattern as delivery_products below) so it
        // serves both real call shapes against this table: `mostRecentSharedLocation`
        // ends the chain in `.maybeSingle()`; `customerMentionedProductSince`
        // (the re-add duplicate-guard) adds a `.gt()` and awaits the chain
        // directly for an array.
        const chain = {
          select: () => chain,
          eq: () => chain,
          gt: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: () => Promise.resolve({ data: lastCustomerMessage, error: null }),
          then: (resolve: (v: { data: { content_text: string | null }[]; error: null }) => void) =>
            resolve({ data: customerMessagesSince, error: null }),
        }
        return chain
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
      if (table === 'delivery_orders') {
        let matchId: string | undefined
        let matchAccountId: string | undefined
        const chain = {
          select: () => chain,
          eq: (col: string, val: string) => {
            if (col === 'id') matchId = val
            if (col === 'account_id') matchAccountId = val
            return chain
          },
          maybeSingle: () => {
            const row = deliveryOrders.find(
              (o) => o.id === matchId && (matchAccountId === undefined || o.account_id === matchAccountId),
            )
            // A copy, not the live reference — a real Supabase response
            // is a freshly deserialized object every call, independent
            // of whatever a later .update() does to the row. Returning
            // the same object by reference here let an update mutate
            // this test's own "order" variable out from under it.
            return Promise.resolve({ data: row ? { ...row } : null, error: null })
          },
          update: (payload: Record<string, unknown>) => ({
            eq: (_col: string, val: string) => {
              const row = deliveryOrders.find((o) => o.id === val)
              if (row) Object.assign(row, payload)
              deliveryOrderUpdates.push({ id: val, ...payload })
              return Promise.resolve({ error: null })
            },
          }),
        }
        return chain
      }
      throw new Error(`unexpected table in test fake db: ${table}`)
    },
  } as unknown as SupabaseClient

  return {
    db,
    writes,
    getCart: () => cart,
    getOrderInfo: () => orderInfo,
    orderInfoWrites,
    deliveryOrderUpdates,
  }
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
  h.dispatchWebhookEvent.mockClear()
  h.runAutomationsForTrigger.mockClear()
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

  it('matches a product whose stored name lacks an accent the query has — confirmed live 2026-08-11', async () => {
    const { db } = makeDb({
      products: [{ id: 'p1', name: 'Rodizio de Carne', description: null, price: 59.9 }],
    })
    const res = await searchMenuTool.execute({ query: 'rodízio' }, ctxFor(db))
    expect(res.content).toContain('Rodizio de Carne')
  })

  it('matches on any significant word instead of requiring the whole query as one substring', async () => {
    const { db } = makeDb({
      products: [
        { id: 'p1', name: 'Rodizio de Carne', description: null, price: 59.9 },
        { id: 'p2', name: 'Almoço por Quilo', description: null, price: 94.9 },
        { id: 'p3', name: 'Refrigerante Lata', description: null, price: 8 },
      ],
    })
    // No single product name contains this whole phrase — a plain ILIKE
    // on the full string would return zero results, same as it did live.
    const res = await searchMenuTool.execute({ query: 'rodízio quilo almoço' }, ctxFor(db))
    expect(res.content).toContain('Rodizio de Carne')
    expect(res.content).toContain('Almoço por Quilo')
    expect(res.content).not.toContain('Refrigerante Lata')
  })

  it('ignores short filler words (< 3 letters) so they do not match everything', async () => {
    const { db } = makeDb({
      products: [
        { id: 'p1', name: 'Água com gás', description: null, price: 6 },
        { id: 'p2', name: 'Refrigerante Lata', description: null, price: 8 },
      ],
    })
    const res = await searchMenuTool.execute({ query: 'a água' }, ctxFor(db))
    expect(res.content).toContain('Água com gás')
    expect(res.content).not.toContain('Refrigerante Lata')
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

  it('numbers each line and shows notes — the identifier update_cart_item relies on', async () => {
    const { db } = makeDb({
      cart: [
        { product_id: 'p1', product_name: 'Marmita P', unit_price: 20, quantity: 1, addons: [], notes: 'sem cebola' },
        { product_id: 'p1', product_name: 'Marmita P', unit_price: 20, quantity: 1, addons: [], notes: 'com ovo' },
      ],
    })
    const res = await viewCartTool.execute({}, ctxFor(db))
    expect(res.content).toContain('1. 1x Marmita P [sem cebola]')
    expect(res.content).toContain('2. 1x Marmita P [com ovo]')
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
    // `addedAt` is recent (well inside the staleness window — see
    // isStaleCartLine) and a customer message mentions the product
    // again, both required since the 2026-08-26/2026-08-28 guards.
    h.loadProductWithAddonGroups.mockResolvedValue({
      id: 'p1',
      name: 'Marmita P',
      price: 20,
      addon_groups: [],
    })
    const { db, writes, getCart } = makeDb({
      cart: [
        {
          product_id: 'p1',
          product_name: 'Marmita P',
          unit_price: 20,
          quantity: 1,
          addons: [],
          notes: null,
          addedAt: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
      customerMessagesSince: [{ content_text: 'Quero uma marmita P' }],
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

  it('blocks a silent re-add when nothing in the customer\'s messages since asks for more — regression, 2026-08-26', async () => {
    // Live incident (Lucas Claro, Churrascaria Concórdia): customer said
    // "uma m" once, the AI correctly confirmed "1 marmita M", then after a
    // burst of unrelated follow-ups (address, switching to pickup, adding a
    // Coke, payment method) the AI's next reply said "2 marmitas M" — the
    // model had re-called add_to_cart for a product already committed, with
    // no new mention of it anywhere in the transcript.
    h.loadProductWithAddonGroups.mockResolvedValue({ id: 'p1', name: 'Marmita M', price: 28, addon_groups: [] })
    const { db, writes, getCart } = makeDb({
      cart: [
        {
          product_id: 'p1',
          product_name: 'Marmita M',
          unit_price: 28,
          quantity: 1,
          addons: [],
          notes: null,
          // Recent (well inside the staleness window — see
          // isStaleCartLine) so this exercises the mention-gating this
          // test is actually about, not the separate staleness guard.
          addedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        },
      ],
      // Same shape as the real burst: address, pickup, a different item,
      // payment method — never the marmita again.
      customerMessagesSince: [
        { content_text: 'Na Casas Bahia anexa ao mufatto da prefeitura' },
        { content_text: 'To indo aí busca' },
        { content_text: 'Uma coca 600 também' },
        { content_text: 'No débito daí' },
      ],
    })
    const res = await addToCartTool.execute({ product_id: 'p1', quantity: 1 }, ctxFor(db))
    expect(getCart()).toHaveLength(1)
    expect(getCart()[0]).toMatchObject({ product_id: 'p1', quantity: 1 })
    expect(writes).toHaveLength(0)
    expect(res.content).toMatch(/already in the cart at 1x.*not changed/i)
    expect(res.content).toContain('confirm_quantity_increase')
  })

  it('allows the merge when a customer message since then names the product again', async () => {
    h.loadProductWithAddonGroups.mockResolvedValue({ id: 'p1', name: 'Marmita M', price: 28, addon_groups: [] })
    const { db, getCart } = makeDb({
      cart: [
        {
          product_id: 'p1',
          product_name: 'Marmita M',
          unit_price: 28,
          quantity: 1,
          addons: [],
          notes: null,
          addedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        },
      ],
      customerMessagesSince: [{ content_text: 'Ah e quero mais uma marmita M também' }],
    })
    const res = await addToCartTool.execute({ product_id: 'p1', quantity: 1 }, ctxFor(db))
    expect(getCart()[0]).toMatchObject({ product_id: 'p1', quantity: 2 })
    expect(res.content).toMatch(/now 2x total/i)
  })

  it('allows the merge when the model explicitly confirms a real quantity increase', async () => {
    h.loadProductWithAddonGroups.mockResolvedValue({ id: 'p1', name: 'Marmita M', price: 28, addon_groups: [] })
    const { db, getCart } = makeDb({
      cart: [
        {
          product_id: 'p1',
          product_name: 'Marmita M',
          unit_price: 28,
          quantity: 1,
          addons: [],
          notes: null,
          addedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        },
      ],
      customerMessagesSince: [], // nothing textual — the model is vouching directly
    })
    const res = await addToCartTool.execute(
      { product_id: 'p1', quantity: 1, confirm_quantity_increase: true },
      ctxFor(db),
    )
    expect(getCart()[0]).toMatchObject({ product_id: 'p1', quantity: 2 })
    expect(res.content).toMatch(/now 2x total/i)
  })

  it('starts a new line instead of merging into a stale existing line, even when the customer re-mentions the product — regression, 2026-08-28 (Ezequiel, "marmita média pro meio-dia" near-daily order)', async () => {
    // Live incident: a cart line from a previous day's abandoned
    // session (place_order never called, so ai_cart never reset) sat
    // around for days. When the same customer started a brand new
    // order the next time and re-mentioned the product by name (as any
    // repeat customer naturally would — they're ordering it again),
    // the OLD gate ("did a customer message since mention the product
    // again?") was trivially satisfied and silently summed 1 + 1 = 2 —
    // double what today's message actually asked for. A stale line
    // must never merge, no matter what the customer's messages say.
    h.loadProductWithAddonGroups.mockResolvedValue({ id: 'p1', name: 'Marmita M', price: 28, addon_groups: [] })
    const { db, getCart } = makeDb({
      cart: [
        {
          product_id: 'p1',
          product_name: 'Marmita M',
          unit_price: 28,
          quantity: 1,
          addons: [],
          notes: null,
          addedAt: '2026-08-21T14:08:57.000Z', // days before "now"
        },
      ],
      // The exact trap: a same-day message that names the product is
      // normally enough to allow a merge (see the test above) — here it
      // must NOT be, because the existing line is stale.
      customerMessagesSince: [{ content_text: 'Queria pedir uma marmita média' }],
    })
    const res = await addToCartTool.execute({ product_id: 'p1', quantity: 1 }, ctxFor(db))
    expect(getCart()).toHaveLength(2)
    expect(getCart()[0]).toMatchObject({ product_id: 'p1', quantity: 1 })
    expect(getCart()[1]).toMatchObject({ product_id: 'p1', quantity: 1 })
    expect(res.content).toMatch(/added 1x marmita m to the cart/i)
    expect(res.content).not.toMatch(/now 2x total/i)
  })

  it('also treats a cart line with no addedAt at all as stale — legacy data written before this field existed never merges either', async () => {
    h.loadProductWithAddonGroups.mockResolvedValue({ id: 'p1', name: 'Marmita M', price: 28, addon_groups: [] })
    const { db, getCart } = makeDb({
      cart: [
        { product_id: 'p1', product_name: 'Marmita M', unit_price: 28, quantity: 1, addons: [], notes: null },
      ],
      customerMessagesSince: [{ content_text: 'Queria pedir uma marmita média' }],
    })
    const res = await addToCartTool.execute(
      { product_id: 'p1', quantity: 1, confirm_quantity_increase: true },
      ctxFor(db),
    )
    expect(getCart()).toHaveLength(2)
    expect(res.content).not.toMatch(/now 2x total/i)
  })

  it('attaches a note to the existing bare line instead of duplicating it — regression, 2026-08-07 — only when the model explicitly says attach_note_to_existing', async () => {
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
      { product_id: 'p1', quantity: 1, notes: 'Sem carne, com ovo frito, sem macarrão', attach_note_to_existing: true },
      ctxFor(db),
    )
    expect(getCart()).toHaveLength(1)
    expect(getCart()[0]).toMatchObject({
      product_id: 'p1',
      quantity: 1,
      notes: 'Sem carne, com ovo frito, sem macarrão',
      addons: [], // untouched by this merge — must not be corrupted by it
    })
    expect(writes[0]).toHaveLength(1)
    expect(res.content).toMatch(/updated the existing 1x marmita p/i)
    expect(res.content).not.toMatch(/added 1x marmita p to the cart/i)
  })

  it('attaches an addon choice to the existing bare line instead of duplicating it — regression, 2026-09-05 (Ezequiel: "E um refrigerante lata" added bare, then "Coca cola" a few seconds later became a SECOND "Refrigerante Lata" line instead of setting the flavor on the first one — same shape as the 2026-08-07 notes case above, just addon_option_ids instead of notes, which the original refinement match never looked at)', async () => {
    h.loadProductWithAddonGroups.mockResolvedValue({
      id: 'p1',
      name: 'Refrigerante Lata',
      price: 6,
      addon_groups: [
        {
          id: 'g1',
          name: 'Sabor',
          selection_type: 'single',
          is_required: false,
          position: 0,
          options: [{ id: 'o-coca', name: 'Coca cola', price_delta: 0, group_id: 'g1' }],
        },
      ],
    })
    const { db, writes, getCart } = makeDb({
      cart: [{ product_id: 'p1', product_name: 'Refrigerante Lata', unit_price: 6, quantity: 1, addons: [], notes: null }],
    })
    const res = await addToCartTool.execute(
      { product_id: 'p1', quantity: 1, addon_option_ids: ['o-coca'], attach_note_to_existing: true },
      ctxFor(db),
    )
    expect(getCart()).toHaveLength(1)
    expect(getCart()[0]).toMatchObject({
      product_id: 'p1',
      quantity: 1,
      addons: [{ group_id: 'g1', group_name: 'Sabor', option_id: 'o-coca', option_name: 'Coca cola', price_delta: 0 }],
      notes: null, // untouched by this merge — must not be corrupted by it
    })
    expect(writes[0]).toHaveLength(1)
    expect(res.content).toMatch(/updated the existing 1x refrigerante lata/i)
    expect(res.content).not.toMatch(/added 1x refrigerante lata to the cart/i)
  })

  it('does NOT auto-merge an addon into a bare line without attach_note_to_existing', async () => {
    h.loadProductWithAddonGroups.mockResolvedValue({
      id: 'p1',
      name: 'Refrigerante Lata',
      price: 6,
      addon_groups: [
        {
          id: 'g1',
          name: 'Sabor',
          selection_type: 'single',
          is_required: false,
          position: 0,
          options: [{ id: 'o-coca', name: 'Coca cola', price_delta: 0, group_id: 'g1' }],
        },
      ],
    })
    const { db, writes, getCart } = makeDb({
      cart: [{ product_id: 'p1', product_name: 'Refrigerante Lata', unit_price: 6, quantity: 1, addons: [], notes: null }],
    })
    const res = await addToCartTool.execute(
      { product_id: 'p1', quantity: 1, addon_option_ids: ['o-coca'] },
      ctxFor(db),
    )
    expect(getCart()).toHaveLength(2)
    expect(writes[0]).toHaveLength(2)
    expect(res.content).toMatch(/added 1x refrigerante lata to the cart/i)
  })

  it('does NOT auto-merge into a bare line without attach_note_to_existing — regression, 2026-08-27 (Fernanda Mendonça: 3 marmitas listed at once — plain, "sem macarrão", and a large — silently became only 2 lines because the "sem macarrão" call got merged into the plain one instead of becoming its own line)', async () => {
    h.loadProductWithAddonGroups.mockResolvedValue({
      id: 'p1',
      name: 'Marmita M',
      price: 25,
      addon_groups: [],
    })
    const { db, writes, getCart } = makeDb({
      cart: [{ product_id: 'p1', product_name: 'Marmita M', unit_price: 25, quantity: 1, addons: [], notes: null }],
    })
    // Same call as the 2026-08-07 case, but WITHOUT the explicit flag —
    // must default to a new line, not a merge, so the customer's 2nd
    // distinct marmita is never silently dropped.
    const res = await addToCartTool.execute(
      { product_id: 'p1', quantity: 1, notes: 'sem macarrão' },
      ctxFor(db),
    )
    expect(getCart()).toHaveLength(2)
    expect(getCart()[0]).toMatchObject({ product_id: 'p1', quantity: 1, notes: null })
    expect(getCart()[1]).toMatchObject({ product_id: 'p1', quantity: 1, notes: 'sem macarrão' })
    expect(writes[0]).toHaveLength(2)
    expect(res.content).toMatch(/added 1x marmita m to the cart/i)
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

describe('updateCartItemTool', () => {
  it('rejects an empty cart', async () => {
    const { db } = makeDb({ cart: [] })
    const res = await updateCartItemTool.execute({ line_number: 1, new_quantity: 1 }, ctxFor(db))
    expect(res.content).toMatch(/empty/i)
  })

  it('rejects a line_number out of range', async () => {
    const { db } = makeDb({
      cart: [{ product_id: 'p1', product_name: 'Marmita P', unit_price: 20, quantity: 2, addons: [] }],
    })
    const res = await updateCartItemTool.execute({ line_number: 5, new_quantity: 1 }, ctxFor(db))
    expect(res.content).toMatch(/no line 5/i)
  })

  it('rejects an invalid line_number or new_quantity without touching the cart', async () => {
    const { db, writes } = makeDb({
      cart: [{ product_id: 'p1', product_name: 'Marmita P', unit_price: 20, quantity: 2, addons: [] }],
    })
    const res1 = await updateCartItemTool.execute({ line_number: 0, new_quantity: 1 }, ctxFor(db))
    expect(res1.content).toMatch(/invalid line_number/i)
    const res2 = await updateCartItemTool.execute({ line_number: 1, new_quantity: -1 }, ctxFor(db))
    expect(res2.content).toMatch(/invalid new_quantity/i)
    expect(writes).toHaveLength(0)
  })

  it('reduces a line to a lower quantity — regression, 2026-08-20 (Concórdia, Fabiane: cart mistakenly showed 2 marmitas, customer confirmed she wanted only 1, but the model had no tool to actually make that change)', async () => {
    const { db, writes } = makeDb({
      cart: [{ product_id: 'p1', product_name: 'Marmita P', unit_price: 20, quantity: 2, addons: [], notes: 'tradicional' }],
    })
    const res = await updateCartItemTool.execute({ line_number: 1, new_quantity: 1 }, ctxFor(db))
    expect(writes).toHaveLength(1)
    expect(writes[0]).toEqual([
      { product_id: 'p1', product_name: 'Marmita P', unit_price: 20, quantity: 1, addons: [], notes: 'tradicional' },
    ])
    expect(res.content).toMatch(/updated line 1.*1x/i)
  })

  it('removes the line entirely when new_quantity is 0', async () => {
    const { db, writes } = makeDb({
      cart: [
        { product_id: 'p1', product_name: 'Marmita P', unit_price: 20, quantity: 1, addons: [] },
        { product_id: 'p2', product_name: 'Coca 2L', unit_price: 12, quantity: 1, addons: [] },
      ],
    })
    const res = await updateCartItemTool.execute({ line_number: 1, new_quantity: 0 }, ctxFor(db))
    expect(writes).toHaveLength(1)
    expect(writes[0]).toEqual([{ product_id: 'p2', product_name: 'Coca 2L', unit_price: 12, quantity: 1, addons: [] }])
    expect(res.content).toMatch(/removed 1x marmita p/i)
  })

  it('targets the correct line by position when the same product sits on two different lines — the exact ambiguity a product_id-only tool could not resolve', async () => {
    const { db, writes } = makeDb({
      cart: [
        { product_id: 'p1', product_name: 'Marmita P', unit_price: 20, quantity: 1, addons: [], notes: 'sem cebola' },
        { product_id: 'p1', product_name: 'Marmita P', unit_price: 20, quantity: 1, addons: [], notes: 'com ovo' },
      ],
    })
    const res = await updateCartItemTool.execute({ line_number: 2, new_quantity: 0 }, ctxFor(db))
    expect(writes[0]).toEqual([
      { product_id: 'p1', product_name: 'Marmita P', unit_price: 20, quantity: 1, addons: [], notes: 'sem cebola' },
    ])
    expect(res.content).toMatch(/removed 1x marmita p/i)
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

  it('includes the captured payment method in the placed-order payload — regression, 2026-08-09', async () => {
    // Lets the deterministic order-confirmation message (auto-reply.ts)
    // decide whether to append the account's Pix key, without depending
    // on the model to remember to relay it.
    h.finalizeDeliveryOrder.mockResolvedValue({ id: 'order-9', total: 30, currency: 'BRL' })
    const { db } = makeDb({
      cart: [{ product_id: 'p1', product_name: 'Pizza', unit_price: 30, quantity: 1, addons: [] }],
      orderInfo: { paymentMethod: 'Pix' },
    })
    const res = await placeOrderTool.execute({ delivery_address: 'Rua X, 123' }, ctxFor(db))
    expect(res.data).toMatchObject({ paymentMethod: 'Pix' })
  })

  it('places a payment method of null when the customer never said how they\'re paying', async () => {
    h.finalizeDeliveryOrder.mockResolvedValue({ id: 'order-10', total: 30, currency: 'BRL' })
    const { db } = makeDb({
      cart: [{ product_id: 'p1', product_name: 'Pizza', unit_price: 30, quantity: 1, addons: [] }],
    })
    const res = await placeOrderTool.execute({ delivery_address: 'Rua X, 123' }, ctxFor(db))
    expect(res.data).toMatchObject({ paymentMethod: null })
  })

  it('passes the captured payment method/notes through to finalizeDeliveryOrder so it lands on the order itself', async () => {
    h.finalizeDeliveryOrder.mockResolvedValue({ id: 'order-11', total: 30, currency: 'BRL' })
    const { db } = makeDb({
      cart: [{ product_id: 'p1', product_name: 'Pizza', unit_price: 30, quantity: 1, addons: [] }],
      orderInfo: { paymentMethod: 'Pix', paymentNotes: 'troco para R$100' },
    })
    await placeOrderTool.execute({ delivery_address: 'Rua X, 123' }, ctxFor(db))
    expect(h.finalizeDeliveryOrder).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ paymentMethod: 'Pix', paymentNotes: 'troco para R$100' }),
    )
  })

  it('records lastPlacedOrderId/lastPlacedOrderTotal so a later correction can find and cancel it — regression, 2026-08-13 duplicate-order incident', async () => {
    h.finalizeDeliveryOrder.mockResolvedValue({ id: 'order-12', total: 95, currency: 'BRL' })
    const { db, getOrderInfo } = makeDb({
      cart: [{ product_id: 'p1', product_name: 'Marmita P', unit_price: 95, quantity: 1, addons: [] }],
    })
    await placeOrderTool.execute({ delivery_address: 'Rua X, 123' }, ctxFor(db))
    expect(getOrderInfo()).toMatchObject({ lastPlacedOrderId: 'order-12', lastPlacedOrderTotal: 95 })
  })

  it('refuses a second place_order when an order was already placed this conversation — regression, 2026-08-31/2026-09-03 (Rogério, Rafael/Matheus, Iliane — three live duplicate-order incidents, always minutes apart, never a race)', async () => {
    const { db } = makeDb({
      cart: [{ product_id: 'p1', product_name: 'Marmita P', unit_price: 20, quantity: 1, addons: [] }],
      orderInfo: { lastPlacedOrderId: 'order-1', lastPlacedOrderTotal: 20 },
    })
    const res = await placeOrderTool.execute({ delivery_address: 'Rua X, 123' }, ctxFor(db))
    expect(h.finalizeDeliveryOrder).not.toHaveBeenCalled()
    expect(res.content).toContain('order-1')
    expect(res.content).toContain('cancel_order')
    expect(res.content).toContain('confirm_separate_order')
  })

  it('allows a genuinely separate second order when the model explicitly confirms it', async () => {
    h.finalizeDeliveryOrder.mockResolvedValue({ id: 'order-2', total: 20, currency: 'BRL' })
    const { db } = makeDb({
      cart: [{ product_id: 'p1', product_name: 'Marmita P', unit_price: 20, quantity: 1, addons: [] }],
      orderInfo: { lastPlacedOrderId: 'order-1', lastPlacedOrderTotal: 20 },
    })
    const res = await placeOrderTool.execute(
      { delivery_address: 'Rua X, 123', confirm_separate_order: true },
      ctxFor(db),
    )
    expect(h.finalizeDeliveryOrder).toHaveBeenCalled()
    expect(res.data).toMatchObject({ id: 'order-2' })
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

  it('falls back to name/address/is_pickup already recorded via update_order_info when the model omits them — regression, 2026-08-07', async () => {
    // The model doesn't always re-pass something it already told the
    // customer earlier in the conversation — without this fallback that
    // info was silently lost right at the one step that most needed it.
    h.finalizeDeliveryOrder.mockResolvedValue({ id: 'order-5', total: 30, currency: 'BRL' })
    const { db } = makeDb({
      cart,
      businessHours: null,
      orderInfo: { customerName: 'Marcia', deliveryAddress: 'Rua Presidente Kennedy 183, Centro', isPickup: false },
    })
    const res = await placeOrderTool.execute({}, ctxFor(db))
    expect(h.finalizeDeliveryOrder).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        customerName: 'Marcia',
        deliveryAddress: 'Rua Presidente Kennedy 183, Centro',
      }),
    )
    expect(res.data).toMatchObject({ id: 'order-5' })
  })

  it('an explicit arg overrides what was previously recorded — the customer may have changed their mind', async () => {
    h.finalizeDeliveryOrder.mockResolvedValue({ id: 'order-6', total: 30, currency: 'BRL' })
    const { db } = makeDb({
      cart,
      businessHours: null,
      orderInfo: { customerName: 'Marcia', deliveryAddress: 'Old address', isPickup: false },
    })
    await placeOrderTool.execute({ customer_name: 'Rodrigo', delivery_address: 'New address' }, ctxFor(db))
    expect(h.finalizeDeliveryOrder).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ customerName: 'Rodrigo', deliveryAddress: 'New address' }),
    )
  })

  it('clears the stale fee quote after placing, but keeps durable customer facts', async () => {
    // The quote is tied to the cart that just got cleared — carrying it
    // forward would show a stale total for whatever this customer
    // orders next. Name/address/payment method are still true, though.
    h.finalizeDeliveryOrder.mockResolvedValue({ id: 'order-7', total: 30, currency: 'BRL' })
    const { db, getOrderInfo } = makeDb({
      cart,
      businessHours: null,
      orderInfo: {
        customerName: 'Marcia',
        deliveryAddress: 'Rua X, 123',
        isPickup: false,
        lastFeeQuote: { subtotal: 30, fee: 5, total: 35, address: 'Rua X, 123', resolvedAddress: null, quotedAt: '2026-08-07T12:00:00.000Z' },
      },
    })
    await placeOrderTool.execute({}, ctxFor(db))
    expect(getOrderInfo()).toMatchObject({ customerName: 'Marcia', deliveryAddress: 'Rua X, 123', lastFeeQuote: null })
  })

  it("reuses the confirmed neighborhood for its own mandatory fee recheck when the address is unchanged — regression, 2026-08-07", async () => {
    // Live incident: a customer shared an exact WhatsApp location pin,
    // calculate_delivery_fee used it and quoted R$9 delivery — but
    // place_order's own "never trust a stale number" recalculation
    // only passed the free-text address, re-geocoding it to a LESS
    // precise point and charging R$12 for the identical order. This is
    // the same fix's neighborhood-method case (network-free to test
    // here; the location/coordinate case follows the identical
    // sameAddressAsLastQuote branch in placeOrderTool).
    h.finalizeDeliveryOrder.mockResolvedValue({ id: 'order-8', total: 23, delivery_fee: 3, currency: 'BRL' })
    const { db } = makeDb({
      cart: [{ product_id: 'p1', product_name: 'Marmita P', unit_price: 20, quantity: 1, addons: [] }],
      businessHours: null,
      orderInfo: { deliveryAddress: 'Rua X, 123', neighborhood: 'Centro' },
      feeConfig: {
        delivery_method: 'neighborhood',
        max_distance: null,
        free_shipping_above: null,
        origin_lat: null,
        origin_lng: null,
        settings: { neighborhoods: [{ id: 'n1', name: 'Centro', price: 3 }] },
      },
    })
    const res = await placeOrderTool.execute({ delivery_address: 'Rua X, 123' }, ctxFor(db))
    expect(h.finalizeDeliveryOrder).toHaveBeenCalledWith(db, expect.objectContaining({ deliveryFee: 3 }))
    expect(res.data).toMatchObject({ id: 'order-8', deliveryFee: 3 })
  })

  it('stores a tappable Google Maps link when the customer only ever shared a location pin, never a text address', async () => {
    // A driver can't navigate off nothing on the printed ticket — this
    // is the pin-only path with no update_order_info/calculate_delivery_fee
    // call ever having recorded a text address either.
    h.finalizeDeliveryOrder.mockResolvedValue({ id: 'order-9', total: 25, currency: 'BRL' })
    const { db } = makeDb({
      cart: [{ product_id: 'p1', product_name: 'Marmita M', unit_price: 25, quantity: 1, addons: [] }],
      businessHours: null,
      feeConfig: { delivery_method: 'fixed', max_distance: null, free_shipping_above: null, origin_lat: null, origin_lng: null, settings: { fixed_price: 0 } },
      lastCustomerMessage: { content_type: 'location', content_text: '-24.9532935,-53.4699534' },
    })
    const res = await placeOrderTool.execute({}, ctxFor(db))
    expect(h.finalizeDeliveryOrder).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        deliveryAddress: 'https://www.google.com/maps?q=-24.9532935,-53.4699534',
      }),
    )
    expect(res.data).toMatchObject({ id: 'order-9' })
  })

  it('a text delivery_address always wins over an auto-detected pin, even when the customer just shared one', async () => {
    h.finalizeDeliveryOrder.mockResolvedValue({ id: 'order-10', total: 25, currency: 'BRL' })
    const { db } = makeDb({
      cart: [{ product_id: 'p1', product_name: 'Marmita M', unit_price: 25, quantity: 1, addons: [] }],
      businessHours: null,
      feeConfig: { delivery_method: 'fixed', max_distance: null, free_shipping_above: null, origin_lat: null, origin_lng: null, settings: { fixed_price: 0 } },
      lastCustomerMessage: { content_type: 'location', content_text: '-24.9532935,-53.4699534' },
    })
    await placeOrderTool.execute({ delivery_address: 'Rua X, 123' }, ctxFor(db))
    expect(h.finalizeDeliveryOrder).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ deliveryAddress: 'Rua X, 123' }),
    )
  })
})

describe('updateOrderInfoTool', () => {
  it('records only the fields passed, leaving the rest untouched', async () => {
    const { db, getOrderInfo } = makeDb({ orderInfo: { customerName: 'Marcia' } })
    const res = await updateOrderInfoTool.execute({ delivery_address: 'Rua X, 123', neighborhood: 'Centro' }, ctxFor(db))
    expect(getOrderInfo()).toMatchObject({
      customerName: 'Marcia',
      deliveryAddress: 'Rua X, 123',
      neighborhood: 'Centro',
    })
    expect(res.content).toMatch(/noted/i)
  })

  it('records is_pickup: false correctly — not just truthy/falsy on the field being present', async () => {
    const { db, getOrderInfo } = makeDb({})
    await updateOrderInfoTool.execute({ is_pickup: false }, ctxFor(db))
    expect(getOrderInfo()).toMatchObject({ isPickup: false })
  })

  it('rejects a call with no fields at all rather than silently no-op writing', async () => {
    const { db, orderInfoWrites } = makeDb({})
    const res = await updateOrderInfoTool.execute({}, ctxFor(db))
    expect(res.content).toMatch(/nothing to update/i)
    expect(orderInfoWrites).toHaveLength(0)
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

  it('persists the exact coordinates into order state so place_order can reuse them later — regression, 2026-08-07', async () => {
    const { db, getOrderInfo } = makeDb({
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
    await calculateDeliveryFeeTool.execute(
      { latitude: -24.9532935, longitude: -53.4699534, neighborhood: 'Centro' },
      ctxFor(db),
    )
    expect((getOrderInfo() as { location: { lat: number; lng: number } }).location).toEqual({
      lat: -24.9532935,
      lng: -53.4699534,
    })
  })

  it('clears any previously stored location when this call is address-only — a stale pin must never survive to a different address', async () => {
    const { db, getOrderInfo } = makeDb({
      cart: [],
      orderInfo: { location: { lat: -24.95, lng: -53.47 } },
      feeConfig: { delivery_method: 'fixed', max_distance: null, free_shipping_above: null, origin_lat: null, origin_lng: null, settings: { fixed_price: 5 } },
    })
    await calculateDeliveryFeeTool.execute({ address: 'Rua Nova, 456' }, ctxFor(db))
    expect((getOrderInfo() as { location: unknown }).location).toBeNull()
  })

  it('rejects when neither address nor latitude/longitude are given', async () => {
    const { db } = makeDb({ cart: [] })
    const res = await calculateDeliveryFeeTool.execute({}, ctxFor(db))
    expect(res.content).toMatch(/missing address/i)
  })

  it('persists the address, neighborhood, and fee quote into order state on success — regression, 2026-08-07', async () => {
    // So the NEXT turn's injected order-state summary already shows
    // this quote, instead of the model having to remember it said this
    // or recalculate just to relay the same number in the order
    // summary. See order-state.ts.
    const { db, getOrderInfo } = makeDb({
      cart: [],
      feeConfig: {
        delivery_method: 'neighborhood',
        max_distance: null,
        free_shipping_above: null,
        origin_lat: null,
        origin_lng: null,
        settings: { neighborhoods: [{ id: 'n1', name: 'Centro', price: 3 }] },
      },
    })
    await calculateDeliveryFeeTool.execute(
      { address: 'Rua Presidente Kennedy 183, Centro', neighborhood: 'Centro' },
      ctxFor(db),
    )
    const info = getOrderInfo() as {
      deliveryAddress: string
      neighborhood: string
      lastFeeQuote: { fee: number; total: number; address: string }
    }
    expect(info.deliveryAddress).toBe('Rua Presidente Kennedy 183, Centro')
    expect(info.neighborhood).toBe('Centro')
    expect(info.lastFeeQuote).toMatchObject({ fee: 3, total: 3, address: 'Rua Presidente Kennedy 183, Centro' })
  })

  it('does not overwrite a previously known neighborhood when this call only gave an address', async () => {
    const { db, getOrderInfo } = makeDb({
      cart: [],
      orderInfo: { neighborhood: 'Centro' },
      feeConfig: { delivery_method: 'fixed', max_distance: null, free_shipping_above: null, origin_lat: null, origin_lng: null, settings: { fixed_price: 5 } },
    })
    await calculateDeliveryFeeTool.execute({ address: 'Rua X, 123' }, ctxFor(db))
    expect((getOrderInfo() as { neighborhood: string }).neighborhood).toBe('Centro')
  })

  it('auto-detects a just-shared WhatsApp location pin when neither address nor lat/lng are given', async () => {
    // The model has no memory of its own tool calls and can fail to
    // notice/parse the reformatted "[Customer shared their location]"
    // transcript line — this is the deterministic fallback for that,
    // network-free the same way the explicit lat/lng test above is.
    const { db, getOrderInfo } = makeDb({
      cart: [],
      feeConfig: {
        delivery_method: 'neighborhood',
        max_distance: null,
        free_shipping_above: null,
        origin_lat: null,
        origin_lng: null,
        settings: { neighborhoods: [{ id: 'n1', name: 'Centro', price: 5 }] },
      },
      lastCustomerMessage: { content_type: 'location', content_text: '-24.9532935,-53.4699534' },
    })
    const res = await calculateDeliveryFeeTool.execute({ neighborhood: 'Centro' }, ctxFor(db))
    expect(res.content).toMatch(/5/)
    expect(res.content).not.toMatch(/missing address/i)
    expect((getOrderInfo() as { location: { lat: number; lng: number } }).location).toEqual({
      lat: -24.9532935,
      lng: -53.4699534,
    })
  })

  it('does not auto-detect when the customer\'s last message was text, not a location', async () => {
    const { db } = makeDb({
      cart: [],
      lastCustomerMessage: { content_type: 'text', content_text: 'oi, quero fazer um pedido' },
    })
    const res = await calculateDeliveryFeeTool.execute({}, ctxFor(db))
    expect(res.content).toMatch(/missing address/i)
  })

  it('an explicit address always wins over an auto-detected pin, even when the customer just shared one', async () => {
    const { db } = makeDb({
      cart: [],
      feeConfig: { delivery_method: 'fixed', max_distance: null, free_shipping_above: null, origin_lat: null, origin_lng: null, settings: { fixed_price: 5 } },
      lastCustomerMessage: { content_type: 'location', content_text: '-24.9532935,-53.4699534' },
    })
    const res = await calculateDeliveryFeeTool.execute({ address: 'Rua X, 123' }, ctxFor(db))
    expect(res.content).toMatch(/5/)
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

  it('returns all nine tools for live chat once tools_enabled is on', () => {
    const tools = getAvailableTools({
      accountHasDeliveryModule: true,
      toolsEnabled: true,
      allowSideEffects: true,
    })
    expect(tools.map((t) => t.name).sort()).toEqual([
      'add_to_cart',
      'calculate_delivery_fee',
      'cancel_order',
      'get_product_details',
      'place_order',
      'search_menu',
      'update_cart_item',
      'update_order_info',
      'view_cart',
    ])
  })
})

describe('cancelOrderTool', () => {
  it('does nothing when no order was placed this conversation', async () => {
    const { db } = makeDb({})
    const res = await cancelOrderTool.execute({}, ctxFor(db))
    expect(res.content).toMatch(/no order was placed/i)
  })

  it('cancels the order recorded as lastPlacedOrderId and clears it from order info', async () => {
    const { db, getOrderInfo, deliveryOrderUpdates } = makeDb({
      orderInfo: { lastPlacedOrderId: 'order-1', lastPlacedOrderTotal: 95 },
      deliveryOrders: [
        { id: 'order-1', account_id: 'acct-1', status: 'pending_confirmation', contact_id: 'contact-1', total: 95, currency: 'BRL' },
      ],
    })
    const res = await cancelOrderTool.execute({}, ctxFor(db))
    expect(res.content).toContain('order-1')
    expect(res.content).toContain('cancelled')
    expect(deliveryOrderUpdates).toEqual([expect.objectContaining({ id: 'order-1', status: 'cancelled' })])
    expect(getOrderInfo()).toMatchObject({ lastPlacedOrderId: null, lastPlacedOrderTotal: null })
  })

  it('dispatches the same webhook/automation a staff-initiated cancel fires', async () => {
    const { db } = makeDb({
      orderInfo: { lastPlacedOrderId: 'order-1' },
      deliveryOrders: [
        { id: 'order-1', account_id: 'acct-1', status: 'pending_confirmation', contact_id: 'contact-9', total: 95, currency: 'BRL' },
      ],
    })
    await cancelOrderTool.execute({}, ctxFor(db))
    expect(h.dispatchWebhookEvent).toHaveBeenCalledWith(
      db,
      'acct-1',
      'order.status_changed',
      expect.objectContaining({ order_id: 'order-1', previous_status: 'pending_confirmation', status: 'cancelled' }),
    )
    expect(h.runAutomationsForTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct-1', triggerType: 'order_status_changed', contactId: 'contact-9' }),
    )
  })

  it('is a no-op (still reports success) when the order is already cancelled', async () => {
    const { db, deliveryOrderUpdates } = makeDb({
      orderInfo: { lastPlacedOrderId: 'order-1' },
      deliveryOrders: [{ id: 'order-1', account_id: 'acct-1', status: 'cancelled', contact_id: 'c1', total: 10, currency: 'BRL' }],
    })
    const res = await cancelOrderTool.execute({}, ctxFor(db))
    expect(res.content).toMatch(/already cancelled/i)
    expect(deliveryOrderUpdates).toEqual([])
  })

  it('refuses to auto-cancel an order that is already out for delivery or delivered', async () => {
    const { db, deliveryOrderUpdates } = makeDb({
      orderInfo: { lastPlacedOrderId: 'order-1' },
      deliveryOrders: [{ id: 'order-1', account_id: 'acct-1', status: 'out_for_delivery', contact_id: 'c1', total: 10, currency: 'BRL' }],
    })
    const res = await cancelOrderTool.execute({}, ctxFor(db))
    expect(res.content).toMatch(/too late to cancel/i)
    expect(res.content).toMatch(/human/i)
    expect(deliveryOrderUpdates).toEqual([])
  })

  it('clears the stale pointer and reports gracefully when the referenced order row no longer exists', async () => {
    const { db, getOrderInfo } = makeDb({
      orderInfo: { lastPlacedOrderId: 'order-deleted', lastPlacedOrderTotal: 10 },
      deliveryOrders: [],
    })
    const res = await cancelOrderTool.execute({}, ctxFor(db))
    expect(res.content).toMatch(/no longer exists/i)
    expect(getOrderInfo()).toMatchObject({ lastPlacedOrderId: null, lastPlacedOrderTotal: null })
  })
})
