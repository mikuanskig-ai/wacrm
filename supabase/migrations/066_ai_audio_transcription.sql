-- ============================================================
-- 066_ai_audio_transcription.sql
--
-- Optional, independent BYO-key slot for speech-to-text — same
-- precedent as `embeddings_api_key` (migration 030): audio
-- transcription needs a Whisper-compatible endpoint (Groq or OpenAI),
-- which isn't available under an Anthropic/Gemini/OpenRouter chat key,
-- so it can't just reuse `ai_configs.api_key`. A dedicated,
-- independently-optional field means an account can turn this on
-- regardless of which provider they picked for chat.
--
-- No row/column set = feature off — inbound voice notes keep being
-- stored (audio player, media_url) exactly as before, just without a
-- transcript, same as today. Never blocks message ingestion.
--
-- api_key is AES-256-GCM-encrypted, same convention as
-- ai_configs.api_key / embeddings_api_key.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS transcription_provider text,
  ADD COLUMN IF NOT EXISTS transcription_api_key text;

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_transcription_provider_check;

ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_transcription_provider_check
  CHECK (transcription_provider IS NULL OR transcription_provider IN ('groq', 'openai'));
