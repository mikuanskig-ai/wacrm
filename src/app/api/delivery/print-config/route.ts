import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

/**
 * GET /api/delivery/print-config
 *
 * Any member may read the config so the UI can reflect whether
 * auto-print is on and when the (not-yet-built) local agent last
 * polled for jobs.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const { data, error } = await supabase
      .from('print_configs')
      .select('enabled, last_polled_at')
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) {
      console.error('[delivery/print-config GET] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load print config' }, { status: 500 })
    }

    if (!data) return NextResponse.json({ configured: false })
    return NextResponse.json({ configured: true, ...data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/delivery/print-config  (admin+)
 *
 * Toggles auto-print for the account.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`delivery-print-config:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }
    const enabled = body.enabled === true

    const { data: existing } = await supabase
      .from('print_configs')
      .select('id')
      .eq('account_id', accountId)
      .maybeSingle()

    if (existing) {
      const { error } = await supabase
        .from('print_configs')
        .update({ enabled })
        .eq('account_id', accountId)
      if (error) {
        console.error('[delivery/print-config POST] update error:', error)
        return NextResponse.json({ error: 'Failed to save print config' }, { status: 500 })
      }
    } else {
      const { error } = await supabase.from('print_configs').insert({ account_id: accountId, enabled })
      if (error) {
        console.error('[delivery/print-config POST] insert error:', error)
        return NextResponse.json({ error: 'Failed to save print config' }, { status: 500 })
      }
    }

    return NextResponse.json({ success: true, enabled })
  } catch (err) {
    return toErrorResponse(err)
  }
}
