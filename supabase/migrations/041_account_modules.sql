-- ============================================================
-- 041_account_modules.sql — opt-in feature modules per account.
--
-- ZonTalk is a multi-tenant SaaS: each account is a different paying
-- customer, and larger verticals (Delivery being the first) are
-- optional add-ons a customer turns on for themselves, not something
-- that ships enabled for everyone. `profiles.beta_features` (migration
-- 011) looked like a fit but isn't — it's per-USER and only editable
-- by hand in SQL Studio (an operator rollout gate), not a self-service
-- per-ACCOUNT toggle with a Settings UI. This is that toggle.
--
-- Plain TEXT[] (not a join table): module keys are a short, app-owned
-- vocabulary (see src/lib/accounts/modules.ts's MODULE_KEYS), not
-- rows with their own attributes — an array avoids a migration for
-- every future module.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS enabled_modules TEXT[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN accounts.enabled_modules IS
  'Opt-in feature modules this account has turned on for itself (e.g. "delivery"). See src/lib/accounts/modules.ts.';
