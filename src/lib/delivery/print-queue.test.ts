import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  supabaseAdmin: vi.fn(),
}));

vi.mock('@/lib/payments/admin-client', () => ({
  supabaseAdmin: mocks.supabaseAdmin,
}));

import { enqueuePrintJob, touchPrintAgentPoll, nextFailureState } from './print-queue';

function makeDb(opts: { enabled?: boolean; noConfigRow?: boolean; insertError?: string } = {}) {
  const inserted: Record<string, unknown>[] = [];
  const db = {
    from: (table: string) => {
      if (table === 'print_configs') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: opts.noConfigRow ? null : { enabled: opts.enabled ?? false },
                  error: null,
                }),
            }),
          }),
          update: () => ({
            eq: () => Promise.resolve({ error: null }),
          }),
        };
      }
      if (table === 'print_jobs') {
        return {
          insert: (row: Record<string, unknown>) => {
            inserted.push(row);
            return Promise.resolve({
              error: opts.insertError ? { message: opts.insertError } : null,
            });
          },
        };
      }
      throw new Error(`unexpected table in fake db: ${table}`);
    },
  };
  return { db, inserted };
}

beforeEach(() => {
  mocks.supabaseAdmin.mockReset();
});

describe('enqueuePrintJob', () => {
  it('inserts a print_jobs row when the account has print enabled', async () => {
    const { db, inserted } = makeDb({ enabled: true });
    mocks.supabaseAdmin.mockReturnValue(db);

    await enqueuePrintJob('acct-1', 'order-1');

    expect(inserted).toEqual([{ account_id: 'acct-1', order_id: 'order-1' }]);
  });

  it('does nothing when print is disabled', async () => {
    const { db, inserted } = makeDb({ enabled: false });
    mocks.supabaseAdmin.mockReturnValue(db);

    await enqueuePrintJob('acct-1', 'order-1');

    expect(inserted).toHaveLength(0);
  });

  it('does nothing when the account has no print_configs row at all', async () => {
    const { db, inserted } = makeDb({ noConfigRow: true });
    mocks.supabaseAdmin.mockReturnValue(db);

    await enqueuePrintJob('acct-1', 'order-1');

    expect(inserted).toHaveLength(0);
  });

  it('never throws, even when the insert fails', async () => {
    const { db } = makeDb({ enabled: true, insertError: 'boom' });
    mocks.supabaseAdmin.mockReturnValue(db);

    await expect(enqueuePrintJob('acct-1', 'order-1')).resolves.toBeUndefined();
  });

  it('never throws when supabaseAdmin() itself throws', async () => {
    mocks.supabaseAdmin.mockImplementation(() => {
      throw new Error('no service role key configured');
    });

    await expect(enqueuePrintJob('acct-1', 'order-1')).resolves.toBeUndefined();
  });
});

describe('touchPrintAgentPoll', () => {
  it('never throws even when the update fails', () => {
    mocks.supabaseAdmin.mockReturnValue({
      from: () => ({
        update: () => ({
          eq: () => Promise.resolve({ error: { message: 'boom' } }),
        }),
      }),
    });

    expect(() => touchPrintAgentPoll('acct-1')).not.toThrow();
  });
});

describe('nextFailureState', () => {
  it('stays pending with a backoff after the 1st failure', () => {
    const result = nextFailureState(0, 'paper jam');
    expect(result.status).toBe('pending');
    expect(result.attempts).toBe(1);
    expect(result.error).toBe('paper jam');
    expect(result.next_attempt_at).not.toBeNull();
    expect(new Date(result.next_attempt_at!).getTime()).toBeGreaterThan(Date.now());
  });

  it('backs off further after the 2nd failure than the 1st', () => {
    const first = nextFailureState(0, null);
    const second = nextFailureState(1, null);
    const firstDelay = new Date(first.next_attempt_at!).getTime() - Date.now();
    const secondDelay = new Date(second.next_attempt_at!).getTime() - Date.now();
    expect(secondDelay).toBeGreaterThan(firstDelay);
  });

  it('goes terminal on the 3rd failure', () => {
    const result = nextFailureState(2, 'printer offline');
    expect(result.status).toBe('failed');
    expect(result.attempts).toBe(3);
    expect(result.next_attempt_at).toBeNull();
    expect(result.error).toBe('printer offline');
  });
});
