-- ============================================================
-- 062_platform_admin.sql — platform-admin panel (cross-tenant
--                            management for the product owner)
--
-- Adds:
--   - profiles.is_platform_admin — marks the platform operator's own
--     profile(s). Not a per-account role; orthogonal to
--     account_role. Only ever true for the product owner.
--   - accounts.status — 'active' | 'suspended'. A suspended account
--     is blocked everywhere (dashboard, WhatsApp webhook/AI/
--     automation, public menu) — see the app-level guards in
--     src/lib/accounts/suspension.ts and its call sites.
--
-- Security note (mirrors 034_fix_profiles_update_rls.sql exactly):
-- RLS restricts *which rows* a user may update, not *which columns*.
-- Migration 034 already fixed this for account_role/account_id via a
-- BEFORE UPDATE trigger that rejects changes to those columns from
-- the `authenticated` role. Both new privilege columns need the same
-- treatment, or a tenant could self-promote to platform admin, or a
-- suspended tenant could un-suspend itself, via a raw PostgREST PATCH
-- — the exact bug class 034 fixed (GHSA-fg5p-2qc3-jmxr).
-- ============================================================

ALTER TABLE profiles ADD COLUMN is_platform_admin BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'suspended'));

-- Extend the 034 guard to also cover is_platform_admin.
CREATE OR REPLACE FUNCTION public.enforce_profile_privilege_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.account_role IS DISTINCT FROM OLD.account_role
      OR NEW.account_id IS DISTINCT FROM OLD.account_id
      OR NEW.is_platform_admin IS DISTINCT FROM OLD.is_platform_admin)
     AND current_user = 'authenticated'
  THEN
    RAISE EXCEPTION
      'account_role, account_id and is_platform_admin cannot be changed directly; use the account member/invitation RPCs or the platform admin panel'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
-- Trigger already exists on profiles (from 034) and just needs the
-- updated function body — no DROP/CREATE TRIGGER needed here.

-- Same pattern for accounts.status: only the service-role platform
-- admin panel may change it. A suspended tenant's own admin/owner
-- must not be able to un-suspend themselves via a raw PATCH.
CREATE OR REPLACE FUNCTION public.enforce_account_status_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND current_user = 'authenticated' THEN
    RAISE EXCEPTION 'status cannot be changed directly; use the platform admin panel'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_account_status_column() OWNER TO postgres;

DROP TRIGGER IF EXISTS enforce_account_status_column ON public.accounts;
CREATE TRIGGER enforce_account_status_column
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_account_status_column();

-- Bootstrap: the product owner's own profile(s) become platform admin
-- automatically — no manual post-deploy SQL step needed.
UPDATE profiles SET is_platform_admin = true WHERE email = 'mikuanskig@gmail.com';

-- ============================================================
-- Manual validation (run against a live instance — no automated SQL
-- test harness exists in this repo, same caveat as 034):
--
--   1. As a non-platform-admin JWT via PostgREST, this must return
--      42501 (insufficient_privilege):
--        PATCH /rest/v1/profiles?user_id=eq.<self> { "is_platform_admin": true }
--   2. As a tenant admin/owner JWT on their own (possibly suspended)
--      account, this must also return 42501:
--        PATCH /rest/v1/accounts?id=eq.<self-account> { "status": "active" }
--   3. A self-service profile edit that leaves both guarded columns
--      alone must still succeed (full_name, avatar_url, etc.).
--   4. The service-role client (platform admin panel backend) must
--      still be able to write both status and is_platform_admin.
-- ============================================================
