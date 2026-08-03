-- ============================================================
-- 056_ai_gemini_provider.sql
--
-- Adds 'gemini' to `ai_configs.provider` — a third BYO-key AI provider
-- alongside OpenAI and Anthropic (src/lib/ai/providers/gemini.ts).
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_provider_check;

ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'gemini'));
