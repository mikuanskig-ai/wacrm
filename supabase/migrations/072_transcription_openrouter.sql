-- ============================================================
-- 072_transcription_openrouter.sql
--
-- Widens `ai_configs.transcription_provider` to allow 'openrouter'.
-- Wasn't possible when 069 shipped (Groq/OpenAI were the only
-- Whisper-compatible endpoints around) — OpenRouter launched its own
-- `/api/v1/audio/transcriptions` endpoint on 2026-07-22, same
-- OpenAI-style multipart shape, billed through the same key as their
-- chat completions.
--
-- That last part is what makes this worth adding as more than "one
-- more option in the dropdown": when `transcription_provider =
-- 'openrouter'` and `transcription_api_key` is left unset, the app
-- layer (loadTranscriptionConfig, src/lib/ai/config.ts) now falls
-- back to the account's own `ai_configs.api_key` — but ONLY when the
-- main chat `provider` is also 'openrouter'. An account already
-- paying for OpenRouter chat doesn't need to sign up for a second
-- provider or paste the same key twice just to turn transcription on.
-- Any other transcription_provider still requires its own dedicated
-- key, same as before.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_transcription_provider_check;

ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_transcription_provider_check
  CHECK (transcription_provider IS NULL OR transcription_provider IN ('groq', 'openai', 'openrouter'));
