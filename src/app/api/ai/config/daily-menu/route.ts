import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { parseDailyMenu } from '@/lib/delivery/business-hours'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * POST /api/ai/config/daily-menu  (admin+)
 *
 * Narrow, single-field sibling of POST /api/ai/config — deliberately
 * NOT folded into that route's shared upsert. That route requires
 * provider/model/api_key on every call (ai_configs' NOT NULL columns)
 * and resets every other toggle (is_active, auto_reply_enabled, hours,
 * ...) to whatever the body did or didn't send — safe only because its
 * one caller (the AI Settings form) always submits the whole config as
 * one state object. The Cardápio screen only ever touches daily_menu
 * and has no reason to know about the rest of that shape, so reusing
 * the same endpoint would mean echoing back every other field just to
 * avoid silently clobbering them (is_active/auto_reply_enabled default
 * to false when omitted from that route's body) — this route exists
 * instead of that.
 *
 * Requires an existing ai_configs row — provider/model/api_key are
 * NOT NULL on that table, so an account that hasn't configured AI yet
 * has no row to attach a daily menu to.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`ai-config:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const dailyMenu = parseDailyMenu(body.daily_menu ?? {})
    if (!dailyMenu) return bad('daily_menu must be a map of day -> text | null')

    const { data: existing } = await supabase
      .from('ai_configs')
      .select('id')
      .eq('account_id', accountId)
      .maybeSingle()
    if (!existing) {
      return bad('Configure a IA em Configurações antes de definir o cardápio do dia.')
    }

    const { error } = await supabase
      .from('ai_configs')
      .update({ daily_menu: dailyMenu })
      .eq('account_id', accountId)
    if (error) {
      console.error('[ai/config/daily-menu POST] update error:', error)
      return NextResponse.json({ error: 'Failed to save daily menu' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
