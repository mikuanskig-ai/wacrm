import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  db: null as unknown,
}))

vi.mock('@/lib/auth/platform-admin', () => ({ requirePlatformAdmin: h.requirePlatformAdmin }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => h.db }))

/** Same call-order-queue fake as the stats route's own test — rows are
 *  consumed per table in the exact sequence route.ts awaits them.
 *  Filter correctness is the query builder's job; what's worth locking
 *  in here is the Fase-4 addition: `revenue_paid_cents` summed only
 *  from the second (paid-only) `invoices` query, and `plan_id` passed
 *  through so the Empresas tab can reassign a plan inline. */
function fakeDb(sequences: Record<string, unknown[][]>) {
  const cursors: Record<string, number> = {}
  return {
    from: (table: string) => {
      const chain = {
        select: () => chain,
        order: () => chain,
        eq: () => chain,
        in: () => chain,
        then: (resolve: (v: { data: unknown; error: null }) => void) => {
          const queue = sequences[table] ?? []
          const i = cursors[table] ?? 0
          cursors[table] = i + 1
          return resolve({ data: queue[i] ?? [], error: null })
        },
      }
      return chain
    },
  }
}

import { GET } from './route'

beforeEach(() => {
  h.requirePlatformAdmin.mockReset()
  h.requirePlatformAdmin.mockResolvedValue({ supabase: {}, userId: 'admin-1' })
})

describe('GET /api/admin/accounts', () => {
  it('propagates the platform-admin gate (403) when the caller is not a platform admin', async () => {
    const { ForbiddenError } = await import('@/lib/auth/account')
    h.requirePlatformAdmin.mockRejectedValue(new ForbiddenError('Platform admin only'))
    const res = await GET()
    expect(res.status).toBe(403)
  })

  it('returns an empty list without querying anything else when there are no accounts', async () => {
    h.db = fakeDb({ accounts: [[]] })
    const res = await GET()
    const body = await res.json()
    expect(body.accounts).toEqual([])
  })

  it('sums lifetime revenue from paid invoices only, and passes plan_id through', async () => {
    h.db = fakeDb({
      accounts: [
        [
          { id: 'a1', name: 'Churrascaria Concórdia', slug: 'concordia', status: 'active', suspended_reason: null, enabled_modules: ['delivery'], plan_id: 'p1', created_at: '2026-01-01' },
          { id: 'a2', name: 'Sem Plano LTDA', slug: 'sem-plano', status: 'suspended', suspended_reason: 'manual', enabled_modules: [], plan_id: null, created_at: '2026-02-01' },
        ],
      ],
      profiles: [[{ account_id: 'a1', email: 'dono@concordia.com' }]],
      whatsapp_config: [[{ account_id: 'a1', status: 'connected', connected_at: '2026-01-02' }]],
      plans: [[{ id: 'p1', name: 'Premium' }]],
      invoices: [
        [{ account_id: 'a1', status: 'overdue' }], // outstanding query
        [
          { account_id: 'a1', amount_cents: 14700 },
          { account_id: 'a1', amount_cents: 14700 },
        ], // paid query — a2 never appears, has no paid invoices
      ],
    })

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()

    const a1 = body.accounts.find((a: { id: string }) => a.id === 'a1')
    const a2 = body.accounts.find((a: { id: string }) => a.id === 'a2')

    expect(a1).toMatchObject({ plan_id: 'p1', plan_name: 'Premium', billing_status: 'overdue', revenue_paid_cents: 29400 })
    expect(a2).toMatchObject({ plan_id: null, plan_name: null, billing_status: 'current', revenue_paid_cents: 0 })
  })
})
