-- ============================================================
-- 047_delivery_business_hours.sql — Zontalk Delivery module (Fase 5: Operação).
--
-- Adds:
--   1. `delivery_business_hours` — opt-in weekly schedule (mirrors
--      payment_configs/ai_configs: one row per account, `enabled`
--      toggle). Only gates the self-service order channels (WhatsApp
--      Flow / AI chat) — a staff member creating a manual order is
--      never blocked by this. `hours` is a fixed weekly grid, no
--      holiday exceptions, no overnight-crossing spans (18:00–02:00) —
--      deliberately out of scope for this pass.
--
--   2. `delivery_orders.status_changed_at` — separate from the
--      generic `updated_at` (touched by ANY write, including the
--      Fase 4 payment webhook updating `payment_status`), so the
--      operations board's "how long has this been sitting" clock only
--      moves when `status` itself actually changes.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- BUSINESS HOURS
-- ============================================================
CREATE TABLE IF NOT EXISTS delivery_business_hours (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  -- IANA zone (e.g. 'America/Sao_Paulo'). The check runs server-side
  -- (inside the AI tool loop / Flow engine, no browser context), so a
  -- fixed zone is required — there's no per-request "local time" to
  -- fall back on.
  timezone    TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  enabled     BOOLEAN NOT NULL DEFAULT false,
  -- { "mon": {"open":"09:00","close":"22:00"}, "tue": null, ... }
  -- Missing key or null value = closed that day. Keys are the 3-letter
  -- English day abbreviations (same neutral-key-translated-in-the-UI
  -- convention as delivery_orders.status / payment_status).
  hours       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_delivery_business_hours_account ON delivery_business_hours(account_id);

ALTER TABLE delivery_business_hours ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS delivery_business_hours_select ON delivery_business_hours;
CREATE POLICY delivery_business_hours_select ON delivery_business_hours FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS delivery_business_hours_insert ON delivery_business_hours;
CREATE POLICY delivery_business_hours_insert ON delivery_business_hours FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS delivery_business_hours_update ON delivery_business_hours;
CREATE POLICY delivery_business_hours_update ON delivery_business_hours FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS delivery_business_hours_delete ON delivery_business_hours;
CREATE POLICY delivery_business_hours_delete ON delivery_business_hours FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON delivery_business_hours;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON delivery_business_hours
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- delivery_orders — status_changed_at
--
-- The backfill must only run the first time this column is added —
-- ADD COLUMN ... DEFAULT now() stamps every existing row with the
-- single timestamp the ALTER executed at, not each row's own
-- created_at, so a one-time correction is needed. Wrapped in a column-
-- existence check so re-running this migration (the idempotent
-- contract every migration here follows) never re-stamps orders whose
-- status has legitimately moved on since.
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'delivery_orders' AND column_name = 'status_changed_at'
  ) THEN
    ALTER TABLE delivery_orders ADD COLUMN status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now();
    UPDATE delivery_orders SET status_changed_at = created_at;
  END IF;
END $$;
