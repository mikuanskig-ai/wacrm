-- ============================================================
-- 063_plans_and_billing.sql — subscription plans + recurring
--                              billing for platform tenants
--
-- Adds:
--   - plans: platform-defined subscription catalog (price, cycle,
--     seat/module limits). RLS enabled with ZERO policies — this is
--     not per-tenant data, every read goes through a service-role
--     client (src/lib/billing/plans.ts, /api/public/plans,
--     /api/admin/plans), never the RLS-scoped client.
--   - invoices: one row per billing period per account. Snapshots
--     plan_name/amount_cents at generation time so editing a plan's
--     price later never rewrites historical invoices (paid or not).
--     Same zero-policy RLS as plans.
--   - accounts.plan_id / accounts.suspended_reason.
--
-- Security note (same pattern as 034/062): RLS restricts which ROWS
-- a tenant may touch, not which COLUMNS. The 062 guard already blocks
-- `status`/`is_platform_admin`/`account_role`/`account_id` from the
-- `authenticated` role; this migration widens the SAME function
-- (CREATE OR REPLACE, no DROP/CREATE TRIGGER — mirrors how 062
-- widened 034's function) to also guard `plan_id`/`suspended_reason`,
-- and to constrain `enabled_modules` to never exceed what the
-- account's current plan grants. Without the enabled_modules half of
-- this, a tenant could just PATCH that column directly (as
-- modules-settings.tsx already does, via the RLS-scoped client) and
-- get a module their plan doesn't include, without ever touching
-- plan_id.
-- ============================================================

CREATE TABLE plans (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  description      TEXT,
  price_cents      INTEGER NOT NULL CHECK (price_cents >= 0),
  -- Fixed BRL for now — InfinitePay (the platform's own billing
  -- gateway) is Brazil-only. Deliberately NOT accounts.default_currency
  -- (021_account_default_currency.sql) — that's the tenant's own deal/
  -- CRM currency, an unrelated per-tenant setting.
  currency         TEXT NOT NULL DEFAULT 'BRL',
  billing_cycle    TEXT NOT NULL DEFAULT 'monthly'
                     CHECK (billing_cycle IN ('monthly','quarterly','semiannual','annual')),
  max_users        INTEGER CHECK (max_users IS NULL OR max_users > 0),  -- NULL = unlimited
  enabled_modules  TEXT[] NOT NULL DEFAULT '{}',
  is_public        BOOLEAN NOT NULL DEFAULT true,   -- shown on /pricing + /api/public/plans
  is_active        BOOLEAN NOT NULL DEFAULT true,   -- assignable (new signup or renewal)
  position         INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON plans
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE invoices (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  plan_id              UUID REFERENCES plans(id) ON DELETE RESTRICT,
  plan_name            TEXT NOT NULL,
  amount_cents         INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency             TEXT NOT NULL DEFAULT 'BRL',
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','paid','overdue','cancelled')),
  period_start         DATE NOT NULL,
  period_end           DATE NOT NULL,
  due_date             DATE NOT NULL,
  paid_at              TIMESTAMPTZ,
  checkout_url         TEXT,
  checkout_order_nsu   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Cron idempotency lock: never generate two invoices for the same
  -- account+period, even across overlapping cron runs. `ON CONFLICT
  -- DO NOTHING` on insert is the actual lock (see generateInvoice()).
  UNIQUE (account_id, period_start)
);
CREATE INDEX idx_invoices_account ON invoices(account_id, created_at DESC);
CREATE INDEX idx_invoices_outstanding ON invoices(status, due_date) WHERE status IN ('pending','overdue');
CREATE UNIQUE INDEX idx_invoices_order_nsu ON invoices(checkout_order_nsu) WHERE checkout_order_nsu IS NOT NULL;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE accounts ADD COLUMN plan_id UUID REFERENCES plans(id) ON DELETE RESTRICT;
ALTER TABLE accounts ADD COLUMN suspended_reason TEXT
  CHECK (suspended_reason IS NULL OR suspended_reason IN ('manual','overdue'));

-- Widen the 062 guard (itself a widening of 034's function).
CREATE OR REPLACE FUNCTION public.enforce_account_status_column()
RETURNS TRIGGER
LANGUAGE plpgsql
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

    -- enabled_modules stays self-service (modules-settings.tsx writes
    -- it directly through the RLS-scoped client), but can never
    -- exceed what the account's current plan grants — otherwise a
    -- tenant gets a module for free via a raw PATCH without ever
    -- touching plan_id.
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
-- Trigger already exists on accounts (from 062) — only the function
-- body changes, no DROP/CREATE TRIGGER needed.

-- Extend the signup trigger to accept an optional plan_id from
-- raw_user_meta_data (client-controlled — treat as hostile input).
-- handle_new_user() wraps its body in `EXCEPTION WHEN OTHERS THEN
-- RAISE WARNING; RETURN NEW`, so a raised error here would silently
-- roll back the accounts+profiles insert while auth.users still
-- commits — a permanently stuck signup with no recovery path in the
-- UI. The nested BEGIN/EXCEPTION block below ensures a malformed
-- plan_id (not a valid UUID) degrades to NULL instead of raising.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name TEXT;
  v_account_id UUID;
  v_plan_id UUID;
BEGIN
  v_full_name := COALESCE(NEW.raw_user_meta_data->>'full_name', '');

  v_plan_id := NULL;
  BEGIN
    v_plan_id := NULLIF(NEW.raw_user_meta_data->>'plan_id', '')::UUID;
  EXCEPTION WHEN OTHERS THEN
    v_plan_id := NULL;
  END;
  IF v_plan_id IS NOT NULL THEN
    -- Re-point at a validated row (or NULL if unknown/private/inactive)
    -- rather than trusting the client-supplied id was ever legitimate.
    SELECT id INTO v_plan_id FROM plans
     WHERE id = v_plan_id AND is_active AND is_public;
  END IF;

  INSERT INTO public.accounts (name, owner_user_id, plan_id)
  VALUES (COALESCE(NULLIF(v_full_name, ''), NEW.email, 'My account'), NEW.id, v_plan_id)
  RETURNING id INTO v_account_id;

  INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
  VALUES (NEW.id, v_full_name, NEW.email, v_account_id, 'owner');

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to bootstrap account/profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
-- Trigger already exists (on_auth_user_created, from 017) — only the
-- function body changes.

-- Backfill: every existing account gets a permissive "Legacy" plan
-- instead of silently becoming plan_id NULL. Not public (never shown
-- on /pricing or /api/public/plans), stays active so it can always be
-- reassigned from /admin.
INSERT INTO plans (name, price_cents, max_users, enabled_modules, is_public, is_active)
VALUES ('Legacy', 0, NULL, ARRAY['delivery'], false, true);

UPDATE accounts SET plan_id = (SELECT id FROM plans WHERE name = 'Legacy' LIMIT 1)
WHERE plan_id IS NULL;

-- ============================================================
-- Manual validation (run against a live instance — no automated SQL
-- test harness exists in this repo, same caveat as 034/062):
--
--   1. As a tenant admin JWT (authenticated role), all of these must
--      return 42501 (insufficient_privilege):
--        PATCH /rest/v1/accounts?id=eq.<own> { "plan_id": "<other-plan>" }
--        PATCH /rest/v1/accounts?id=eq.<own> { "suspended_reason": null }
--        PATCH /rest/v1/accounts?id=eq.<own account on a plan without 'delivery'> { "enabled_modules": ["delivery"] }
--   2. As the same tenant admin, this must still succeed (module
--      already granted by their plan, or empty array):
--        PATCH /rest/v1/accounts?id=eq.<own> { "enabled_modules": [] }
--   3. The service-role client (billing cron, /api/admin/*) must
--      still be able to write plan_id/status/suspended_reason/
--      enabled_modules freely.
--   4. `select plan_id, name from accounts limit 5;` — every existing
--      account should show the Legacy plan's id, none NULL.
-- ============================================================
