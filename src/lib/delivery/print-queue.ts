// ============================================================
// Cloud-side print queue — enqueues a print_jobs row per order when
// an account has opted in (print_configs.enabled), and bumps the
// "agent last seen" indicator whenever any valid API key polls for
// jobs. The local agent that actually talks to a physical thermal
// printer is a separate, not-yet-built consumer of
// GET/POST /api/v1/print-jobs*.
//
// Both functions build their own supabaseAdmin() rather than take a
// `db` parameter — mirrors runAutomationsForTrigger
// (src/lib/automations/engine.ts), the precedent for this class of
// side effect (fire-alongside-the-order, cross-cutting, not a direct
// dependency of order-creation itself). Only 1 of finalizeDeliveryOrder's
// 4 callers passes a non-admin session client; forcing print_jobs
// writes to also work under that client's RLS would mean opening
// write policies to the `agent` role for no real benefit, and other
// code in this app (dispatchWebhookEvent's `db`-reused update) shows
// that pattern already causes a silent under-RLS no-op bug elsewhere.
// ============================================================

import { supabaseAdmin } from '@/lib/payments/admin-client';

const RETRY_BACKOFF_SECONDS = 60;
const MAX_ATTEMPTS = 3;

/**
 * Inserts a print_jobs row for a newly-created order, if the account
 * has print_configs.enabled. Never throws — a failure here must never
 * block order creation, same contract as the Mercado Pago preference
 * block in create-order.ts.
 */
export async function enqueuePrintJob(accountId: string, orderId: string): Promise<void> {
  try {
    const db = supabaseAdmin();
    const { data: config } = await db
      .from('print_configs')
      .select('enabled')
      .eq('account_id', accountId)
      .maybeSingle();

    if (!config?.enabled) return;

    const { error } = await db.from('print_jobs').insert({
      account_id: accountId,
      order_id: orderId,
    });
    if (error) {
      console.error('[print-queue] failed to enqueue print job:', error.message);
    }
  } catch (err) {
    console.error('[print-queue] failed to enqueue print job:', err);
  }
}

/** Fire-and-forget — mirrors touchLastUsed (src/lib/api-keys/store.ts). */
export function touchPrintAgentPoll(accountId: string): void {
  void supabaseAdmin()
    .from('print_configs')
    .update({ last_polled_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .then(({ error }) => {
      if (error) {
        console.warn('[print-queue] last_polled_at bump failed:', error.message);
      }
    });
}

/**
 * Applies a failed print attempt: increments `attempts`, and either
 * schedules a backed-off retry (still `pending`) or, past
 * MAX_ATTEMPTS, marks the job terminally `failed`. Pure computation —
 * the caller performs the actual DB update with the returned patch.
 */
export function nextFailureState(
  attempts: number,
  errorMessage: string | null,
): { status: 'pending' | 'failed'; attempts: number; next_attempt_at: string | null; error: string | null } {
  const nextAttempts = attempts + 1;
  if (nextAttempts >= MAX_ATTEMPTS) {
    return { status: 'failed', attempts: nextAttempts, next_attempt_at: null, error: errorMessage };
  }
  const nextAttemptAt = new Date(Date.now() + nextAttempts * RETRY_BACKOFF_SECONDS * 1000);
  return {
    status: 'pending',
    attempts: nextAttempts,
    next_attempt_at: nextAttemptAt.toISOString(),
    error: errorMessage,
  };
}
