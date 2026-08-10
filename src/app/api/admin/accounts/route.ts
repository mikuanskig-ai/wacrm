import { NextResponse } from 'next/server'
import { requirePlatformAdmin } from '@/lib/auth/platform-admin'
import { toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'

/**
 * GET /api/admin/accounts  (platform admin only)
 *
 * Lists every tenant account with the summary fields the /admin table
 * needs: owner email, WhatsApp connection status, modules, status,
 * plan (id + name, so the Empresas tab can reassign it inline), and
 * lifetime revenue (sum of paid invoices).
 * Reads via the service-role client — RLS would otherwise block a
 * cross-tenant listing entirely (is_account_member only ever passes
 * for the caller's own account).
 */
export async function GET() {
  try {
    await requirePlatformAdmin()
    const admin = supabaseAdmin()

    const { data: accounts, error } = await admin
      .from('accounts')
      .select('id, name, slug, status, suspended_reason, enabled_modules, plan_id, created_at')
      .order('created_at', { ascending: false })

    if (error) {
      console.error('[admin/accounts GET] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load accounts' }, { status: 500 })
    }
    if (!accounts || accounts.length === 0) {
      return NextResponse.json({ accounts: [] })
    }

    const accountIds = accounts.map((a) => a.id as string)
    const planIds = [...new Set(accounts.map((a) => a.plan_id as string | null).filter((id): id is string => !!id))]

    const [{ data: owners }, { data: configs }, { data: plans }, { data: outstandingInvoices }, { data: paidInvoices }] =
      await Promise.all([
        admin
          .from('profiles')
          .select('account_id, email')
          .in('account_id', accountIds)
          .eq('account_role', 'owner'),
        admin
          .from('whatsapp_config')
          .select('account_id, status, connected_at')
          .in('account_id', accountIds),
        planIds.length > 0
          ? admin.from('plans').select('id, name').in('id', planIds)
          : Promise.resolve({ data: [] as { id: string; name: string }[] }),
        admin
          .from('invoices')
          .select('account_id, status')
          .in('account_id', accountIds)
          .in('status', ['pending', 'overdue']),
        // Lifetime revenue per account — every 'paid' invoice, summed
        // in-memory below. Powers the Empresas tab's "Receita" column
        // (Fase 4 of the platform admin expansion) so an admin can see
        // who's actually paying without opening each account.
        admin.from('invoices').select('account_id, amount_cents').in('account_id', accountIds).eq('status', 'paid'),
      ])

    const ownerByAccount = new Map((owners ?? []).map((o) => [o.account_id as string, o.email as string]))
    const whatsappByAccount = new Map(
      (configs ?? []).map((c) => [
        c.account_id as string,
        { status: c.status as string, connected_at: c.connected_at as string | null },
      ]),
    )
    const planNameById = new Map((plans ?? []).map((p) => [p.id as string, p.name as string]))
    // "overdue" wins over "pending" if an account somehow has both.
    const billingStatusByAccount = new Map<string, 'overdue' | 'pending'>()
    for (const inv of outstandingInvoices ?? []) {
      const accId = inv.account_id as string
      const status = inv.status as 'pending' | 'overdue'
      if (status === 'overdue' || !billingStatusByAccount.has(accId)) {
        billingStatusByAccount.set(accId, status)
      }
    }

    const revenueByAccount = new Map<string, number>()
    for (const inv of paidInvoices ?? []) {
      const accId = inv.account_id as string
      revenueByAccount.set(accId, (revenueByAccount.get(accId) ?? 0) + (inv.amount_cents as number))
    }

    const result = accounts.map((a) => ({
      id: a.id,
      name: a.name,
      slug: a.slug,
      status: a.status,
      suspended_reason: a.suspended_reason,
      enabled_modules: a.enabled_modules ?? [],
      created_at: a.created_at,
      owner_email: ownerByAccount.get(a.id as string) ?? null,
      whatsapp: whatsappByAccount.get(a.id as string) ?? null,
      plan_id: a.plan_id,
      plan_name: a.plan_id ? (planNameById.get(a.plan_id as string) ?? null) : null,
      billing_status: billingStatusByAccount.get(a.id as string) ?? 'current',
      revenue_paid_cents: revenueByAccount.get(a.id as string) ?? 0,
    }))

    return NextResponse.json({ accounts: result })
  } catch (err) {
    return toErrorResponse(err)
  }
}
