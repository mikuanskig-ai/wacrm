-- ============================================================
-- 070_ai_business_hours.sql
--
-- Optional business-hours gate for the AI auto-reply bot — separate
-- from delivery_business_hours (migration 047), which only ever
-- gated order finalization (the place_order tool / order_summary
-- Flow node), never whether the bot replies at all. An account may
-- use the same WhatsApp number for things other than orders outside
-- those hours, so the two schedules are intentionally independent:
-- an account with no Delivery module still gets this.
--
-- Same JSONB shape as delivery_business_hours.hours on purpose —
-- reuses the exact pure isWithinBusinessHours() check
-- (src/lib/delivery/business-hours.ts) unmodified, just fed from a
-- different source. No row / hours_enabled = false = the bot behaves
-- exactly as it does today (no hours gate).
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS hours_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hours_timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
  ADD COLUMN IF NOT EXISTS hours jsonb NOT NULL DEFAULT '{}'::jsonb;
