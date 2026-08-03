-- ============================================================
-- 055_whatsapp_config_default_wuzapi.sql
--
-- Migration 054 narrowed whatsapp_config_channel_type_check to
-- CHECK (channel_type = 'wuzapi'), but left the column's DEFAULT at
-- 'meta' (from migration 037) — harmless today since the only insert
-- path (POST /api/whatsapp/wuzapi/provision) always sets channel_type
-- explicitly, but a future insert that omits it would violate the
-- CHECK. Fix the default to match.
-- ============================================================

ALTER TABLE whatsapp_config
  ALTER COLUMN channel_type SET DEFAULT 'wuzapi';
