import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  db: null as unknown,
}))

vi.mock('@/lib/auth/platform-admin', () => ({ requirePlatformAdmin: h.requirePlatformAdmin }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => h.db }))

/** Counts (or invoice-row arrays) are consumed in call ORDER per
 *  table — matches the exact Promise.all sequence in route.ts. Filter
 *  correctness (`.eq`/`.gte`/`.in` actually narrowing the right rows)
 *  is Supabase's own query builder's job, not re-tested here; this
 *  only exercises the route's own wiring — response shape, `?? 0`
 *  defaults, and the invoices amount_cents sum. */
function fakeDb(sequences: Record<string, unknown[]>) {
  const cursors: Record<string, number> = {}
  return {
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        gte: () => chain,
        in: () => chain,
        then: (resolve: (v: { count: number | null; data: unknown }) => void) => {
          const queue = sequences[table] ?? []
          const i = cursors[table] ?? 0
          cursors[table] = i + 1
          const value = queue[i]
          if (Array.isArray(value)) return resolve({ count: null, data: value })
          return resolve({ count: (value as number) ?? 0, data: null })
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

describe('GET /api/admin/stats', () => {
  it('propagates the platform-admin gate (403) when the caller is not a platform admin', async () => {
    const { ForbiddenError } = await import('@/lib/auth/account')
    h.requirePlatformAdmin.mockRejectedValue(new ForbiddenError('Platform admin only'))
    const res = await GET()
    expect(res.status).toBe(403)
  })

  it('assembles platform-wide counts into the expected response shape', async () => {
    h.db = fakeDb({
      accounts: [10, 7, 1, 2], // total, active, suspended-manual, suspended-overdue
      profiles: [25],
      member_presence: [3],
      whatsapp_config: [9, 6], // total, connected
      conversations: [500, 40, 120, 340], // total, open, pending, closed
      contacts: [1000],
      messages: [20000, 8000, 12000], // total, sent, received
      invoices: [
        [{ amount_cents: 5000 }, { amount_cents: 3000 }], // paid
        [{ amount_cents: 2000 }], // outstanding
      ],
    })

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(body.accounts).toEqual({ total: 10, active: 7, suspendedManual: 1, suspendedOverdue: 2 })
    expect(body.users).toEqual({ total: 25, online: 3 })
    expect(body.connections).toEqual({ total: 9, connected: 6 })
    expect(body.conversations).toEqual({ total: 500, open: 40, pending: 120, closed: 340 })
    expect(body.contacts).toEqual({ total: 1000 })
    expect(body.messages).toEqual({ total: 20000, sent: 8000, received: 12000 })
    expect(body.invoices).toEqual({ paidCents: 8000, outstandingCents: 2000 })
  })

  it('defaults every count to 0 when Supabase returns a null count (e.g. an empty table)', async () => {
    h.db = fakeDb({
      accounts: [null, null, null, null],
      profiles: [null],
      member_presence: [null],
      whatsapp_config: [null, null],
      conversations: [null, null, null, null],
      contacts: [null],
      messages: [null, null, null],
      invoices: [[], []],
    })
    const res = await GET()
    const body = await res.json()
    expect(body.accounts).toEqual({ total: 0, active: 0, suspendedManual: 0, suspendedOverdue: 0 })
    expect(body.invoices).toEqual({ paidCents: 0, outstandingCents: 0 })
  })
})
