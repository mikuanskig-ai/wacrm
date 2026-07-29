-- ============================================================
-- 037_wuzapi_channel.sql — WuzAPI as a second WhatsApp channel type
--
-- Why this exists:
--   wacrm only spoke to WhatsApp via the official Meta Cloud API,
--   which requires a Meta Business account and (for some features)
--   app review. WuzAPI (github.com/asternic/wuzapi) is a self-hosted
--   Go service wrapping the `whatsmeow` library — it pairs via QR
--   code like WhatsApp Web, no Meta account needed. This migration
--   adds it as a second, selectable channel type on the existing
--   `whatsapp_config` row rather than a sibling table, because:
--
--     - UNIQUE(account_id) (migration 017) already enforces "one
--       connection per account" at the DB level. A sibling table
--       would need to reimplement that guarantee across two tables.
--     - Every read site does one `.select('*').eq('account_id', ...)`
--       — a discriminator column keeps that a single-table lookup.
--     - The project already extends this exact table per-provider-
--       concern this way (013 added a UNIQUE constraint, 015 added
--       Meta registration columns).
--
-- Design
--   - `channel_type` discriminates 'meta' (default, existing rows)
--     from 'wuzapi'. `phone_number_id` / `access_token` move from
--     NOT NULL to nullable, with a CHECK constraint replacing that
--     guarantee per-branch (a wuzapi row has neither; a meta row
--     must have both).
--   - `wuzapi_token_hash` is a SHA-256 hex digest of the PLAINTEXT
--     per-connection token, UNIQUE + indexed — same convention as
--     `api_keys.key_hash` (migration 026). WuzAPI's inbound webhook
--     payload carries its token in cleartext, so this gives the new
--     webhook route an O(1) indexed lookup instead of decrypting
--     every row per delivery (which the low-volume Meta GET
--     verify-token handshake gets away with, but a POST webhook
--     hot path should not).
--   - `wuzapi_token` / `wuzapi_hmac_key` / `wuzapi_admin_token` are
--     ciphertext, encrypted the exact same way `access_token` already
--     is (AES-256-GCM via src/lib/whatsapp/encryption.ts) — no second
--     encryption scheme.
--
-- RLS: no policy changes needed. The `whatsapp_config_*` policies
-- (migration 017) key off `account_id`, not individual columns, so
-- the new columns inherit existing row-level protection for free.
--
-- Local-dev note: this migration only ALTERs an already-privileged
-- table (ADD COLUMN / ADD CONSTRAINT), so it does not need the
-- baseline `GRANT`/`ALTER DEFAULT PRIVILEGES` statements a bare
-- `supabase start` instance is missing relative to Supabase Cloud —
-- those were already applied once against `whatsapp_config` itself.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- 1. Channel discriminator. Existing rows backfill to 'meta' for
--    free via the DEFAULT.
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS channel_type TEXT NOT NULL DEFAULT 'meta';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_channel_type_check'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_channel_type_check
      CHECK (channel_type IN ('meta', 'wuzapi'));
  END IF;
END $$;

-- 2. WuzAPI-specific columns. All nullable — a 'meta' row never
--    populates these.
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS wuzapi_server_url TEXT,
  ADD COLUMN IF NOT EXISTS wuzapi_admin_token TEXT,
  ADD COLUMN IF NOT EXISTS wuzapi_base_url TEXT,
  ADD COLUMN IF NOT EXISTS wuzapi_token TEXT,
  ADD COLUMN IF NOT EXISTS wuzapi_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS wuzapi_hmac_key TEXT,
  ADD COLUMN IF NOT EXISTS wuzapi_instance_name TEXT;

-- 3. Relax the Meta-only NOT NULLs so a wuzapi row can omit them.
ALTER TABLE whatsapp_config
  ALTER COLUMN phone_number_id DROP NOT NULL,
  ALTER COLUMN access_token DROP NOT NULL;

-- 4. Replace the dropped guarantees with a cross-column CHECK: a
--    'meta' row must still carry phone_number_id + access_token; a
--    'wuzapi' row must carry wuzapi_base_url + wuzapi_token instead.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_channel_fields_check'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_channel_fields_check
      CHECK (
        (channel_type = 'meta'
          AND phone_number_id IS NOT NULL
          AND access_token IS NOT NULL)
        OR
        (channel_type = 'wuzapi'
          AND wuzapi_base_url IS NOT NULL
          AND wuzapi_token IS NOT NULL)
      );
  END IF;
END $$;

-- 5. UNIQUE on the token hash — same guard pattern as migration 013
--    (Postgres has no ADD CONSTRAINT IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_wuzapi_token_hash_key'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_wuzapi_token_hash_key
      UNIQUE (wuzapi_token_hash);
  END IF;
END $$;

-- Hot path for the wuzapi webhook route: look up the owning config by
-- the inbound payload's cleartext token hash. The UNIQUE constraint
-- above already creates an index; spelled out here (like 026 does for
-- api_keys.key_hash) so the intent survives a future constraint drop.
CREATE INDEX IF NOT EXISTS idx_whatsapp_config_wuzapi_token_hash
  ON whatsapp_config (wuzapi_token_hash)
  WHERE wuzapi_token_hash IS NOT NULL;
