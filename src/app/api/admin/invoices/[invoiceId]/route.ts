import { NextResponse } from 'next/server'
import { requirePlatformAdmin } from '@/lib/auth/platform-admin'
import { toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

/**
 * PATCH /api/admin/invoices/[invoiceId]  (platform admin only)
 *
 * Body: { status: 'paid' } — the manual override for a payment that
 * happened outside InfinitePay (bank transfer, cash, Pix sent
 * directly). Deliberately skips `reconcileInvoice`/`checkPayment` —
 * an admin marking this by hand IS the confirmation, there's nothing
 * to re-verify against a gateway that was never involved. Still
 * reactivates the account when this was its last outstanding invoice
 * and it was suspended for non-payment specifically, same rule as the
 * automated path.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ invoiceId: string }> },
) {
  try {
    const { userId } = await requirePlatformAdmin()
    const { invoiceId } = await params

    const limit = checkRateLimit(`admin-invoice-patch:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || body.status !== 'paid') {
      return NextResponse.json({ error: "status must be 'paid'" }, { status: 400 })
    }

    const admin = supabaseAdmin()
    const { data: updated, error } = await admin
      .from('invoices')
      .update({ status: 'paid', paid_at: new Date().toISOString() })
      .eq('id', invoiceId)
      .in('status', ['pending', 'overdue'])
      .select('id, account_id')
      .maybeSingle()

    if (error) {
      console.error('[admin/invoices/[id] PATCH] update error:', error)
      return NextResponse.json({ error: 'Failed to update invoice' }, { status: 500 })
    }
    if (!updated) {
      return NextResponse.json({ error: 'Invoice not found or already settled' }, { status: 404 })
    }

    const { count: remaining } = await admin
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', updated.account_id)
      .in('status', ['pending', 'overdue'])
    if (!remaining) {
      await admin
        .from('accounts')
        .update({ status: 'active', suspended_reason: null })
        .eq('id', updated.account_id)
        .eq('status', 'suspended')
        .eq('suspended_reason', 'overdue')
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
