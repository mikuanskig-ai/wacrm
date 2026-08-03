import { NextResponse } from 'next/server'
import { requirePlatformAdmin } from '@/lib/auth/platform-admin'
import { toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { MODULE_KEYS } from '@/lib/accounts/modules'

const BILLING_CYCLES = ['monthly', 'quarterly', 'semiannual', 'annual'] as const

/** GET /api/admin/plans (platform admin only) — every plan, public or not. */
export async function GET() {
  try {
    await requirePlatformAdmin()
    const { data, error } = await supabaseAdmin()
      .from('plans')
      .select('id, name, description, price_cents, currency, billing_cycle, max_users, enabled_modules, is_public, is_active, position')
      .order('position', { ascending: true })

    if (error) {
      console.error('[admin/plans GET] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load plans' }, { status: 500 })
    }
    return NextResponse.json({ plans: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** POST /api/admin/plans (platform admin only) — create a new plan. */
export async function POST(request: Request) {
  try {
    const { userId } = await requirePlatformAdmin()
    const limit = checkRateLimit(`admin-plan-create:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })

    const priceCents = Number(body.price_cents)
    if (!Number.isInteger(priceCents) || priceCents < 0) {
      return NextResponse.json({ error: 'price_cents must be a non-negative integer' }, { status: 400 })
    }

    const billingCycle = body.billing_cycle
    if (!BILLING_CYCLES.includes(billingCycle)) {
      return NextResponse.json({ error: `billing_cycle must be one of ${BILLING_CYCLES.join(', ')}` }, { status: 400 })
    }

    const maxUsers =
      body.max_users === null || body.max_users === undefined ? null : Number(body.max_users)
    if (maxUsers !== null && (!Number.isInteger(maxUsers) || maxUsers <= 0)) {
      return NextResponse.json({ error: 'max_users must be a positive integer or null' }, { status: 400 })
    }

    const enabledModules = Array.isArray(body.enabled_modules)
      ? body.enabled_modules.filter((m: unknown) => typeof m === 'string' && (MODULE_KEYS as readonly string[]).includes(m))
      : []

    const { data, error } = await supabaseAdmin()
      .from('plans')
      .insert({
        name,
        description: typeof body.description === 'string' ? body.description.trim() || null : null,
        price_cents: priceCents,
        billing_cycle: billingCycle,
        max_users: maxUsers,
        enabled_modules: enabledModules,
        is_public: body.is_public !== false,
        is_active: body.is_active !== false,
        position: Number.isInteger(body.position) ? body.position : 0,
      })
      .select('id')
      .single()

    if (error || !data) {
      console.error('[admin/plans POST] insert error:', error)
      return NextResponse.json({ error: 'Failed to create plan' }, { status: 500 })
    }

    return NextResponse.json({ id: data.id }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
