import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { parseBusinessHoursWeek } from '@/lib/delivery/business-hours'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * GET /api/delivery/business-hours
 *
 * Any member may read the config so the UI can reflect whether hours
 * are enforced.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const { data, error } = await supabase
      .from('delivery_business_hours')
      .select('timezone, enabled, hours')
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) {
      console.error('[delivery/business-hours GET] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load business hours' }, { status: 500 })
    }

    if (!data) return NextResponse.json({ configured: false })
    return NextResponse.json({ configured: true, ...data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/delivery/business-hours  (admin+)
 *
 * Upsert the account's weekly schedule.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`delivery-business-hours:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const enabled = body.enabled === true
    const timezone = typeof body.timezone === 'string' && body.timezone.trim() ? body.timezone.trim() : null
    if (!timezone) return bad('timezone is required')

    const hours = parseBusinessHoursWeek(body.hours)
    if (!hours) return bad('hours must be a map of day -> {open, close} | null')

    const { data: existing } = await supabase
      .from('delivery_business_hours')
      .select('id')
      .eq('account_id', accountId)
      .maybeSingle()

    const shared = { timezone, enabled, hours }

    if (existing) {
      const { error: upErr } = await supabase
        .from('delivery_business_hours')
        .update(shared)
        .eq('account_id', accountId)
      if (upErr) {
        console.error('[delivery/business-hours POST] update error:', upErr)
        return NextResponse.json({ error: 'Failed to save business hours' }, { status: 500 })
      }
    } else {
      const { error: insErr } = await supabase.from('delivery_business_hours').insert({
        account_id: accountId,
        created_by: userId,
        ...shared,
      })
      if (insErr) {
        console.error('[delivery/business-hours POST] insert error:', insErr)
        return NextResponse.json({ error: 'Failed to save business hours' }, { status: 500 })
      }
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
