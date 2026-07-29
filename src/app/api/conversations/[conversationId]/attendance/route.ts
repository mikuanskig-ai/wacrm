import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

type Params = { params: Promise<{ conversationId: string }> }
type Action = 'start' | 'close' | 'reopen'

/**
 * POST /api/conversations/[conversationId]/attendance  (agent+)
 *
 * The ONLY way a ticket moves between the human-facing inbox buckets
 * (PENDENTES/CHATBOT -> ABERTOS -> FECHADOS, and FECHADOS -> PENDENTES).
 * Real server route (not a raw client column write) because each
 * transition stamps an audit column pair — mirrors
 * /api/ai/autoreply/[conversationId]'s reasoning.
 *
 * Body: { action: 'start' | 'close' | 'reopen', close_reason?: string }
 *   - start:  status -> 'open', opened_at/opened_by stamped. Self-assigns
 *             the caller only if the ticket is currently unassigned —
 *             doesn't steal an existing assignment.
 *   - close:  status -> 'closed', closed_at/closed_by (+ optional
 *             close_reason) stamped. Assignment is left as-is — who
 *             handled it stays visible in the assign dropdown.
 *   - reopen: status -> 'pending' (back to the triage queue, not
 *             straight to 'open' — someone still has to "start" it
 *             again). Clears closed_at/closed_by/close_reason.
 *             ai_autoreply_disabled / assigned_agent_id are left
 *             untouched — reopening doesn't hand the thread back to
 *             the bot; that's still a distinct, explicit action via
 *             the existing AI "Resume AI" banner.
 *
 * Writes go through the RLS-scoped SSR client, so a conversation outside
 * the caller's account simply isn't found (404).
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    // Reuse the send bucket: this is a cheap per-user inbox action and
    // hammering it in a tight loop has no legitimate use.
    const limit = checkRateLimit(`ticket-attendance:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const { conversationId } = await params
    const body = await request.json().catch(() => null)
    const action = body?.action as Action | undefined
    if (!action || !['start', 'close', 'reopen'].includes(action)) {
      return NextResponse.json(
        { error: 'action must be one of: start, close, reopen' },
        { status: 400 },
      )
    }
    const closeReason =
      action === 'close' && typeof body?.close_reason === 'string'
        ? body.close_reason.slice(0, 500)
        : null

    const { data: conv, error: convErr } = await supabase
      .from('conversations')
      .select('id, status, assigned_agent_id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (convErr) {
      console.error('[conversations/attendance] lookup error:', convErr)
      return NextResponse.json({ error: 'Failed to load conversation' }, { status: 500 })
    }
    if (!conv) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const now = new Date().toISOString()
    const update: Record<string, unknown> = { updated_at: now }

    if (action === 'start') {
      update.status = 'open'
      update.opened_at = now
      update.opened_by = userId
      if (!conv.assigned_agent_id) update.assigned_agent_id = userId
    } else if (action === 'close') {
      update.status = 'closed'
      update.closed_at = now
      update.closed_by = userId
      update.close_reason = closeReason
    } else {
      update.status = 'pending'
      update.closed_at = null
      update.closed_by = null
      update.close_reason = null
    }

    const { error: upErr } = await supabase
      .from('conversations')
      .update(update)
      .eq('id', conversationId)
      .eq('account_id', accountId)
    if (upErr) {
      console.error('[conversations/attendance] update error:', upErr)
      return NextResponse.json({ error: 'Failed to update conversation' }, { status: 500 })
    }

    return NextResponse.json({ success: true, action, status: update.status })
  } catch (err) {
    return toErrorResponse(err)
  }
}
