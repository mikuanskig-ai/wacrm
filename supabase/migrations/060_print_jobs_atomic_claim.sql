-- ============================================================
-- 060_print_jobs_atomic_claim.sql
--
-- Fixes a real double-print bug: GET /api/v1/print-jobs previously
-- just SELECTed pending jobs without claiming them. If more than one
-- print-agent process polls the same account at once (e.g. the local
-- agent left running twice on the shop's PC), both could fetch and
-- physically print the same job before either got around to acking
-- it — the DB only ever recorded the winning ack, so nothing in the
-- data looked wrong even though the customer's receipt printed twice.
--
-- Adds a 'claimed' intermediate status + claimed_at, and an atomic
-- claim_print_jobs() RPC using SELECT ... FOR UPDATE SKIP LOCKED so
-- concurrent pollers can never be handed the same job. A claim that's
-- never acked (agent crashed mid-print, or lost network right after)
-- becomes reclaimable after p_stale_after_seconds — printing is
-- effectively instant, so a job stuck in 'claimed' past that window
-- almost certainly means the agent that grabbed it never finished.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE print_jobs
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

ALTER TABLE print_jobs
  DROP CONSTRAINT IF EXISTS print_jobs_status_check;

ALTER TABLE print_jobs
  ADD CONSTRAINT print_jobs_status_check
  CHECK (status IN ('pending', 'claimed', 'printed', 'failed', 'skipped'));

CREATE OR REPLACE FUNCTION public.claim_print_jobs(
  p_account_id uuid,
  p_limit integer,
  p_stale_after_seconds integer DEFAULT 120
)
RETURNS SETOF print_jobs
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH eligible AS (
    SELECT id
    FROM print_jobs
    WHERE account_id = p_account_id
      AND (
        status = 'pending'
        OR (status = 'claimed' AND claimed_at < now() - make_interval(secs => p_stale_after_seconds))
      )
      AND (next_attempt_at IS NULL OR next_attempt_at <= now())
    ORDER BY created_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE print_jobs
  SET status = 'claimed', claimed_at = now()
  WHERE id IN (SELECT id FROM eligible)
  RETURNING *;
$function$;
