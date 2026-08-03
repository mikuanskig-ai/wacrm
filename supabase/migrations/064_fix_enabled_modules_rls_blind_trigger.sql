-- ============================================================
-- 064_fix_enabled_modules_rls_blind_trigger.sql
--
-- Bug: enforce_account_status_column() (063) reads `plans` to check
-- enabled_modules containment, but the function is LANGUAGE plpgsql
-- with no SECURITY DEFINER, so it runs as the CALLING role. `plans`
-- has RLS enabled with ZERO policies (deny-all), so when a tenant
-- (authenticated role) toggles a module, the trigger's own SELECT
-- against `plans` returns 0 rows — v_plan_modules is always NULL,
-- COALESCE'd to '{}', and the containment check ALWAYS fails. Any
-- self-service module change (delivery included, even though the
-- plan grants it) is rejected with 403/42501.
--
-- Fix: mark the function SECURITY DEFINER (same pattern already used
-- by handle_new_user(), 017/063) so its internal SELECT against
-- `plans` runs as the function owner, bypassing RLS — the function
-- still only ever reads `enabled_modules` for an internal containment
-- check, never returns plan rows to the client.
-- ============================================================

CREATE OR REPLACE FUNCTION public.enforce_account_status_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan_modules TEXT[];
BEGIN
  IF current_user = 'authenticated' THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
       OR NEW.suspended_reason IS DISTINCT FROM OLD.suspended_reason
    THEN
      RAISE EXCEPTION
        'status, plan_id and suspended_reason cannot be changed directly; use the platform admin panel'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF NEW.enabled_modules IS DISTINCT FROM OLD.enabled_modules AND NEW.plan_id IS NOT NULL THEN
      SELECT enabled_modules INTO v_plan_modules FROM plans WHERE id = NEW.plan_id;
      IF NOT (NEW.enabled_modules <@ COALESCE(v_plan_modules, '{}')) THEN
        RAISE EXCEPTION 'enabled_modules cannot exceed the account''s plan grants'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ============================================================
-- Manual validation:
--   1. As tenant admin JWT, PATCH enabled_modules to a module the
--      plan DOES grant → must now succeed (previously always 403).
--   2. As tenant admin JWT, PATCH enabled_modules to a module the
--      plan does NOT grant → must still be 42501.
--   3. PATCH plan_id/status/suspended_reason directly → still 42501.
-- ============================================================
