import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  invoiceRows: [] as unknown[],
  accountRows: [] as unknown[],
  ownerRows: [] as unknown[],
}))

vi.mock('@/lib/auth/platform-admin', () => ({ requirePlatformAdmin: h.requirePlatformAdmin }))

/** Filter correctness (`.eq`/`.gte`/`.ilike` actually narrowing rows)
 *  is Supabase's own query builder's job — this fake always resolves
 *  to the canned `invoiceRows` regardless of which filters were
 *  chained, same "trust the query builder, test our own wiring"
 *  discipline as the stats route's test. What's actually worth
 *  locking in here is the summary math (reverse-engineered from a
 *  real screenshot) and the account/owner join. */
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const chain = {
        select: () => chain,
        order: () => chain,
        eq: () => chain,
        gte: () => chain,
        lte: () => chain,
        in: () => chain,
        ilike: () => chain,
        then: (resolve: (v: { data: unknown; error: null }) => void) => {
          if (table === 'invoices') return resolve({ data: h.invoiceRows, error: null })
          if (table === 'accounts') return resolve({ data: h.accountRows, error: null })
          if (table === 'profiles') return resolve({ data: h.ownerRows, error: null })
          return resolve({ data: [], error: null })
        },
      }
      return chain
    },
  }),
}))

import { GET } from './route'

beforeEach(() => {
  h.requirePlatformAdmin.mockReset()
  h.requirePlatformAdmin.mockResolvedValue({ supabase: {}, userId: 'admin-1' })
  h.invoiceRows = []
  h.accountRows = []
  h.ownerRows = []
})

describe('GET /api/admin/invoices', () => {
  it('propagates the platform-admin gate (403) when the caller is not a platform admin', async () => {
    const { ForbiddenError } = await import('@/lib/auth/account')
    h.requirePlatformAdmin.mockRejectedValue(new ForbiddenError('Platform admin only'))
    const res = await GET(new Request('http://localhost/api/admin/invoices'))
    expect(res.status).toBe(403)
  })

  it('computes the summary exactly as the reference panel does — regression, 2026-08-09', async () => {
    // Matches a real screenshot: 2 pending (14700, 14700 wait — use the
    // exact figures observed) + 1 pending 8700, 2 overdue (14700,
    // 11000), 1 cancelled (8700). Faturamento total excludes
    // cancelled; "pendentes" only counts 'pending' (not 'overdue').
    h.invoiceRows = [
      { id: '1', account_id: 'a1', plan_name: 'Premium', amount_cents: 14700, currency: 'BRL', status: 'overdue', due_date: '2026-07-30', paid_at: null, checkout_url: null, created_at: '2026-08-03' },
      { id: '2', account_id: 'a2', plan_name: 'Premium', amount_cents: 11000, currency: 'BRL', status: 'overdue', due_date: '2026-08-08', paid_at: null, checkout_url: null, created_at: '2026-07-24' },
      { id: '3', account_id: 'a3', plan_name: 'Premium', amount_cents: 14700, currency: 'BRL', status: 'pending', due_date: '2026-08-10', paid_at: null, checkout_url: null, created_at: '2026-07-22' },
      { id: '4', account_id: 'a4', plan_name: 'Premium', amount_cents: 14700, currency: 'BRL', status: 'pending', due_date: '2026-08-13', paid_at: null, checkout_url: null, created_at: '2026-08-03' },
      { id: '5', account_id: 'a5', plan_name: 'Start', amount_cents: 8700, currency: 'BRL', status: 'pending', due_date: '2026-08-17', paid_at: null, checkout_url: null, created_at: '2026-07-29' },
      { id: '6', account_id: 'a4', plan_name: 'Start', amount_cents: 8700, currency: 'BRL', status: 'cancelled', due_date: '2026-07-13', paid_at: null, checkout_url: null, created_at: '2026-06-28' },
    ]
    h.accountRows = [
      { id: 'a1', name: 'Quântica Assessoria Digital' },
      { id: 'a2', name: 'Hidrofort industria e comercio de plastico' },
      { id: 'a3', name: 'LJ Climatização e Elétrica' },
      { id: 'a4', name: 'ZONTALK' },
      { id: 'a5', name: 'Ortobom Cruzeiro' },
    ]
    h.ownerRows = [{ account_id: 'a1', email: 'igordiniz0721@gmail.com' }]

    const res = await GET(new Request('http://localhost/api/admin/invoices'))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.summary).toEqual({
      faturamentoTotalCents: 14700 + 11000 + 14700 + 14700 + 8700, // excludes the cancelled 8700
      recebidoCents: 0,
      emAbertoCents: 14700 + 14700 + 8700, // the 3 'pending' rows only
      vencidoCents: 14700 + 11000, // the 2 'overdue' rows
      totalInvoices: 6, // includes the cancelled one
      invoicesPagas: 0,
      invoicesPendentes: 3,
      ticketMedioCents: 0, // no paid invoices — never divides by zero
    })
    expect(body.invoices).toHaveLength(6)
    expect(body.invoices[0]).toMatchObject({ accountId: 'a1', accountName: 'Quântica Assessoria Digital', ownerEmail: 'igordiniz0721@gmail.com' })
    // No owner row for a4 — joins to null, not a crash.
    expect(body.invoices.find((i: { accountId: string }) => i.accountId === 'a4')).toMatchObject({ ownerEmail: null })
  })

  it('computes a non-zero average ticket only from paid invoices', async () => {
    h.invoiceRows = [
      { id: '1', account_id: 'a1', plan_name: 'Premium', amount_cents: 10000, currency: 'BRL', status: 'paid', due_date: '2026-08-01', paid_at: '2026-08-01', checkout_url: null, created_at: '2026-07-01' },
      { id: '2', account_id: 'a1', plan_name: 'Premium', amount_cents: 20000, currency: 'BRL', status: 'paid', due_date: '2026-07-01', paid_at: '2026-07-01', checkout_url: null, created_at: '2026-06-01' },
    ]
    const res = await GET(new Request('http://localhost/api/admin/invoices'))
    const body = await res.json()
    expect(body.summary.ticketMedioCents).toBe(15000) // (10000+20000)/2
  })
})
