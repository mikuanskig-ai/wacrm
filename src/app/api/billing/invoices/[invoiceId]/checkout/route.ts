import { NextResponse } from 'next/server'
import { getCurrentAccountAllowSuspended, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { reconcileInvoice } from '@/lib/billing/invoices'
import { createPaymentLink, getInfinitePayHandle } from '@/lib/billing/infinitepay-api'

/**
 * GET /api/billing/invoices/[invoiceId]/checkout
 *
 * Serves two purposes with one code path (never trust InfinitePay's
 * own redirect query params for either):
 *   - the "Pagar" button: returns a checkout url to send the browser to.
 *   - the checkout return page: re-confirms via `reconcileInvoice`
 *     (which re-queries InfinitePay directly) before reporting status,
 *     rather than trusting whatever the URL bar says on the way back.
 *
 * Suspension-tolerant — this is exactly the route a tenant suspended
 * for non-payment needs to reach to pay their way back in.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ invoiceId: string }> },
) {
  try {
    const ctx = await getCurrentAccountAllowSuspended()
    const { invoiceId } = await params
    const admin = supabaseAdmin()

    const { data: invoice, error } = await admin
      .from('invoices')
      .select('id, account_id, plan_name, amount_cents, status, checkout_url, checkout_order_nsu')
      .eq('id', invoiceId)
      .maybeSingle()

    if (error || !invoice || invoice.account_id !== ctx.accountId) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }

    if (invoice.status === 'pending' || invoice.status === 'overdue') {
      await reconcileInvoice(admin, invoiceId)
    }

    const { data: fresh } = await admin
      .from('invoices')
      .select('status, checkout_url, checkout_order_nsu')
      .eq('id', invoiceId)
      .maybeSingle()

    if (fresh?.status === 'paid') {
      return NextResponse.json({ paid: true })
    }

    if (fresh?.checkout_url) {
      return NextResponse.json({ paid: false, checkoutUrl: fresh.checkout_url })
    }

    // No link yet (e.g. the cron hasn't issued one for this invoice
    // yet) — generate on demand rather than making the tenant wait.
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL
    if (!siteUrl) {
      return NextResponse.json({ error: 'Billing is not fully configured' }, { status: 503 })
    }
    const { url } = await createPaymentLink({
      handle: getInfinitePayHandle(),
      orderNsu: invoiceId,
      amountCents: invoice.amount_cents,
      description: `${invoice.plan_name} — Zontalk`,
      redirectUrl: `${siteUrl}/settings?tab=billing`,
      webhookUrl: `${siteUrl}/api/billing/webhook`,
    })
    await admin
      .from('invoices')
      .update({ checkout_url: url, checkout_order_nsu: invoiceId })
      .eq('id', invoiceId)

    return NextResponse.json({ paid: false, checkoutUrl: url })
  } catch (err) {
    return toErrorResponse(err)
  }
}
