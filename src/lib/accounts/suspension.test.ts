import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isAccountSuspended, getSuspendedAccountIds } from './suspension';

function makeQueryChain<T extends Record<string, unknown>>(rows: T[]) {
  let filtered = rows;
  const chain = {
    select: () => chain,
    eq: (col: string, val: unknown) => {
      filtered = filtered.filter((r) => r[col] === val);
      return chain;
    },
    maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
    then: (resolve: (v: { data: T[]; error: null }) => void) => resolve({ data: filtered, error: null }),
  };
  return chain;
}

function makeDb(accounts: Record<string, unknown>[]) {
  return {
    from: (table: string) => {
      if (table !== 'accounts') throw new Error(`unexpected table in fake db: ${table}`);
      return makeQueryChain(accounts);
    },
  } as unknown as SupabaseClient;
}

describe('isAccountSuspended', () => {
  it('is true for a suspended account', async () => {
    const db = makeDb([{ id: 'acc-1', status: 'suspended' }]);
    expect(await isAccountSuspended(db, 'acc-1')).toBe(true);
  });

  it('is false for an active account', async () => {
    const db = makeDb([{ id: 'acc-1', status: 'active' }]);
    expect(await isAccountSuspended(db, 'acc-1')).toBe(false);
  });

  it('is false when the account row is missing', async () => {
    const db = makeDb([]);
    expect(await isAccountSuspended(db, 'unknown')).toBe(false);
  });
});

describe('getSuspendedAccountIds', () => {
  it('returns only the suspended account ids', async () => {
    const db = makeDb([
      { id: 'acc-1', status: 'suspended' },
      { id: 'acc-2', status: 'active' },
      { id: 'acc-3', status: 'suspended' },
    ]);
    const ids = await getSuspendedAccountIds(db);
    expect(ids).toEqual(new Set(['acc-1', 'acc-3']));
  });

  it('returns an empty set when nothing is suspended', async () => {
    const db = makeDb([]);
    const ids = await getSuspendedAccountIds(db);
    expect(ids.size).toBe(0);
  });
});
