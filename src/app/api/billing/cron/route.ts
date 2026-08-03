import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getInfinitePayHandle, createPaymentLink } from '@/lib/billing/infinitepay-api'
import {
  GRACE_DAYS,
  RENEWAL_LEAD_DAYS,
  nextPeriod,
  toDateString,
  generateInvoice,
  reconcileInvoice,
  type BillingCycle,
} from '@/lib/billing/invoices'

const DRAIN_LIMIT = 50

/**
 * Drains platform billing work in a fixed order, all within one run,
 * so overlapping/adjacent phases never race each other:
 *
 *   1. Reconcile  — confirm any pending/overdue invoice against
 *      InfinitePay directly (the gateway's webhook carries no
 *      signature, so this periodic re-check is the real safety net,
 *      not a nice-to-have). MUST run before "suspend" below, or a
 *      payment whose webhook got dropped suspends the account anyway.
 *   2. Mark overdue  — pending, past due_date.
 *   3. Suspend  — overdue past the grace period, still active. Never
 *      touches an already-suspended account (whatever the reason).
 *   4. Reactivate  — suspended for non-payment, zero outstanding
 *      invoices left. Never reactivates a manually-suspended account.
 *   5. First invoice  — plan assigned, zero invoices yet, owner's
 *      email confirmed (skips unconfirmed/bot signups).
 *   6. Renewal invoice  — plan assigned, no outstanding invoice, next
 *      period starts within RENEWAL_LEAD_DAYS.
 *
 * Same auth pattern as automations/flows/broadcast cron: one shared
 * secret, `x-cron-secret` header, timing-safe compare.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL
  if (!siteUrl) {
    // The billing cron builds redirect_url/webhook_url with no
    // incoming request to derive them from — unlike invite links,
    // there is no request-header fallback available here.
    return NextResponse.json({ error: 'NEXT_PUBLIC_SITE_URL not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const result = {
    reconciled: 0,
    markedOverdue: 0,
    suspended: 0,
    reactivated: 0,
    firstInvoices: 0,
    renewalInvoices: 0,
  }

  // 1. Reconcile
  const { data: toReconcile } = await admin
    .from('invoices')
    .select('id')
    .in('status', ['pending', 'overdue'])
    .not('checkout_order_nsu', 'is', null)
    .limit(DRAIN_LIMIT)
  for (const row of toReconcile ?? []) {
    const outcome = await reconcileInvoice(admin, row.id as string)
    if (outcome.status === 'paid') result.reconciled++
  }

  // 2. Mark overdue
  const today = toDateString(new Date())
  const { data: overdueRows } = await admin
    .from('invoices')
    .update({ status: 'overdue' })
    .eq('status', 'pending')
    .lt('due_date', today)
    .select('id')
    .limit(DRAIN_LIMIT)
  result.markedOverdue = overdueRows?.length ?? 0

  // 3. Suspend — overdue accounts past the grace period.
  const graceCutoff = toDateString(new Date(Date.now() - GRACE_DAYS * 24 * 60 * 60 * 1000))
  const { data: pastGrace } = await admin
    .from('invoices')
    .select('account_id')
    .eq('status', 'overdue')
    .lte('due_date', graceCutoff)
    .limit(DRAIN_LIMIT)
  const accountsToSuspend = [...new Set((pastGrace ?? []).map((r) => r.account_id as string))]
  for (const accountId of accountsToSuspend) {
    const { data: suspended } = await admin
      .from('accounts')
      .update({ status: 'suspended', suspended_reason: 'overdue' })
      .eq('id', accountId)
      .eq('status', 'active')
      .select('id')
      .maybeSingle()
    if (suspended) result.suspended++
  }

  // 4. Reactivate — suspended-for-overdue accounts with nothing left outstanding.
  const { data: overdueSuspended } = await admin
    .from('accounts')
    .select('id')
    .eq('status', 'suspended')
    .eq('suspended_reason', 'overdue')
    .limit(DRAIN_LIMIT)
  for (const row of overdueSuspended ?? []) {
    const { count: outstanding } = await admin
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', row.id as string)
      .in('status', ['pending', 'overdue'])
    if (outstanding) continue
    const { data: reactivated } = await admin
      .from('accounts')
      .update({ status: 'active', suspended_reason: null })
      .eq('id', row.id as string)
      .eq('status', 'suspended')
      .eq('suspended_reason', 'overdue')
      .select('id')
      .maybeSingle()
    if (reactivated) result.reactivated++
  }

  const handle = getInfinitePayHandle()
  const webhookUrl = `${siteUrl}/api/billing/webhook`
  const redirectUrl = `${siteUrl}/settings?tab=billing`

  async function issueCheckout(invoiceId: string, amountCents: number, planName: string): Promise<void> {
    const { url } = await createPaymentLink({
      handle,
      orderNsu: invoiceId,
      amountCents,
      description: `${planName} — Zontalk`,
      redirectUrl,
      webhookUrl,
    })
    await admin
      .from('invoices')
      .update({ checkout_url: url, checkout_order_nsu: invoiceId })
      .eq('id', invoiceId)
  }

  // 5. First invoice — plan assigned, zero invoices, confirmed email.
  const { data: candidates } = await admin
    .from('accounts')
    .select('id, plan_id, owner_user_id, created_at')
    .not('plan_id', 'is', null)
    .limit(DRAIN_LIMIT)
  for (const account of candidates ?? []) {
    const { count: existing } = await admin
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', account.id as string)
    if (existing) continue // handled by phase 6 instead

    const { data: authUser } = await admin.auth.admin.getUserById(account.owner_user_id as string)
    if (!authUser?.user?.email_confirmed_at) continue

    const { data: plan } = await admin
      .from('plans')
      .select('id, name, price_cents, currency, billing_cycle')
      .eq('id', account.plan_id as string)
      .maybeSingle()
    if (!plan) continue
    // A free plan (price_cents=0 — e.g. the "Legacy" plan migration
    // 063 backfilled onto pre-existing accounts) never gets billed at
    // all. Without this, a legacy account's very first invoice would
    // be anchored to its ORIGINAL signup date (possibly months in the
    // past), be born already overdue, and auto-suspend on the next
    // cron pass.
    if (plan.price_cents === 0) continue

    // due_date = signup date (starts the grace-period clock right
    // away, "pay later" doubling as an informal trial). period_end is
    // a full cycle out — same as any renewal — so phase 6 picks up
    // the chain correctly from here.
    const dueDate = new Date(account.created_at as string)
    const { periodStart, periodEnd } = nextPeriod(plan.billing_cycle as BillingCycle, dueDate)
    const inserted = await generateInvoice(admin, {
      accountId: account.id as string,
      planId: plan.id,
      planName: plan.name,
      amountCents: plan.price_cents,
      currency: plan.currency,
      periodStart,
      periodEnd,
      dueDate,
    })
    if (inserted) {
      result.firstInvoices++
      await issueCheckout(inserted.id, plan.price_cents, plan.name)
    }
  }

  // 6. Renewal invoice — plan assigned, no invoice pending/overdue,
  // last period ends within RENEWAL_LEAD_DAYS.
  const leadCutoff = new Date(Date.now() + RENEWAL_LEAD_DAYS * 24 * 60 * 60 * 1000)
  for (const account of candidates ?? []) {
    const { data: latest } = await admin
      .from('invoices')
      .select('period_start, period_end, status')
      .eq('account_id', account.id as string)
      .order('period_end', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!latest) continue // no invoice yet at all — phase 5's job
    if (latest.status === 'pending' || latest.status === 'overdue') continue // still outstanding

    const periodEnd = new Date(latest.period_end as string)
    if (periodEnd > leadCutoff) continue // not due for renewal yet

    const { data: plan } = await admin
      .from('plans')
      .select('id, name, price_cents, currency, billing_cycle, is_active')
      .eq('id', account.plan_id as string)
      .maybeSingle()
    if (!plan?.is_active) continue // retired plan — admin must reassign manually
    if (plan.price_cents === 0) continue // free plan — never billed (see phase 5's same guard)

    const { periodStart, periodEnd: nextEnd } = nextPeriod(plan.billing_cycle as BillingCycle, periodEnd)
    const inserted = await generateInvoice(admin, {
      accountId: account.id as string,
      planId: plan.id,
      planName: plan.name,
      amountCents: plan.price_cents,
      currency: plan.currency,
      periodStart,
      periodEnd: nextEnd,
      dueDate: periodStart,
    })
    if (inserted) {
      result.renewalInvoices++
      await issueCheckout(inserted.id, plan.price_cents, plan.name)
    }
  }

  return NextResponse.json(result)
}
