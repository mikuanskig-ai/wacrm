-- ============================================================
-- 059_ai_groq_openrouter_provider.sql
--
-- Adds 'groq' and 'openrouter' to the BYO-key AI provider list
-- (src/lib/ai/providers/groq.ts, openrouter.ts), alongside OpenAI,
-- Anthropic and Gemini.
--
-- Also fixes a pre-existing bug found in production logs while making
-- this change: `ai_usage_log.provider` was never widened when Gemini
-- was added in 056, so every Gemini usage-log insert has been silently
-- failing its CHECK constraint (`logAiUsage` swallows the error) since
-- Gemini launched. Both tables' constraints are aligned here.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_provider_check;

ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'gemini', 'groq', 'openrouter'));

ALTER TABLE ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_provider_check;

ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'gemini', 'groq', 'openrouter'));
