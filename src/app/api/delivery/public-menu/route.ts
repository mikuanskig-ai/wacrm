import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/payments/admin-client'
import { isValidSlugFormat } from '@/lib/delivery/slug'
import { isSlugAvailable } from '@/lib/delivery/public-menu'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * GET /api/delivery/public-menu
 *
 * Any member may read the account's current public-cardápio slug.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const { data, error } = await supabase
      .from('accounts')
      .select('slug')
      .eq('id', accountId)
      .maybeSingle()

    if (error) {
      console.error('[delivery/public-menu GET] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load public menu settings' }, { status: 500 })
    }

    return NextResponse.json({ slug: data?.slug ?? null })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/delivery/public-menu  (admin+)
 *
 * Sets or changes the account's public-cardápio slug. Same shape as
 * business-hours' upsert: this table (accounts) always has a row, so
 * it's a plain UPDATE, not an insert-or-update branch.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`delivery-public-menu:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const slug = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : ''
    if (!slug) return bad('slug is required')
    if (!isValidSlugFormat(slug)) {
      return bad('slug must be lowercase-kebab-case, 3-60 characters')
    }

    // Availability must be checked across every account, not just this
    // one — the session-scoped client's RLS only shows accounts the
    // caller is a member of, so this needs the service-role client.
    const available = await isSlugAvailable(supabaseAdmin(), slug, accountId)
    if (!available) {
      return NextResponse.json({ error: 'slug_taken' }, { status: 409 })
    }

    const { error } = await supabase.from('accounts').update({ slug }).eq('id', accountId)
    if (error) {
      console.error('[delivery/public-menu POST] update error:', error)
      return NextResponse.json({ error: 'Failed to save slug' }, { status: 500 })
    }

    return NextResponse.json({ success: true, slug })
  } catch (err) {
    return toErrorResponse(err)
  }
}
