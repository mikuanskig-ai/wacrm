import { describe, expect, it, vi } from 'vitest'
import { loadDeliveryFunnel } from './delivery-funnel'
import type { SupabaseClient } from '@supabase/supabase-js'

function makeDb(row: Record<string, unknown> | null, error: unknown = null) {
  const rpc = vi.fn().mockReturnValue({ single: () => Promise.resolve({ data: row, error }) })
  return { rpc } as unknown as SupabaseClient & { rpc: typeof rpc }
}

describe('loadDeliveryFunnel', () => {
  it('maps snake_case columns (bigint-as-string) to numeric camelCase', async () => {
    const db = makeDb({
      new_contacts: '12',
      ordering_customers: '9',
      returning_customers: '4',
      loyal_customers: '2',
      unattributed_orders: '3',
    })
    const result = await loadDeliveryFunnel(db, 'acc-1', {
      from: new Date('2026-08-01'),
      to: new Date('2026-08-31'),
    })
    expect(result).toEqual({
      newContacts: 12,
      orderingCustomers: 9,
      returningCustomers: 4,
      loyalCustomers: 2,
      unattributedOrders: 3,
    })
  })

  it('calls the RPC with p_account_id/p_from/p_to as ISO strings', async () => {
    const db = makeDb({
      new_contacts: 0,
      ordering_customers: 0,
      returning_customers: 0,
      loyal_customers: 0,
      unattributed_orders: 0,
    })
    const from = new Date('2026-08-01T00:00:00.000Z')
    const to = new Date('2026-08-31T23:59:59.999Z')
    await loadDeliveryFunnel(db, 'acc-1', { from, to })
    expect(db.rpc).toHaveBeenCalledWith('delivery_customer_funnel', {
      p_account_id: 'acc-1',
      p_from: from.toISOString(),
      p_to: to.toISOString(),
    })
  })

  it('propagates an error when the RPC fails', async () => {
    const db = makeDb(null, new Error('boom'))
    await expect(
      loadDeliveryFunnel(db, 'acc-1', { from: new Date(), to: new Date() }),
    ).rejects.toThrow('boom')
  })
})
