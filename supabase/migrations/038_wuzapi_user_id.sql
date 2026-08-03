-- ============================================================
-- 038_wuzapi_user_id.sql — fix WuzAPI webhook routing key
--
-- Migration 037 assumed WuzAPI's inbound webhook payload carries the
-- per-connection token in cleartext (`payload.token`), and routed
-- lookups via `wuzapi_token_hash`. Captured real traffic from a live
-- paired session shows this is wrong: the payload has no `token`
-- field at all. It carries `userID` — WuzAPI's own internal user id
-- (the same value returned as `data.id` from `POST /admin/users` at
-- provisioning time). That's what the webhook route must look up by.
--
-- `wuzapi_user_id` is NOT a secret (it's an opaque internal id, not a
-- credential), so unlike `wuzapi_token`/`wuzapi_hmac_key` it's stored
-- in plaintext — same reasoning as `phone_number_id` on the Meta side.
--
-- `wuzapi_token_hash` / `wuzapi_token` stay as-is: the token is still
-- needed as the `Token` header for every outbound call TO WuzAPI
-- (send message, session status, etc.) and for HMAC verification
-- context — only the *inbound webhook routing key* was wrong.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS wuzapi_user_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_wuzapi_user_id_key'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_wuzapi_user_id_key
      UNIQUE (wuzapi_user_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_whatsapp_config_wuzapi_user_id
  ON whatsapp_config (wuzapi_user_id)
  WHERE wuzapi_user_id IS NOT NULL;
