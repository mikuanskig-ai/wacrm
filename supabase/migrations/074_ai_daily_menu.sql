-- ============================================================
-- 074_ai_daily_menu.sql
--
-- Purely informational per-weekday menu text (e.g. what's on the
-- buffet today, for accounts that build marmitas off a daily spread)
-- — same {mon: "...", ..., sun: "..."} shape as ai_configs.hours
-- (migration 070), just free text instead of {open, close}. Doesn't
-- affect ordering or pricing (see day_price_overrides for that,
-- src/lib/delivery/day-price.ts — a separate, already-working
-- mechanism); the AI just recites today's entry when asked.
--
-- Missing key or null value = nothing special that day, same
-- "no line = default" convention as hours. Edited from the Cardápio
-- screen (src/app/(dashboard)/delivery/cardapio), not Configuração
-- de IA — but stored here because this is what buildSystemPrompt
-- reads from.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS daily_menu jsonb NOT NULL DEFAULT '{}'::jsonb;
