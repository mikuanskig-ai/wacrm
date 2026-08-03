-- ============================================================
-- 040_pipeline_auto_add.sql — let a pipeline auto-add every new
-- contact into one of its stages, instead of deals being created
-- one at a time via the deal form.
--
-- `auto_add_stage_id` is nullable and ON DELETE SET NULL: deleting
-- the stage a pipeline was auto-adding into shouldn't be blocked by
-- this reference, it should just turn auto-add off for that pipeline
-- (the app treats "auto_add_contacts = true but auto_add_stage_id IS
-- NULL" as effectively disabled — see src/lib/pipelines/auto-add.ts).
-- ============================================================

ALTER TABLE pipelines
  ADD COLUMN IF NOT EXISTS auto_add_contacts BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_add_stage_id UUID REFERENCES pipeline_stages(id) ON DELETE SET NULL;

COMMENT ON COLUMN pipelines.auto_add_contacts IS
  'When true, every contact created in this account is automatically dropped into auto_add_stage_id as a new deal.';
COMMENT ON COLUMN pipelines.auto_add_stage_id IS
  'Stage a new contact lands in when auto_add_contacts is on. NULL disables auto-add even if the flag is true.';
