// ============================================================
// POST /api/v1/print-jobs/[id]/ack — acknowledge a print job
// (scope: print:write)
//
// Body: { status: 'printed' | 'failed', error?: string }
//
// Idempotent: if the job isn't `pending` anymore when this is called
// (duplicate ack from a flaky agent connection), it just returns the
// current state without reprocessing — never double-counts an
// attempt. On 'failed', backoff/terminal transition is computed by
// nextFailureState (src/lib/delivery/print-queue.ts).
// ============================================================

import { NextResponse } from 'next/server';
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, badRequest, toApiErrorResponse } from '@/lib/api/v1/respond';
import { nextFailureState } from '@/lib/delivery/print-queue';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'print:write');
    const { id } = await params;

    const body = await request.json().catch(() => null);
    const status = body?.status;
    if (status !== 'printed' && status !== 'failed') {
      throw badRequest("status must be 'printed' or 'failed'");
    }
    const errorMessage = typeof body?.error === 'string' ? body.error : null;

    const { data: job } = await ctx.supabase
      .from('print_jobs')
      .select('id, status, attempts')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (!job) {
      return NextResponse.json(
        { error: { code: 'not_found', message: 'Print job not found' } },
        { status: 404 },
      );
    }

    if (job.status !== 'pending') {
      return ok({ id: job.id, status: job.status, attempts: job.attempts });
    }

    if (status === 'printed') {
      await ctx.supabase
        .from('print_jobs')
        .update({ status: 'printed', printed_at: new Date().toISOString(), error: null })
        .eq('id', job.id);
      return ok({ id: job.id, status: 'printed', attempts: job.attempts });
    }

    const patch = nextFailureState(job.attempts, errorMessage);
    await ctx.supabase
      .from('print_jobs')
      .update({
        status: patch.status,
        attempts: patch.attempts,
        next_attempt_at: patch.next_attempt_at,
        error: patch.error,
      })
      .eq('id', job.id);
    return ok({ id: job.id, status: patch.status, attempts: patch.attempts });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
