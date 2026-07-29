import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireApiKey: vi.fn(),
  touchPrintAgentPoll: vi.fn(),
}));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: mocks.requireApiKey,
}));

vi.mock('@/lib/delivery/print-queue', () => ({
  touchPrintAgentPoll: mocks.touchPrintAgentPoll,
}));

import { GET } from './route';

// Generic chainable fake query builder shared across the tables this
// route touches. Each eq/in call narrows the seeded rows in-memory;
// `update` mutates the underlying array in place (by id) so a later
// query against the same table sees the effect, same as Postgres
// would. `select(cols, {count:'exact'})` flips the resolved shape to
// include `count` instead of `data`.
function makeTable(rows: Record<string, unknown>[]) {
  function chain(scope: Record<string, unknown>[]) {
    let filtered = scope;
    let countMode = false;
    const c = {
      select: (_cols?: string, opts?: { count?: string }) => {
        if (opts?.count) countMode = true;
        return c;
      },
      eq: (col: string, val: unknown) => {
        filtered = filtered.filter((r) => r[col] === val);
        return c;
      },
      in: (col: string, vals: unknown[]) => {
        filtered = filtered.filter((r) => vals.includes(r[col]));
        return c;
      },
      or: () => c,
      order: () => c,
      limit: () => c,
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      update: (patch: Record<string, unknown>) => ({
        in: (col: string, vals: unknown[]) => {
          for (const row of rows) {
            if (vals.includes(row[col])) Object.assign(row, patch);
          }
          return Promise.resolve({ error: null });
        },
        eq: (col: string, val: unknown) => {
          for (const row of rows) {
            if (row[col] === val) Object.assign(row, patch);
          }
          return Promise.resolve({ error: null });
        },
      }),
      then: (resolve: (v: { data: unknown; error: null; count?: number }) => void) =>
        resolve(countMode ? { data: null, error: null, count: filtered.length } : { data: filtered, error: null }),
    };
    return c;
  }
  return () => chain(rows);
}

function makeDb(seed: {
  accounts?: Record<string, unknown>[];
  print_jobs?: Record<string, unknown>[];
  delivery_orders?: Record<string, unknown>[];
  delivery_order_items?: Record<string, unknown>[];
}) {
  const tables: Record<string, Record<string, unknown>[]> = {
    accounts: seed.accounts ?? [],
    print_jobs: seed.print_jobs ?? [],
    delivery_orders: seed.delivery_orders ?? [],
    delivery_order_items: seed.delivery_order_items ?? [],
  };
  return {
    from: (table: string) => {
      if (!(table in tables)) throw new Error(`unexpected table: ${table}`);
      return makeTable(tables[table])();
    },
  };
}

function request() {
  return new Request('http://localhost/api/v1/print-jobs', { method: 'GET' });
}

beforeEach(() => {
  mocks.requireApiKey.mockReset();
  mocks.touchPrintAgentPoll.mockReset();
});

describe('GET /api/v1/print-jobs', () => {
  it('returns pending jobs with the embedded receipt', async () => {
    const db = makeDb({
      accounts: [{ id: 'acct-1', name: 'Pizzaria' }],
      print_jobs: [
        { id: 'job-1', order_id: 'order-1', account_id: 'acct-1', status: 'pending', attempts: 0, created_at: '2026-01-01T00:00:00Z', next_attempt_at: null },
      ],
      delivery_orders: [
        {
          id: 'order-1',
          status: 'pending_confirmation',
          source: 'whatsapp_flow',
          customer_name: 'Maria',
          delivery_address: 'Rua X, 123',
          notes: null,
          subtotal: 45,
          delivery_fee: 5,
          total: 50,
          currency: 'BRL',
          created_at: '2026-01-01T00:00:00Z',
          contact: null,
        },
      ],
      delivery_order_items: [
        { order_id: 'order-1', product_name: 'Pizza', quantity: 1, unit_price: 45, addons_snapshot: [], line_total: 45, notes: null },
      ],
    });
    mocks.requireApiKey.mockResolvedValue({ supabase: db, accountId: 'acct-1' });

    const res = await GET(request());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.account_name).toBe('Pizzaria');
    expect(body.data.pending_count).toBe(1);
    expect(body.data.jobs).toHaveLength(1);
    expect(body.data.jobs[0].receipt.customer_name).toBe('Maria');
    expect(body.data.jobs[0].receipt.items).toHaveLength(1);
    expect(mocks.touchPrintAgentPoll).toHaveBeenCalledWith('acct-1');
  });

  it('prefers the linked contact name over customer_name', async () => {
    const db = makeDb({
      accounts: [{ id: 'acct-1', name: 'Pizzaria' }],
      print_jobs: [
        { id: 'job-1', order_id: 'order-1', account_id: 'acct-1', status: 'pending', attempts: 0, created_at: '2026-01-01T00:00:00Z', next_attempt_at: null },
      ],
      delivery_orders: [
        {
          id: 'order-1', status: 'confirmed', source: 'ai_chat', customer_name: null,
          delivery_address: null, notes: null, subtotal: 10, delivery_fee: null, total: 10,
          currency: 'BRL', created_at: '2026-01-01T00:00:00Z',
          contact: { name: 'João', phone: '5511999999999' },
        },
      ],
      delivery_order_items: [],
    });
    mocks.requireApiKey.mockResolvedValue({ supabase: db, accountId: 'acct-1' });

    const res = await GET(request());
    const body = await res.json();
    expect(body.data.jobs[0].receipt.customer_name).toBe('João');
    expect(body.data.jobs[0].receipt.customer_phone).toBe('5511999999999');
  });

  it('skips and excludes a job whose order was cancelled', async () => {
    const printJobs = [
      { id: 'job-1', order_id: 'order-1', account_id: 'acct-1', status: 'pending', attempts: 0, created_at: '2026-01-01T00:00:00Z', next_attempt_at: null },
    ];
    const db = makeDb({
      accounts: [{ id: 'acct-1', name: 'Pizzaria' }],
      print_jobs: printJobs,
      delivery_orders: [
        {
          id: 'order-1', status: 'cancelled', source: 'manual', customer_name: 'Maria',
          delivery_address: null, notes: null, subtotal: 10, delivery_fee: null, total: 10,
          currency: 'BRL', created_at: '2026-01-01T00:00:00Z', contact: null,
        },
      ],
      delivery_order_items: [],
    });
    mocks.requireApiKey.mockResolvedValue({ supabase: db, accountId: 'acct-1' });

    const res = await GET(request());
    const body = await res.json();
    expect(body.data.jobs).toHaveLength(0);
    expect(body.data.pending_count).toBe(0);
    expect(printJobs[0].status).toBe('skipped');
  });
});
