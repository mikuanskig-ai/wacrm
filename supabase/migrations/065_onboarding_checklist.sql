-- ============================================================
-- 065_onboarding_checklist.sql
--
-- UX audit Parte 4 — first-login checklist (connect WhatsApp, decide
-- business type, configure + test the AI agent, invite the team)
-- instead of dropping a brand-new account straight onto the generic
-- Dashboard. See src/lib/onboarding/checklist.ts for the step logic.
--
-- Both accounts columns are plain self-service state, not privileged
-- (unlike status/plan_id/suspended_reason in 062/063) — the existing
-- accounts_update RLS policy (017, admin+ only) is all the guarding
-- they need, same as enabled_modules already gets.
-- ============================================================

ALTER TABLE accounts ADD COLUMN onboarding_business_type_at TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN onboarding_dismissed_at TIMESTAMPTZ;

-- The "test in Playground" step has no other natural signal to derive
-- from (unlike WhatsApp/AI-configured, which read existing tables) —
-- set by POST /api/ai/playground the first time a test call succeeds.
ALTER TABLE ai_configs ADD COLUMN onboarding_tested_at TIMESTAMPTZ;

-- Every account that exists before this migration already lived
-- through onboarding without a checklist — showing one now would be a
-- regression, not a welcome. Only accounts created AFTER this
-- migration (onboarding_dismissed_at NULL by column default) see it.
UPDATE accounts SET onboarding_dismissed_at = now() WHERE onboarding_dismissed_at IS NULL;
