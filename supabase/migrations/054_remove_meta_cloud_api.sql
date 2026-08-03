-- ============================================================
-- 054_remove_meta_cloud_api.sql
--
-- Removes the official Meta WhatsApp Cloud API channel — the app is
-- WuzAPI-only now (self-hosted, QR-pairing personal WhatsApp via
-- whatsmeow). Confirmed on the test VPS before writing this: 0 rows
-- in `whatsapp_config` with channel_type='meta', 0 rows in
-- `flow_nodes` with node_type IN ('send_buttons','send_list'), 0 rows
-- in `message_templates` — so this is a straight removal, no data
-- migration/backfill needed.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- 1. whatsapp_config: drop the cross-column CHECK that allowed a
--    'meta' row, narrow channel_type to 'wuzapi' only, then drop the
--    Meta-only columns themselves.
ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_channel_fields_check;

ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_channel_type_check;

ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_channel_type_check
  CHECK (channel_type = 'wuzapi');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_wuzapi_fields_check'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_wuzapi_fields_check
      CHECK (wuzapi_base_url IS NOT NULL AND wuzapi_token IS NOT NULL);
  END IF;
END $$;

ALTER TABLE whatsapp_config
  DROP COLUMN IF EXISTS phone_number_id,
  DROP COLUMN IF EXISTS waba_id,
  DROP COLUMN IF EXISTS access_token,
  DROP COLUMN IF EXISTS verify_token,
  DROP COLUMN IF EXISTS registered_at,
  DROP COLUMN IF EXISTS subscribed_apps_at,
  DROP COLUMN IF EXISTS last_registration_error;

-- 2. flow_nodes: send_buttons/send_list were Meta interactive messages
--    (whatsmeow has no equivalent) — numeric_menu is the channel-
--    agnostic replacement (migration 051).
ALTER TABLE flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;

ALTER TABLE flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_message',
    'send_media',
    'collect_input',
    'condition',
    'set_tag',
    'handoff',
    'http_fetch',
    'end',
    'add_order_item',
    'order_summary',
    'numeric_menu'
  ));

-- 3. message_templates was pure Meta Business-Manager scaffolding
--    (submission/approval lifecycle) — no equivalent concept exists
--    for a personal WhatsApp number.
DROP TABLE IF EXISTS message_templates;
