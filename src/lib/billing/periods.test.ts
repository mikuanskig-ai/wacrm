import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { nextPeriod, toDateString, generateInvoice, reconcileInvoice, GRACE_DAYS, RENEWAL_LEAD_DAYS } from './invoices'

vi.mock('./infinitepay-api', () => ({
  checkPayment: vi.fn(),
}))
import { checkPayment } from './infinitepay-api'

describe('constants', () => {
  it('grace and renewal-lead windows match the plan', () => {
    expect(GRACE_DAYS).toBe(3)
    expect(RENEWAL_LEAD_DAYS).toBe(20)
  })
})

describe('toDateString', () => {
  it('formats as yyyy-MM-dd regardless of time-of-day', () => {
    expect(toDateString(new Date('2026-03-05T23:59:00Z'))).toBe('2026-03-05')
  })
})

describe('nextPeriod', () => {
  const start = new Date('2026-01-15T00:00:00Z')

  it('monthly adds 1 month', () => {
    const { periodEnd } = nextPeriod('monthly', start)
    expect(toDateString(periodEnd)).toBe('2026-02-15')
  })

  it('quarterly adds 3 months', () => {
    const { periodEnd } = nextPeriod('quarterly', start)
    expect(toDateString(periodEnd)).toBe('2026-04-15')
  })

  it('semiannual adds 6 months', () => {
    const { periodEnd } = nextPeriod('semiannual', start)
    expect(toDateString(periodEnd)).toBe('2026-07-15')
  })

  it('annual adds 12 months', () => {
    const { periodEnd } = nextPeriod('annual', start)
    expect(toDateString(periodEnd)).toBe('2027-01-15')
  })

  it('periodStart passes through unchanged', () => {
    const { periodStart } = nextPeriod('monthly', start)
    expect(periodStart).toBe(start)
  })
})

// ------------------------------------------------------------
// generateInvoice / reconcileInvoice — fake Supabase client
// ------------------------------------------------------------

function makeQueryChain<T extends Record<string, unknown>>(rows: T[], insertedRows: T[]) {
  let filtered = rows
  let pendingResult: T | null = null
  // Real Supabase builds a query object — `.update(patch).eq(...).eq(...)`
  // applies the eq()s as WHERE conditions regardless of call order.
  // This fake evaluates lazily too: `update()` only STAGES the patch;
  // it's applied to whatever `filtered` narrows down to by the time
  // the chain resolves (`.select()/.maybeSingle()/.then()`), not at
  // the moment `.update()` itself is called (which is BEFORE the
  // `.eq()` calls that follow it in the real call sites here).
  let stagedPatch: Partial<T> | null = null
  // Distinguishes "upsert explicitly decided the result is null" (a
  // conflict that got ignored) from "no upsert happened, fall back to
  // whatever .eq()/.in() narrowed to" — both look like `null` on
  // `pendingResult` otherwise.
  let resultDecided = false
  const apply = () => {
    if (!stagedPatch) return
    for (const match of filtered) {
      const idx = rows.indexOf(match)
      if (idx !== -1) Object.assign(rows[idx] as object, stagedPatch)
    }
    pendingResult = filtered[0] ? { ...filtered[0], ...stagedPatch } : null
    resultDecided = true
    stagedPatch = null
  }
  const chain = {
    select: () => chain,
    eq: (col: string, val: unknown) => {
      filtered = filtered.filter((r) => r[col] === val)
      return chain
    },
    in: (col: string, vals: unknown[]) => {
      filtered = filtered.filter((r) => vals.includes(r[col]))
      return chain
    },
    upsert: (row: T, opts: { onConflict: string; ignoreDuplicates?: boolean }) => {
      const [a, b] = opts.onConflict.split(',')
      const conflict = rows.some((r) => r[a] === row[a] && r[b] === row[b])
      pendingResult = conflict ? null : row
      resultDecided = true
      if (!conflict) {
        rows.push(row)
        insertedRows.push(row)
      }
      return chain
    },
    update: (patch: Partial<T>) => {
      stagedPatch = patch
      return chain
    },
    maybeSingle: () => {
      apply()
      return Promise.resolve({ data: resultDecided ? pendingResult : (filtered[0] ?? null), error: null })
    },
    then: (resolve: (v: { data: T[]; count: number; error: null }) => void) => {
      apply()
      resolve({ data: filtered, count: filtered.length, error: null })
    },
  }
  return chain
}

function makeDb(tables: Record<string, Record<string, unknown>[]>) {
  const inserted: Record<string, unknown>[] = []
  const db = {
    from: (table: string) => {
      if (!(table in tables)) throw new Error(`unexpected table in fake db: ${table}`)
      return makeQueryChain(tables[table], inserted)
    },
  } as unknown as SupabaseClient
  return { db, inserted }
}

describe('generateInvoice', () => {
  it('inserts a new invoice for an unseen period', async () => {
    const { db, inserted } = makeDb({ invoices: [] })
    const result = await generateInvoice(db, {
      accountId: 'acc-1',
      planId: 'plan-1',
      planName: 'Pro',
      amountCents: 9900,
      currency: 'BRL',
      periodStart: new Date('2026-01-01'),
      periodEnd: new Date('2026-02-01'),
      dueDate: new Date('2026-01-01'),
    })
    expect(result).not.toBeNull()
    expect(inserted).toHaveLength(1)
  })

  it('is a no-op (returns null) when that account+period already has an invoice', async () => {
    const { db } = makeDb({
      invoices: [{ account_id: 'acc-1', period_start: '2026-01-01' }],
    })
    const result = await generateInvoice(db, {
      accountId: 'acc-1',
      planId: 'plan-1',
      planName: 'Pro',
      amountCents: 9900,
      currency: 'BRL',
      periodStart: new Date('2026-01-01'),
      periodEnd: new Date('2026-02-01'),
      dueDate: new Date('2026-01-01'),
    })
    expect(result).toBeNull()
  })
})

describe('reconcileInvoice', () => {
  beforeEach(() => {
    vi.mocked(checkPayment).mockReset()
  })

  it('does nothing when the invoice has no checkout link yet', async () => {
    const { db } = makeDb({
      invoices: [{ id: 'inv-1', account_id: 'acc-1', amount_cents: 100, checkout_order_nsu: null, status: 'pending' }],
    })
    const result = await reconcileInvoice(db, 'inv-1')
    expect(result.status).toBe('unchanged')
    expect(checkPayment).not.toHaveBeenCalled()
  })

  it('does nothing when the gateway reports unpaid', async () => {
    vi.mocked(checkPayment).mockResolvedValue({ paid: false, paidAmountCents: 0 })
    const { db } = makeDb({
      invoices: [{ id: 'inv-1', account_id: 'acc-1', amount_cents: 100, checkout_order_nsu: 'inv-1', status: 'pending' }],
    })
    const result = await reconcileInvoice(db, 'inv-1')
    expect(result.status).toBe('unchanged')
  })

  it('marks paid and reactivates an account suspended for non-payment when this was its last outstanding invoice', async () => {
    vi.mocked(checkPayment).mockResolvedValue({ paid: true, paidAmountCents: 9900 })
    const tables = {
      invoices: [{ id: 'inv-1', account_id: 'acc-1', amount_cents: 9900, checkout_order_nsu: 'inv-1', status: 'overdue' }],
      accounts: [{ id: 'acc-1', status: 'suspended', suspended_reason: 'overdue' }],
    }
    const { db } = makeDb(tables)
    const result = await reconcileInvoice(db, 'inv-1')
    expect(result.status).toBe('paid')
    expect(tables.invoices[0].status).toBe('paid')
    expect(tables.accounts[0].status).toBe('active')
    expect(tables.accounts[0].suspended_reason).toBeNull()
  })

  it('does not reactivate a manually-suspended account even after its invoice is paid', async () => {
    vi.mocked(checkPayment).mockResolvedValue({ paid: true, paidAmountCents: 9900 })
    const tables = {
      invoices: [{ id: 'inv-1', account_id: 'acc-1', amount_cents: 9900, checkout_order_nsu: 'inv-1', status: 'overdue' }],
      accounts: [{ id: 'acc-1', status: 'suspended', suspended_reason: 'manual' }],
    }
    const { db } = makeDb(tables)
    await reconcileInvoice(db, 'inv-1')
    expect(tables.accounts[0].status).toBe('suspended')
    expect(tables.accounts[0].suspended_reason).toBe('manual')
  })

  it('does not mark paid when the gateway amount is short of the invoice amount', async () => {
    vi.mocked(checkPayment).mockResolvedValue({ paid: true, paidAmountCents: 50 })
    const { db } = makeDb({
      invoices: [{ id: 'inv-1', account_id: 'acc-1', amount_cents: 9900, checkout_order_nsu: 'inv-1', status: 'pending' }],
    })
    const result = await reconcileInvoice(db, 'inv-1')
    expect(result.status).toBe('unchanged')
  })
})
