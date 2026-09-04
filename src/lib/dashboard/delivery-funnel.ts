// Loader for the Delivery customer funnel widget (dashboard). Thin
// wrapper around the delivery_customer_funnel RPC (migration 076) —
// see that migration's header comment for why this is a SQL RPC
// rather than the client-side aggregation the rest of
// src/lib/dashboard/queries.ts uses (needs a lifetime order count per
// contact, not just the filtered period).

import type { SupabaseClient } from '@supabase/supabase-js'
import type { OrderDateRange } from '@/components/delivery/order-date-range-filter'
import type { DeliveryFunnelData } from './types'

export async function loadDeliveryFunnel(
  db: SupabaseClient,
  accountId: string,
  range: OrderDateRange,
): Promise<DeliveryFunnelData> {
  const { data, error } = await db
    .rpc('delivery_customer_funnel', {
      p_account_id: accountId,
      p_from: range.from.toISOString(),
      p_to: range.to.toISOString(),
    })
    .single()
  if (error) throw error

  // PostgREST can serialize BIGINT as a string — same defensive
  // Number() cast already used for filter_contacts_by_tags.total_count
  // in contacts/page.tsx.
  const row = data as Record<string, number | string>
  return {
    newContacts: Number(row.new_contacts),
    orderingCustomers: Number(row.ordering_customers),
    returningCustomers: Number(row.returning_customers),
    loyalCustomers: Number(row.loyal_customers),
    unattributedOrders: Number(row.unattributed_orders),
  }
}
