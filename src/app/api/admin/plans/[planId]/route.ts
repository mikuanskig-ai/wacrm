import { NextResponse } from 'next/server'
import { requirePlatformAdmin } from '@/lib/auth/platform-admin'
import { toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { MODULE_KEYS } from '@/lib/accounts/modules'

const BILLING_CYCLES = ['monthly', 'quarterly', 'semiannual', 'annual'] as const

/**
 * PATCH /api/admin/plans/[planId] (platform admin only)
 *
 * No DELETE — plans are retired via `is_active=false` only, since
 * `invoices.plan_id`/`accounts.plan_id` reference them with
 * ON DELETE RESTRICT and invoice history must survive a plan's
 * retirement.
 *
 * When `enabled_modules` shrinks, every account currently on this
 * plan gets its own `enabled_modules` pruned to the intersection —
 * otherwise an account keeps a module forever once granted, since the
 * migration-063 trigger only validates NEW changes, it doesn't
 * retroactively re-check the current value against a plan edited
 * after the fact.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ planId: string }> },
) {
  try {
    const { userId } = await requirePlatformAdmin()
    const { planId } = await params

    const limit = checkRateLimit(`admin-plan-patch:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const update: Record<string, unknown> = {}

    if ('name' in body) {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
      update.name = name
    }
    if ('description' in body) {
      update.description = typeof body.description === 'string' ? body.description.trim() || null : null
    }
    if ('price_cents' in body) {
      const priceCents = Number(body.price_cents)
      if (!Number.isInteger(priceCents) || priceCents < 0) {
        return NextResponse.json({ error: 'price_cents must be a non-negative integer' }, { status: 400 })
      }
      update.price_cents = priceCents
    }
    if ('billing_cycle' in body) {
      if (!BILLING_CYCLES.includes(body.billing_cycle)) {
        return NextResponse.json({ error: `billing_cycle must be one of ${BILLING_CYCLES.join(', ')}` }, { status: 400 })
      }
      update.billing_cycle = body.billing_cycle
    }
    if ('max_users' in body) {
      const maxUsers = body.max_users === null ? null : Number(body.max_users)
      if (maxUsers !== null && (!Number.isInteger(maxUsers) || maxUsers <= 0)) {
        return NextResponse.json({ error: 'max_users must be a positive integer or null' }, { status: 400 })
      }
      update.max_users = maxUsers
    }
    let newModules: string[] | null = null
    if ('enabled_modules' in body) {
      if (
        !Array.isArray(body.enabled_modules) ||
        !body.enabled_modules.every((m: unknown) => typeof m === 'string' && (MODULE_KEYS as readonly string[]).includes(m))
      ) {
        return NextResponse.json({ error: 'enabled_modules must be an array of known module keys' }, { status: 400 })
      }
      newModules = body.enabled_modules
      update.enabled_modules = newModules
    }
    if ('is_public' in body) update.is_public = body.is_public === true
    if ('is_active' in body) update.is_active = body.is_active === true
    if ('position' in body && Number.isInteger(body.position)) update.position = body.position

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    const admin = supabaseAdmin()
    const { error } = await admin.from('plans').update(update).eq('id', planId)
    if (error) {
      console.error('[admin/plans/[id] PATCH] update error:', error)
      return NextResponse.json({ error: 'Failed to update plan' }, { status: 500 })
    }

    if (newModules) {
      const { data: accounts } = await admin
        .from('accounts')
        .select('id, enabled_modules')
        .eq('plan_id', planId)
      for (const account of accounts ?? []) {
        const current = (account.enabled_modules as string[] | null) ?? []
        const pruned = current.filter((m) => newModules!.includes(m))
        if (pruned.length !== current.length) {
          await admin.from('accounts').update({ enabled_modules: pruned }).eq('id', account.id as string)
        }
      }
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
