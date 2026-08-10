import { NextResponse } from 'next/server'
import { requirePlatformAdmin } from '@/lib/auth/platform-admin'
import { toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'

/**
 * GET /api/admin/invoices  (platform admin only)
 *
 * Lists every tenant invoice across the platform (the "Financeiro"
 * tab) — the billing counterpart to /api/admin/accounts, same
 * base-list-then-batch-join shape. Query params (all optional):
 *
 *   from, to      — filter by `created_at` (ISO date, inclusive)
 *   status        — pending | paid | overdue | cancelled
 *   accountId     — one tenant only
 *   search        — matches plan_name (ilike)
 *   minCents/maxCents — amount_cents range
 *
 * Summary stats are computed from the SAME filtered set (not a
 * separate global query) so they always describe exactly what's
 * listed below them — matches the "changes with the filters" behavior
 * of the reference panel's own Financeiro tab.
 */
export async function GET(request: Request) {
  try {
    await requirePlatformAdmin()
    const admin = supabaseAdmin()

    const url = new URL(request.url)
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    const status = url.searchParams.get('status')
    const accountId = url.searchParams.get('accountId')
    const search = url.searchParams.get('search')?.trim()
    const minCents = Number(url.searchParams.get('minCents'))
    const maxCents = Number(url.searchParams.get('maxCents'))

    let query = admin
      .from('invoices')
      .select('id, account_id, plan_name, amount_cents, currency, status, due_date, paid_at, checkout_url, created_at')
      .order('created_at', { ascending: false })

    if (from) query = query.gte('created_at', from)
    if (to) query = query.lte('created_at', `${to}T23:59:59.999Z`)
    if (status) query = query.eq('status', status)
    if (accountId) query = query.eq('account_id', accountId)
    if (search) query = query.ilike('plan_name', `%${search}%`)
    if (Number.isFinite(minCents)) query = query.gte('amount_cents', minCents)
    if (Number.isFinite(maxCents)) query = query.lte('amount_cents', maxCents)

    const { data: invoices, error } = await query
    if (error) {
      console.error('[admin/invoices GET] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load invoices' }, { status: 500 })
    }

    const rows = invoices ?? []
    const accountIds = [...new Set(rows.map((r) => r.account_id as string))]
    const { data: accounts } = accountIds.length
      ? await admin.from('accounts').select('id, name').in('id', accountIds)
      : { data: [] as { id: string; name: string }[] }
    const { data: owners } = accountIds.length
      ? await admin.from('profiles').select('account_id, email').in('account_id', accountIds).eq('account_role', 'owner')
      : { data: [] as { account_id: string; email: string }[] }

    const accountNameById = new Map((accounts ?? []).map((a) => [a.id as string, a.name as string]))
    const ownerEmailByAccount = new Map((owners ?? []).map((o) => [o.account_id as string, o.email as string]))

    const result = rows.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      accountName: accountNameById.get(r.account_id as string) ?? null,
      ownerEmail: ownerEmailByAccount.get(r.account_id as string) ?? null,
      planName: r.plan_name,
      amountCents: r.amount_cents,
      currency: r.currency,
      status: r.status,
      dueDate: r.due_date,
      paidAt: r.paid_at,
      checkoutUrl: r.checkout_url,
      createdAt: r.created_at,
    }))

    // See the file doc above for why "faturamento total" excludes
    // cancelled and "pendentes" counts only 'pending' (overdue is its
    // own separate bucket) — matches the reference panel's own math,
    // reverse-engineered against a real screenshot's numbers.
    let faturamentoTotalCents = 0
    let recebidoCents = 0
    let emAbertoCents = 0
    let vencidoCents = 0
    let invoicesPagas = 0
    let invoicesPendentes = 0
    for (const inv of rows) {
      const cents = inv.amount_cents as number
      const st = inv.status as string
      if (st !== 'cancelled') faturamentoTotalCents += cents
      if (st === 'paid') {
        recebidoCents += cents
        invoicesPagas += 1
      } else if (st === 'pending') {
        emAbertoCents += cents
        invoicesPendentes += 1
      } else if (st === 'overdue') {
        vencidoCents += cents
      }
    }

    return NextResponse.json({
      invoices: result,
      summary: {
        faturamentoTotalCents,
        recebidoCents,
        emAbertoCents,
        vencidoCents,
        totalInvoices: rows.length,
        invoicesPagas,
        invoicesPendentes,
        ticketMedioCents: invoicesPagas > 0 ? Math.round(recebidoCents / invoicesPagas) : 0,
      },
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
