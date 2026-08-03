import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getAccountPlan, countSeats, canInvite } from './plans'

function makeQueryChain<T extends Record<string, unknown>>(rows: T[]) {
  let filtered = rows
  const chain = {
    select: () => chain,
    eq: (col: string, val: unknown) => {
      filtered = filtered.filter((r) => r[col] === val)
      return chain
    },
    is: (col: string, val: unknown) => {
      filtered = filtered.filter((r) => r[col] === val)
      return chain
    },
    gt: (col: string, val: string) => {
      filtered = filtered.filter((r) => (r[col] as string) > val)
      return chain
    },
    maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
    then: (resolve: (v: { data: T[]; count: number; error: null }) => void) =>
      resolve({ data: filtered, count: filtered.length, error: null }),
  }
  return chain
}

function makeDb(tables: Record<string, Record<string, unknown>[]>) {
  return {
    from: (table: string) => {
      if (!(table in tables)) throw new Error(`unexpected table in fake db: ${table}`)
      return makeQueryChain(tables[table])
    },
  } as unknown as SupabaseClient
}

describe('getAccountPlan', () => {
  it('resolves the assigned plan', async () => {
    const db = makeDb({
      accounts: [{ id: 'acc-1', plan_id: 'plan-1' }],
      plans: [{ id: 'plan-1', name: 'Pro', max_users: 5, enabled_modules: ['delivery'] }],
    })
    const plan = await getAccountPlan(db, 'acc-1')
    expect(plan).toEqual({
      id: 'plan-1',
      name: 'Pro',
      maxUsers: 5,
      enabledModules: ['delivery'],
      billable: true,
    })
  })

  it('falls back to the permissive no-plan default when plan_id is null', async () => {
    const db = makeDb({ accounts: [{ id: 'acc-1', plan_id: null }], plans: [] })
    const plan = await getAccountPlan(db, 'acc-1')
    expect(plan.billable).toBe(false)
    expect(plan.maxUsers).toBeNull()
    expect(plan.enabledModules).toContain('delivery')
  })

  it('falls back to the permissive default when the plan row is missing (RESTRICT should prevent this, defensive only)', async () => {
    const db = makeDb({ accounts: [{ id: 'acc-1', plan_id: 'ghost' }], plans: [] })
    const plan = await getAccountPlan(db, 'acc-1')
    expect(plan.billable).toBe(false)
  })
})

describe('countSeats', () => {
  it('counts members plus outstanding invitations', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString()
    const db = makeDb({
      profiles: [{ id: 'p1', account_id: 'acc-1' }, { id: 'p2', account_id: 'acc-1' }],
      account_invitations: [
        { id: 'i1', account_id: 'acc-1', accepted_at: null, expires_at: future },
      ],
    })
    expect(await countSeats(db, 'acc-1')).toBe(3)
  })

  it('excludes accepted or expired invitations', async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString()
    const db = makeDb({
      profiles: [{ id: 'p1', account_id: 'acc-1' }],
      account_invitations: [
        { id: 'i1', account_id: 'acc-1', accepted_at: '2026-01-01', expires_at: past },
        { id: 'i2', account_id: 'acc-1', accepted_at: null, expires_at: past },
      ],
    })
    expect(await countSeats(db, 'acc-1')).toBe(1)
  })
})

describe('canInvite', () => {
  it('allows unlimited seats when maxUsers is null', () => {
    expect(canInvite({ id: 'p', name: '', maxUsers: null, enabledModules: [], billable: true }, 999)).toBe(true)
  })

  it('blocks at the limit', () => {
    const plan = { id: 'p', name: '', maxUsers: 5, enabledModules: [], billable: true }
    expect(canInvite(plan, 4)).toBe(true)
    expect(canInvite(plan, 5)).toBe(false)
  })
})
