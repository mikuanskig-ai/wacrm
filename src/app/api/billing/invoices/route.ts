import { NextResponse } from 'next/server'
import { getCurrentAccountAllowSuspended, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'

/**
 * GET /api/billing/invoices
 *
 * Suspension-tolerant, same reasoning as /api/billing/current-plan.
 * Any team member may view — the "Pagar" action is gated client-side
 * by `canEditSettings` (see billing-settings.tsx), matching how the
 * settings rail has no built-in role gate of its own.
 */
export async function GET() {
  try {
    const ctx = await getCurrentAccountAllowSuspended()
    const { data, error } = await supabaseAdmin()
      .from('invoices')
      .select('id, plan_name, amount_cents, currency, status, period_start, period_end, due_date, paid_at, checkout_url')
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) {
      console.error('[billing/invoices GET] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load invoices' }, { status: 500 })
    }

    return NextResponse.json({ invoices: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}
