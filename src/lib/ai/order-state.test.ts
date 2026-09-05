import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CartLineItem } from '@/lib/delivery/create-order'
import {
  readOrderInfo,
  writeOrderInfo,
  clearStaleFeeQuote,
  buildOrderStateSummary,
  isLastPlacedOrderStale,
  STALE_LAST_PLACED_ORDER_MS,
  type OrderInfo,
} from './order-state'

function fakeDb(row: { ai_cart?: unknown; ai_order_info?: unknown }) {
  let current = { ai_cart: row.ai_cart, ai_order_info: row.ai_order_info }
  const updates: Record<string, unknown>[] = []
  const db = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: current, error: null }),
        }),
      }),
      update: (payload: Record<string, unknown>) => {
        current = { ...current, ...payload }
        updates.push(payload)
        return { eq: () => Promise.resolve({ error: null }) }
      },
    }),
  } as unknown as SupabaseClient
  return { db, updates, getCurrent: () => current }
}

describe('readOrderInfo', () => {
  it('returns all-null defaults when the column is empty ({})', async () => {
    const { db } = fakeDb({ ai_order_info: {} })
    expect(await readOrderInfo(db, 'conv-1')).toEqual({
      customerName: null,
      isPickup: null,
      deliveryAddress: null,
      neighborhood: null,
      location: null,
      paymentMethod: null,
      paymentNotes: null,
      lastFeeQuote: null,
      lastPlacedOrderId: null,
      lastPlacedOrderTotal: null,
      lastPlacedOrderAt: null,
    })
  })

  it('returns defaults when the column is malformed (not an object) — same discipline as readCart', async () => {
    // A jsonb column can hold ANY JSON value — a string, a number, an
    // array — never trust it's the shape the app wrote without a guard.
    const { db } = fakeDb({ ai_order_info: '[]' })
    expect((await readOrderInfo(db, 'conv-1')).customerName).toBeNull()
  })

  it('returns defaults when the row itself has no ai_order_info at all', async () => {
    const { db } = fakeDb({})
    expect((await readOrderInfo(db, 'conv-1')).customerName).toBeNull()
  })

  it('merges a partial stored object over the defaults', async () => {
    const { db } = fakeDb({ ai_order_info: { customerName: 'Marcia' } })
    const info = await readOrderInfo(db, 'conv-1')
    expect(info.customerName).toBe('Marcia')
    expect(info.deliveryAddress).toBeNull()
  })
})

describe('writeOrderInfo', () => {
  it('merges a patch into the existing stored value, leaving other fields untouched', async () => {
    const { db, getCurrent } = fakeDb({ ai_order_info: { customerName: 'Marcia' } })
    const merged = await writeOrderInfo(db, 'conv-1', { deliveryAddress: 'Rua X, 123' })
    expect(merged).toMatchObject({ customerName: 'Marcia', deliveryAddress: 'Rua X, 123' })
    expect((getCurrent().ai_order_info as OrderInfo).customerName).toBe('Marcia')
  })

  it('an explicit null clears a field, while an omitted (undefined) field leaves it alone', async () => {
    const { db } = fakeDb({ ai_order_info: { customerName: 'Marcia', neighborhood: 'Centro' } })
    const merged = await writeOrderInfo(db, 'conv-1', { customerName: null })
    expect(merged.customerName).toBeNull()
    expect(merged.neighborhood).toBe('Centro') // untouched
  })
})

describe('clearStaleFeeQuote', () => {
  it('clears only lastFeeQuote, keeping every other durable fact', async () => {
    const { db, getCurrent } = fakeDb({
      ai_order_info: {
        customerName: 'Marcia',
        deliveryAddress: 'Rua X, 123',
        lastFeeQuote: { subtotal: 20, fee: 3, total: 23, address: 'Rua X, 123', resolvedAddress: null, quotedAt: 'now' },
      },
    })
    await clearStaleFeeQuote(db, 'conv-1')
    const info = getCurrent().ai_order_info as OrderInfo
    expect(info.lastFeeQuote).toBeNull()
    expect(info.customerName).toBe('Marcia')
    expect(info.deliveryAddress).toBe('Rua X, 123')
  })
})

describe('buildOrderStateSummary', () => {
  it('returns null when there is nothing to show yet', async () => {
    const { db } = fakeDb({ ai_cart: [], ai_order_info: {} })
    expect(await buildOrderStateSummary(db, 'conv-1', 'BRL')).toBeNull()
  })

  it('formats the cart with subtotal, addons, and notes', async () => {
    const cart: CartLineItem[] = [
      {
        product_id: 'p1',
        product_name: 'Marmita P',
        unit_price: 20,
        quantity: 1,
        addons: [],
        notes: 'sem carne, com ovo frito',
      },
    ]
    const { db } = fakeDb({ ai_cart: cart, ai_order_info: {} })
    const summary = await buildOrderStateSummary(db, 'conv-1', 'BRL')
    expect(summary).toContain('1x Marmita P')
    expect(summary).toContain('sem carne, com ovo frito')
    expect(summary).toMatch(/subtotal.*20/i)
  })

  it('includes every known order-info field', async () => {
    const { db } = fakeDb({
      ai_cart: [],
      ai_order_info: {
        customerName: 'Marcia',
        isPickup: false,
        deliveryAddress: 'Rua X, 123',
        neighborhood: 'Centro',
        paymentMethod: 'dinheiro',
        paymentNotes: 'troco para R$100',
      },
    })
    const summary = await buildOrderStateSummary(db, 'conv-1', 'BRL')
    expect(summary).toContain('Marcia')
    expect(summary).toContain('Rua X, 123')
    expect(summary).toContain('Centro')
    expect(summary).toContain('dinheiro')
    expect(summary).toContain('troco para R$100')
    expect(summary).toMatch(/delivery/i)
  })

  it('flags a fee quote as STALE when the address on file has since changed', async () => {
    const { db } = fakeDb({
      ai_cart: [],
      ai_order_info: {
        deliveryAddress: 'Rua Nova, 456',
        lastFeeQuote: {
          subtotal: 20,
          fee: 3,
          total: 23,
          address: 'Rua Velha, 123',
          resolvedAddress: null,
          quotedAt: '2026-08-07T12:00:00.000Z',
        },
      },
    })
    const summary = await buildOrderStateSummary(db, 'conv-1', 'BRL')
    expect(summary).toMatch(/STALE/)
  })

  it('does not flag a fee quote as stale when the address matches', async () => {
    const { db } = fakeDb({
      ai_cart: [],
      ai_order_info: {
        deliveryAddress: 'Rua X, 123',
        lastFeeQuote: {
          subtotal: 20,
          fee: 3,
          total: 23,
          address: 'Rua X, 123',
          resolvedAddress: null,
          quotedAt: '2026-08-07T12:00:00.000Z',
        },
      },
    })
    const summary = await buildOrderStateSummary(db, 'conv-1', 'BRL')
    expect(summary).not.toMatch(/STALE/)
  })

  // Regression, 2026-08-13: a customer corrected their quantity right
  // after place_order — with nothing telling the model an order already
  // existed this conversation, it placed a SECOND order instead of
  // cancelling the first, so the kitchen got two separate tickets
  // (R$95 and R$55) for what should have been one. This line + the
  // cancel_order tool (tools/delivery.ts) close that gap.
  it('surfaces an already-placed order with an explicit cancel-before-reordering instruction', async () => {
    const { db } = fakeDb({
      ai_cart: [],
      ai_order_info: {
        lastPlacedOrderId: 'order-1',
        lastPlacedOrderTotal: 95,
        lastPlacedOrderAt: new Date().toISOString(), // fresh — well inside the staleness window
      },
    })
    const summary = await buildOrderStateSummary(db, 'conv-1', 'BRL')
    expect(summary).toContain('ALREADY PLACED')
    expect(summary).toContain('order-1')
    expect(summary).toMatch(/R\$\s?95/)
    expect(summary).toMatch(/cancel_order/)
  })

  it('omits the already-placed-order line once lastPlacedOrderId is cleared', async () => {
    const { db } = fakeDb({
      ai_cart: [{ product_id: 'p1', product_name: 'Marmita P', unit_price: 20, quantity: 1, addons: [] }],
      ai_order_info: { lastPlacedOrderId: null },
    })
    const summary = await buildOrderStateSummary(db, 'conv-1', 'BRL')
    expect(summary).not.toContain('ALREADY PLACED')
  })

  it('omits the already-placed-order line when it is stale — regression, 2026-09-05 (Davi Santos, Concórdia: an order placed 2026-08-29 was still "ALREADY PLACED" a week later, and the model dutifully cancelled it before the customer\'s brand new order, even though nothing in the transcript ever mentioned it)', async () => {
    const { db } = fakeDb({
      ai_cart: [],
      ai_order_info: {
        lastPlacedOrderId: 'order-old',
        lastPlacedOrderTotal: 58,
        lastPlacedOrderAt: '2026-08-29T15:46:09.799Z', // days before "now"
      },
    })
    const summary = await buildOrderStateSummary(db, 'conv-1', 'BRL')
    // Empty cart + no other durable fact + a suppressed stale line means
    // there is genuinely nothing left to show — same "nothing yet" null
    // as the very first test in this describe block.
    expect(summary).toBeNull()
  })

  it('treats a missing lastPlacedOrderAt (rows written before this field existed) as stale too — same defensive default as isStaleCartLine\'s missing addedAt', async () => {
    const { db } = fakeDb({
      ai_cart: [],
      ai_order_info: { lastPlacedOrderId: 'order-legacy', lastPlacedOrderTotal: 58 }, // no lastPlacedOrderAt at all
    })
    const summary = await buildOrderStateSummary(db, 'conv-1', 'BRL')
    expect(summary).toBeNull()
  })
})

describe('isLastPlacedOrderStale', () => {
  const EMPTY_INFO: OrderInfo = {
    customerName: null,
    isPickup: null,
    deliveryAddress: null,
    neighborhood: null,
    location: null,
    paymentMethod: null,
    paymentNotes: null,
    lastFeeQuote: null,
    lastPlacedOrderId: null,
    lastPlacedOrderTotal: null,
    lastPlacedOrderAt: null,
  }

  it('is false when there is no lastPlacedOrderId at all — nothing to be stale about', () => {
    const info: OrderInfo = { ...EMPTY_INFO }
    expect(isLastPlacedOrderStale(info, new Date().toISOString())).toBe(false)
  })

  it('is false for a fresh lastPlacedOrderAt, well inside the staleness window', () => {
    const now = Date.now()
    const info: OrderInfo = {
      ...EMPTY_INFO,
      lastPlacedOrderId: 'order-1',
      lastPlacedOrderAt: new Date(now - 60_000).toISOString(),
    }
    expect(isLastPlacedOrderStale(info, new Date(now).toISOString())).toBe(false)
  })

  it('is true once lastPlacedOrderAt is older than STALE_LAST_PLACED_ORDER_MS', () => {
    const now = Date.now()
    const info: OrderInfo = {
      ...EMPTY_INFO,
      lastPlacedOrderId: 'order-1',
      lastPlacedOrderAt: new Date(now - STALE_LAST_PLACED_ORDER_MS - 1000).toISOString(),
    }
    expect(isLastPlacedOrderStale(info, new Date(now).toISOString())).toBe(true)
  })

  it('is true when lastPlacedOrderAt is missing — unknown age is never treated as safe', () => {
    const info: OrderInfo = { ...EMPTY_INFO, lastPlacedOrderId: 'order-1', lastPlacedOrderAt: null }
    expect(isLastPlacedOrderStale(info, new Date().toISOString())).toBe(true)
  })
})
