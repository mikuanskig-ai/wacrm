-- Redesign `broadcasts` from a single Meta-template send into a
-- WuzAPI "campaign": scheduled start, delay between sends (reduces
-- WhatsApp ban risk on a personal number), up to 3 message variants
-- (randomly picked per recipient, same anti-ban reasoning), optional
-- media, and a `whatsapp_config_id` so a campaign already records
-- which channel sends it — today every account has exactly one
-- channel, but this column means a future multi-number account won't
-- need another migration, just a picker.
--
-- Confirmed zero production rows depend on the old template_name/
-- template_language/template_variables columns before writing this
-- (checked the test VPS's `message_templates`/`broadcasts` tables).

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS message_variants JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS media_url TEXT,
  ADD COLUMN IF NOT EXISTS delay_seconds INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMPTZ;

ALTER TABLE broadcasts
  DROP COLUMN IF EXISTS template_name,
  DROP COLUMN IF EXISTS template_language,
  DROP COLUMN IF EXISTS template_variables;

-- `audience_filter` (added in 001, never wired to a UI) is reused
-- as-is for the segment definition: {"type":"all"} or
-- {"type":"tags","tag_ids":["..."]}.

ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_status_check;
ALTER TABLE broadcasts
  ADD CONSTRAINT broadcasts_status_check
  CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed', 'cancelled'));

CREATE INDEX IF NOT EXISTS idx_broadcasts_dispatch
  ON broadcasts (status, scheduled_at)
  WHERE status IN ('scheduled', 'sending');
