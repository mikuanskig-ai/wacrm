// ============================================================
// Invoice period math + the reconciliation path. Kept separate from
// `plans.ts` (which is about what a plan currently grants a single
// account) — this file is about billing cycles across many accounts,
// consumed by the cron (`src/app/api/billing/cron/route.ts`) and the
// three "did this get paid" entry points (webhook, cron, checkout
// return page).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { checkPayment } from './infinitepay-api'

/** Days past due_date before an overdue invoice auto-suspends the account. */
export const GRACE_DAYS = 3
/** How far ahead of period_end the next invoice gets generated — same
 *  window Whazing's SaaS module documents for its own recurring billing. */
export const RENEWAL_LEAD_DAYS = 20

export type BillingCycle = 'monthly' | 'quarterly' | 'semiannual' | 'annual'

const CYCLE_MONTHS: Record<BillingCycle, number> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
}

/** `invoices.period_start`/`period_end`/`due_date` are plain Postgres
 *  `DATE` columns — calendar dates with no timezone. Formatting via
 *  `toISOString()` (always UTC) rather than a local-time formatter
 *  keeps this deterministic regardless of the server's timezone; a
 *  local-time formatter shifts the calendar day near midnight and
 *  across DST transitions (confirmed the hard way — see
 *  periods.test.ts). */
/** Formats a cents amount with full currency precision — deliberately
 *  NOT `@/lib/currency`'s `formatCurrency`, which rounds to whole
 *  units for CRM deal values (a different concern with different
 *  rounding needs than exact billing amounts like R$99,90). */
export function formatPriceCents(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100)
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`
  }
}

export function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Adds calendar months using UTC getters/setters throughout, so the
 *  result never depends on the server's local timezone (same
 *  reasoning as `toDateString`). */
function addMonthsUTC(date: Date, months: number): Date {
  const d = new Date(date.getTime())
  d.setUTCMonth(d.getUTCMonth() + months)
  return d
}

/** The next billing period for a cycle, given when it starts. */
export function nextPeriod(
  cycle: BillingCycle,
  periodStart: Date,
): { periodStart: Date; periodEnd: Date } {
  return { periodStart, periodEnd: addMonthsUTC(periodStart, CYCLE_MONTHS[cycle]) }
}

export interface GenerateInvoiceArgs {
  accountId: string
  planId: string
  planName: string
  amountCents: number
  currency: string
  periodStart: Date
  periodEnd: Date
  dueDate: Date
}

/**
 * Inserts one invoice for one billing period. `ON CONFLICT
 * (account_id, period_start) DO NOTHING` (via `ignoreDuplicates`) is
 * the cron's idempotency lock — safe to call from overlapping runs
 * without a separate claim step. Returns null when that period was
 * already invoiced (the conflict case), the inserted row otherwise.
 */
export async function generateInvoice(
  db: SupabaseClient,
  args: GenerateInvoiceArgs,
): Promise<{ id: string } | null> {
  const { data, error } = await db
    .from('invoices')
    .upsert(
      {
        account_id: args.accountId,
        plan_id: args.planId,
        plan_name: args.planName,
        amount_cents: args.amountCents,
        currency: args.currency,
        status: 'pending',
        period_start: toDateString(args.periodStart),
        period_end: toDateString(args.periodEnd),
        due_date: toDateString(args.dueDate),
      },
      { onConflict: 'account_id,period_start', ignoreDuplicates: true },
    )
    .select('id')
    .maybeSingle()
  if (error) throw new Error(`Failed to generate invoice: ${error.message}`)
  return data
}

/**
 * The ONE place that confirms a payment and applies its side effects
 * (mark paid, reactivate the account if this was its last outstanding
 * invoice and it was suspended for non-payment). Called from the
 * webhook, the cron's reconciliation phase, and the checkout return
 * page — never duplicate this logic at a call site. InfinitePay's
 * webhook carries no signature, so `checkPayment` (re-querying the
 * gateway directly) is the only trustworthy source of truth here.
 */
export async function reconcileInvoice(
  db: SupabaseClient,
  invoiceId: string,
): Promise<{ status: 'paid' | 'unchanged' }> {
  const { data: invoice } = await db
    .from('invoices')
    .select('id, account_id, amount_cents, checkout_order_nsu, status')
    .eq('id', invoiceId)
    .maybeSingle()
  if (!invoice?.checkout_order_nsu) return { status: 'unchanged' }
  if (invoice.status !== 'pending' && invoice.status !== 'overdue') return { status: 'unchanged' }

  const result = await checkPayment({ orderNsu: invoice.checkout_order_nsu })
  if (!result?.paid || result.paidAmountCents < invoice.amount_cents) return { status: 'unchanged' }

  // Conditional update — the .in('status', [...]) guard means only
  // ONE caller (webhook / cron / return page, whichever gets here
  // first) actually performs the transition and its side effects,
  // even when two race on the same invoice.
  const { data: updated } = await db
    .from('invoices')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('id', invoiceId)
    .in('status', ['pending', 'overdue'])
    .select('id, account_id')
    .maybeSingle()
  if (!updated) return { status: 'unchanged' }

  // Reactivate only if this was the account's last outstanding
  // invoice AND it was suspended for non-payment specifically — never
  // touch a manually-suspended account (suspended_reason='manual').
  const { count: remaining } = await db
    .from('invoices')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', updated.account_id)
    .in('status', ['pending', 'overdue'])
  if (!remaining) {
    await db
      .from('accounts')
      .update({ status: 'active', suspended_reason: null })
      .eq('id', updated.account_id)
      .eq('status', 'suspended')
      .eq('suspended_reason', 'overdue')
  }

  return { status: 'paid' }
}
