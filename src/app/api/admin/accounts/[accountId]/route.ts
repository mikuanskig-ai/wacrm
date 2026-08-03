import { NextResponse } from 'next/server'
import { requirePlatformAdmin } from '@/lib/auth/platform-admin'
import { toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { MODULE_KEYS } from '@/lib/accounts/modules'

const USAGE_WINDOW_DAYS = 30

/**
 * GET /api/admin/accounts/[accountId]  (platform admin only)
 *
 * Detail view: account row, owner email, WhatsApp connection, and a
 * 30-day AI usage summary grouped by provider.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  try {
    await requirePlatformAdmin()
    const { accountId } = await params
    const admin = supabaseAdmin()

    const { data: account, error } = await admin
      .from('accounts')
      .select('id, name, slug, status, suspended_reason, enabled_modules, plan_id, created_at')
      .eq('id', accountId)
      .maybeSingle()

    if (error) {
      console.error('[admin/accounts/[id] GET] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load account' }, { status: 500 })
    }
    if (!account) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }

    const since = new Date(Date.now() - USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()

    const [{ data: owner }, { data: whatsapp }, { data: usageRows }, { data: plan }, { data: invoices }] =
      await Promise.all([
        admin
          .from('profiles')
          .select('email')
          .eq('account_id', accountId)
          .eq('account_role', 'owner')
          .maybeSingle(),
        admin
          .from('whatsapp_config')
          .select('status, connected_at, wuzapi_instance_name')
          .eq('account_id', accountId)
          .maybeSingle(),
        admin
          .from('ai_usage_log')
          .select('provider, total_tokens')
          .eq('account_id', accountId)
          .gte('created_at', since),
        account.plan_id
          ? admin
              .from('plans')
              .select('id, name, price_cents, currency, billing_cycle')
              .eq('id', account.plan_id)
              .maybeSingle()
          : Promise.resolve({ data: null }),
        admin
          .from('invoices')
          .select('id, plan_name, amount_cents, currency, status, period_start, period_end, due_date, paid_at')
          .eq('account_id', accountId)
          .order('created_at', { ascending: false })
          .limit(20),
      ])

    const usageByProvider = new Map<string, number>()
    for (const row of usageRows ?? []) {
      const provider = row.provider as string
      usageByProvider.set(provider, (usageByProvider.get(provider) ?? 0) + ((row.total_tokens as number) ?? 0))
    }

    return NextResponse.json({
      account: {
        id: account.id,
        name: account.name,
        slug: account.slug,
        status: account.status,
        suspended_reason: account.suspended_reason,
        enabled_modules: account.enabled_modules ?? [],
        plan_id: account.plan_id,
        created_at: account.created_at,
      },
      owner_email: owner?.email ?? null,
      whatsapp: whatsapp ?? null,
      plan: plan ?? null,
      invoices: invoices ?? [],
      ai_usage: {
        window_days: USAGE_WINDOW_DAYS,
        by_provider: Array.from(usageByProvider, ([provider, total_tokens]) => ({ provider, total_tokens })),
      },
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * PATCH /api/admin/accounts/[accountId]  (platform admin only)
 *
 * Body: { enabled_modules?: string[]; status?: 'active' | 'suspended'; plan_id?: string | null }
 * Writes via the service-role client — the migration-062/063 triggers
 * reject these columns from the `authenticated` role, but this route
 * runs as `service_role`, so it passes.
 *
 * Suspending here always sets suspended_reason='manual' (outranks a
 * cron-driven 'overdue' suspension — an admin's call always wins) and
 * reactivating always clears it; the billing cron never touches a
 * manually-suspended account. Changing `plan_id` prunes
 * `enabled_modules` down to the new plan's grants in the same write,
 * so a downgrade can't leave a module the tenant no longer pays for.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  try {
    const { userId } = await requirePlatformAdmin()
    const { accountId } = await params

    const limit = checkRateLimit(`admin-account-patch:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const admin = supabaseAdmin()
    const update: {
      enabled_modules?: string[]
      status?: 'active' | 'suspended'
      suspended_reason?: 'manual' | null
      plan_id?: string | null
    } = {}

    if ('enabled_modules' in body) {
      const modules = body.enabled_modules
      if (
        !Array.isArray(modules) ||
        !modules.every((m) => typeof m === 'string' && (MODULE_KEYS as readonly string[]).includes(m))
      ) {
        return NextResponse.json({ error: 'enabled_modules must be an array of known module keys' }, { status: 400 })
      }
      update.enabled_modules = modules
    }

    if ('status' in body) {
      if (body.status !== 'active' && body.status !== 'suspended') {
        return NextResponse.json({ error: "status must be 'active' or 'suspended'" }, { status: 400 })
      }
      update.status = body.status
      update.suspended_reason = body.status === 'suspended' ? 'manual' : null
    }

    if ('plan_id' in body) {
      if (body.plan_id !== null && typeof body.plan_id !== 'string') {
        return NextResponse.json({ error: 'plan_id must be a string or null' }, { status: 400 })
      }
      update.plan_id = body.plan_id
      // Prune enabled_modules to the new plan's grants (or clear
      // entirely when un-assigning a plan) — never leave a module the
      // account no longer has a plan grant for.
      if (!('enabled_modules' in update)) {
        const { data: currentAccount } = await admin
          .from('accounts')
          .select('enabled_modules')
          .eq('id', accountId)
          .maybeSingle()
        const current = (currentAccount?.enabled_modules as string[] | null) ?? []
        let allowed: string[] = []
        if (body.plan_id) {
          const { data: newPlan } = await admin
            .from('plans')
            .select('enabled_modules')
            .eq('id', body.plan_id)
            .maybeSingle()
          allowed = (newPlan?.enabled_modules as string[] | null) ?? []
        }
        update.enabled_modules = current.filter((m) => allowed.includes(m))
      }
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    const { error } = await admin.from('accounts').update(update).eq('id', accountId)

    if (error) {
      console.error('[admin/accounts/[id] PATCH] update error:', error)
      return NextResponse.json({ error: 'Failed to update account' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
