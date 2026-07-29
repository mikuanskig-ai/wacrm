-- ============================================================
-- 050_print_queue.sql — Zontalk Delivery module (cloud-side print queue).
--
-- Cloud half of automatic kitchen-receipt printing. The physical
-- thermal printer (network or USB) is talked to by a separate local
-- agent, not built in this pass — this migration only adds the queue
-- that agent will poll via a scoped API key
-- (print:read/print:write, src/lib/api-keys/scopes.ts).
--
--   1. `print_configs` — opt-in per account (mirrors payment_configs/
--      delivery_business_hours: one row per account, `enabled`
--      toggle). `last_polled_at` is bumped by ANY valid API key
--      hitting GET /api/v1/print-jobs, not tied to one specific key
--      row, so rotating the agent's key doesn't break the "agent last
--      seen" indicator in Settings.
--
--   2. `print_jobs` — one row per order that should be printed.
--      Enqueued by `enqueuePrintJob` (src/lib/delivery/print-queue.ts)
--      using its own service-role client, never the caller's session
--      client — only 1 of finalizeDeliveryOrder's 4 callers passes a
--      non-admin session client, and the two consumer routes
--      (GET/ack) always run as service-role via requireApiKey anyway,
--      so there's no reason to open write RLS to any session role
--      here. `next_attempt_at` backs off a failed job (60s after the
--      1st failure, 120s after the 2nd) so an agent polling every few
--      seconds can't burn through the 3-attempt cap before anyone
--      notices the printer jam; the 3rd failure is terminal (`failed`).
--      `skipped` covers a job whose order got cancelled before it was
--      served.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- PRINT CONFIGS
-- ============================================================
CREATE TABLE IF NOT EXISTS print_configs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  enabled         BOOLEAN NOT NULL DEFAULT false,
  last_polled_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_print_configs_account ON print_configs(account_id);

ALTER TABLE print_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS print_configs_select ON print_configs;
CREATE POLICY print_configs_select ON print_configs FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS print_configs_insert ON print_configs;
CREATE POLICY print_configs_insert ON print_configs FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS print_configs_update ON print_configs;
CREATE POLICY print_configs_update ON print_configs FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS print_configs_delete ON print_configs;
CREATE POLICY print_configs_delete ON print_configs FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON print_configs;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON print_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- PRINT JOBS
-- ============================================================
CREATE TABLE IF NOT EXISTS print_jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  order_id         UUID NOT NULL REFERENCES delivery_orders(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                     'pending', 'printed', 'failed', 'skipped'
                   )),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ,
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  printed_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_print_jobs_account_status ON print_jobs(account_id, status);
CREATE INDEX IF NOT EXISTS idx_print_jobs_order ON print_jobs(order_id);

ALTER TABLE print_jobs ENABLE ROW LEVEL SECURITY;

-- Member-readable (any role) — useful for a future "print queue
-- status" panel, no security cost since only service-role ever
-- writes. No INSERT/UPDATE/DELETE policy for session clients on
-- purpose: the enqueue helper and the /api/v1/print-jobs* routes
-- always run as service-role (bypasses RLS by definition), so there's
-- no legitimate session-client writer to grant a role tier to.
DROP POLICY IF EXISTS print_jobs_select ON print_jobs;
CREATE POLICY print_jobs_select ON print_jobs FOR SELECT
  USING (is_account_member(account_id));
