import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

/**
 * GET /api/delivery/order-tag-config
 *
 * Any member may read — the account's currently selected tag
 * (accounts.order_placed_tag_id, applied automatically to a contact
 * on every order — see finalizeDeliveryOrder in create-order.ts) plus
 * the full tag list, so the settings panel can render the dropdown
 * without a second round trip.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const [accountRes, tagsRes] = await Promise.all([
      supabase.from('accounts').select('order_placed_tag_id').eq('id', accountId).maybeSingle(),
      supabase.from('tags').select('id, name, color').eq('account_id', accountId).order('name'),
    ])

    if (accountRes.error) {
      console.error('[delivery/order-tag-config GET] account fetch error:', accountRes.error)
      return NextResponse.json({ error: 'Failed to load config' }, { status: 500 })
    }
    if (tagsRes.error) {
      console.error('[delivery/order-tag-config GET] tags fetch error:', tagsRes.error)
      return NextResponse.json({ error: 'Failed to load tags' }, { status: 500 })
    }

    return NextResponse.json({
      tagId: accountRes.data?.order_placed_tag_id ?? null,
      tags: tagsRes.data ?? [],
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/delivery/order-tag-config  (admin+)
 *
 * Sets or clears the tag applied to a contact on every new order.
 * `tag_id: null` turns the feature off.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`delivery-order-tag-config:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object' || !('tag_id' in body)) {
      return NextResponse.json({ error: "'tag_id' is required (string or null)" }, { status: 400 })
    }
    const tagId = body.tag_id
    if (tagId !== null && typeof tagId !== 'string') {
      return NextResponse.json({ error: "'tag_id' must be a string or null" }, { status: 400 })
    }

    // Confirm the tag actually belongs to this account before wiring
    // it up — the FK alone would catch a garbage id, but not a real
    // tag id from a DIFFERENT account (RLS on the accounts UPDATE
    // below already scopes to this account's row, but the FK target
    // itself has no account check).
    if (tagId !== null) {
      const { data: tag } = await supabase
        .from('tags')
        .select('id')
        .eq('id', tagId)
        .eq('account_id', accountId)
        .maybeSingle()
      if (!tag) {
        return NextResponse.json({ error: 'Tag not found for this account' }, { status: 400 })
      }
    }

    const { error } = await supabase
      .from('accounts')
      .update({ order_placed_tag_id: tagId })
      .eq('id', accountId)
    if (error) {
      console.error('[delivery/order-tag-config POST] update error:', error)
      return NextResponse.json({ error: 'Failed to save config' }, { status: 500 })
    }

    return NextResponse.json({ success: true, tagId })
  } catch (err) {
    return toErrorResponse(err)
  }
}
