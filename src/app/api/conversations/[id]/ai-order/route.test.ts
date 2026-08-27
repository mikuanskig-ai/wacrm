import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CartLineItem } from '@/lib/delivery/create-order'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  finalizeDeliveryOrder: vi.fn(),
  loadProductWithAddonGroups: vi.fn(),
  dispatchWebhookEvent: vi.fn(async () => {}),
  runAutomationsForTrigger: vi.fn(async () => {}),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn((err: unknown) => Response.json({ error: String(err) }, { status: 500 })),
}))
vi.mock('@/lib/flows/engine', () => ({
  loadProductWithAddonGroups: mocks.loadProductWithAddonGroups,
  getAccountCurrency: vi.fn(async () => 'BRL'),
}))
vi.mock('@/lib/delivery/create-order', async () => {
  const actual = await vi.importActual<typeof import('@/lib/delivery/create-order')>('@/lib/delivery/create-order')
  return { ...actual, finalizeDeliveryOrder: mocks.finalizeDeliveryOrder }
})
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: mocks.dispatchWebhookEvent }))
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: mocks.runAutomationsForTrigger }))

import { GET, POST } from './route'

function makeDb(opts: { cart?: CartLineItem[]; orderInfo?: Record<string, unknown>; contactId?: string | null } = {}) {
  let conv: Record<string, unknown> = {
    id: 'conv-1',
    contact_id: opts.contactId ?? 'contact-1',
    account_id: 'acct-1',
    ai_cart: opts.cart ?? [],
    ai_order_info: opts.orderInfo ?? {},
  }
  const updates: Record<string, unknown>[] = []

  const db = {
    from: (table: string) => {
      if (table === 'conversations') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: conv, error: null }),
          update: (payload: Record<string, unknown>) => {
            conv = { ...conv, ...payload }
            updates.push(payload)
            return { eq: () => Promise.resolve({ error: null }) }
          },
        }
        return chain
      }
      throw new Error(`unexpected table: ${table}`)
    },
  } as unknown as SupabaseClient

  return { db, getConv: () => conv, getUpdates: () => updates }
}

function req(path: string, payload?: unknown) {
  return new Request(`http://localhost${path}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  })
}

function params(id = 'conv-1') {
  return { params: Promise.resolve({ id }) }
}

const ITEM: CartLineItem = { product_id: 'p1', product_name: 'Marmita M', unit_price: 25, quantity: 1, addons: [] }

beforeEach(() => {
  mocks.requireRole.mockReset()
  mocks.finalizeDeliveryOrder.mockReset()
})

describe('GET /api/conversations/[id]/ai-order', () => {
  it('returns the pending cart and order info for review', async () => {
    const { db } = makeDb({ cart: [ITEM], orderInfo: { customerName: 'Fernanda', isPickup: true } })
    mocks.requireRole.mockResolvedValue({ supabase: db, accountId: 'acct-1', userId: 'user-1' })

    const res = await GET(req('/api/conversations/conv-1/ai-order'), params())
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.cart).toEqual([ITEM])
    expect(data.orderInfo).toMatchObject({ customerName: 'Fernanda', isPickup: true })
    expect(data.currency).toBe('BRL')
  })

  it('404s when the conversation does not belong to this account', async () => {
    const db = {
      from: () => ({
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }),
      }),
    } as unknown as SupabaseClient
    mocks.requireRole.mockResolvedValue({ supabase: db, accountId: 'acct-1', userId: 'user-1' })

    const res = await GET(req('/api/conversations/conv-x/ai-order'), params('conv-x'))
    expect(res.status).toBe(404)
  })
})

describe('POST /api/conversations/[id]/ai-order', () => {
  it('rejects an empty items array', async () => {
    const { db } = makeDb()
    mocks.requireRole.mockResolvedValue({ supabase: db, accountId: 'acct-1', userId: 'user-1' })

    const res = await POST(req('/api/conversations/conv-1/ai-order', { items: [] }), params())
    expect(res.status).toBe(400)
    expect(mocks.finalizeDeliveryOrder).not.toHaveBeenCalled()
  })

  it('rejects a malformed item', async () => {
    const { db } = makeDb()
    mocks.requireRole.mockResolvedValue({ supabase: db, accountId: 'acct-1', userId: 'user-1' })

    const res = await POST(
      req('/api/conversations/conv-1/ai-order', { items: [{ product_id: 'p1' }] }),
      params(),
    )
    expect(res.status).toBe(400)
  })

  it('creates the real order from the reviewed items, clears the cart, and records lastPlacedOrderId — this is what forces the print job (finalizeDeliveryOrder enqueues it unconditionally)', async () => {
    const { db, getConv } = makeDb({ cart: [ITEM], orderInfo: { customerName: 'Fernanda', isPickup: true, paymentMethod: 'cartão' } })
    mocks.requireRole.mockResolvedValue({ supabase: db, accountId: 'acct-1', userId: 'user-1' })
    mocks.finalizeDeliveryOrder.mockResolvedValue({ id: 'order-1', total: 25, currency: 'BRL' })

    const res = await POST(
      req('/api/conversations/conv-1/ai-order', {
        items: [ITEM],
        is_pickup: true,
        payment_method: 'cartão',
        customer_name: 'Fernanda',
      }),
      params(),
    )
    const data = await res.json()

    expect(res.status).toBe(201)
    expect(data.order).toEqual({ id: 'order-1', total: 25, currency: 'BRL' })
    expect(mocks.finalizeDeliveryOrder).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        accountId: 'acct-1',
        contactId: 'contact-1',
        conversationId: 'conv-1',
        source: 'manual',
        cart: [ITEM],
        deliveryAddress: null,
        paymentMethod: 'cartão',
        customerName: 'Fernanda',
      }),
    )
    expect(getConv().ai_cart).toEqual([])
    expect(getConv().ai_order_info).toMatchObject({ lastPlacedOrderId: 'order-1', lastPlacedOrderTotal: 25, lastFeeQuote: null })
  })

  it('passes the typed delivery_address through for a delivery (non-pickup) order', async () => {
    const { db } = makeDb({ cart: [ITEM] })
    mocks.requireRole.mockResolvedValue({ supabase: db, accountId: 'acct-1', userId: 'user-1' })
    mocks.finalizeDeliveryOrder.mockResolvedValue({ id: 'order-2', total: 37, currency: 'BRL' })

    await POST(
      req('/api/conversations/conv-1/ai-order', {
        items: [ITEM],
        is_pickup: false,
        delivery_address: 'Rua Souza Naves 3214',
        delivery_fee: 12,
      }),
      params(),
    )

    expect(mocks.finalizeDeliveryOrder).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ deliveryAddress: 'Rua Souza Naves 3214', deliveryFee: 12 }),
    )
  })
})
