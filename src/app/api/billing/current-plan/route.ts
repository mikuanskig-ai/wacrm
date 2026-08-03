import { NextResponse } from 'next/server'
import { getCurrentAccountAllowSuspended, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getAccountPlan } from '@/lib/billing/plans'

/**
 * GET /api/billing/current-plan
 *
 * Suspension-tolerant (a suspended tenant still needs to see what
 * plan it's on and why it's blocked). `plans` has RLS enabled with
 * zero policies — every read goes through the service-role client,
 * manually scoped to the caller's own account, never the RLS-scoped
 * session client (which the identity check below still uses, since
 * that part DOES rely on RLS to prove "this is really your account").
 */
export async function GET() {
  try {
    const ctx = await getCurrentAccountAllowSuspended()
    const plan = await getAccountPlan(supabaseAdmin(), ctx.accountId)
    return NextResponse.json({
      plan,
      accountStatus: ctx.account.status,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
