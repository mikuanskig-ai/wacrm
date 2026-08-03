import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireApiKey: vi.fn(),
}));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: mocks.requireApiKey,
}));

import { POST } from './route';

function makeDb(job: Record<string, unknown> | null) {
  const state = job ? { ...job } : null;
  const db = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: state, error: null }),
          }),
        }),
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: () => {
          if (state) Object.assign(state, patch);
          return Promise.resolve({ error: null });
        },
      }),
    }),
  };
  return { db, state: () => state };
}

function request(body: unknown) {
  return new Request('http://localhost/api/v1/print-jobs/job-1/ack', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: 'job-1' }) };

beforeEach(() => {
  mocks.requireApiKey.mockReset();
});

describe('POST /api/v1/print-jobs/[id]/ack', () => {
  it('marks a pending job printed', async () => {
    const { db, state } = makeDb({ id: 'job-1', status: 'pending', attempts: 0 });
    mocks.requireApiKey.mockResolvedValue({ supabase: db, accountId: 'acct-1' });

    const res = await POST(request({ status: 'printed' }), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ id: 'job-1', status: 'printed' });
    expect(state()!.status).toBe('printed');
    expect(state()!.printed_at).toBeTruthy();
  });

  it('marks a claimed job printed (the normal case since claim_print_jobs, migration 060)', async () => {
    const { db, state } = makeDb({ id: 'job-1', status: 'claimed', attempts: 0 });
    mocks.requireApiKey.mockResolvedValue({ supabase: db, accountId: 'acct-1' });

    const res = await POST(request({ status: 'printed' }), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ id: 'job-1', status: 'printed' });
    expect(state()!.status).toBe('printed');
  });

  it('backs off (stays pending) on the 1st and 2nd failure, goes terminal on the 3rd', async () => {
    const { db: db1, state: state1 } = makeDb({ id: 'job-1', status: 'pending', attempts: 0 });
    mocks.requireApiKey.mockResolvedValue({ supabase: db1, accountId: 'acct-1' });
    const res1 = await POST(request({ status: 'failed', error: 'jam' }), params);
    expect((await res1.json()).data.status).toBe('pending');
    expect(state1()!.attempts).toBe(1);
    expect(state1()!.next_attempt_at).toBeTruthy();

    const { db: db2 } = makeDb({ id: 'job-1', status: 'pending', attempts: 2 });
    mocks.requireApiKey.mockResolvedValue({ supabase: db2, accountId: 'acct-1' });
    const res2 = await POST(request({ status: 'failed', error: 'jam' }), params);
    const body2 = await res2.json();
    expect(body2.data.status).toBe('failed');
    expect(body2.data.attempts).toBe(3);
  });

  it('is idempotent — acking an already-terminal job just returns its state', async () => {
    const { db, state } = makeDb({ id: 'job-1', status: 'printed', attempts: 1 });
    mocks.requireApiKey.mockResolvedValue({ supabase: db, accountId: 'acct-1' });

    const res = await POST(request({ status: 'failed', error: 'late retry' }), params);
    const body = await res.json();
    expect(body.data).toMatchObject({ id: 'job-1', status: 'printed', attempts: 1 });
    expect(state()!.status).toBe('printed'); // untouched, not reprocessed
  });

  it('returns 404 for a job that does not belong to this account', async () => {
    const { db } = makeDb(null);
    mocks.requireApiKey.mockResolvedValue({ supabase: db, accountId: 'acct-1' });

    const res = await POST(request({ status: 'printed' }), params);
    expect(res.status).toBe(404);
  });

  it('rejects an invalid status value', async () => {
    const { db } = makeDb({ id: 'job-1', status: 'pending', attempts: 0 });
    mocks.requireApiKey.mockResolvedValue({ supabase: db, accountId: 'acct-1' });

    const res = await POST(request({ status: 'done' }), params);
    expect(res.status).toBe(400);
  });
});
