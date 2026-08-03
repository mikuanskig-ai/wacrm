-- ============================================================
-- 046_delivery_payment.sql — Zontalk Delivery module (Fase 4: Checkout).
--
-- Adds real payment via Mercado Pago (Pix/cartão via link de
-- checkout) on top of Delivery orders. Migration 042 explicitly
-- earmarked this: "Status ladder is deliberately payment-agnostic.
-- Mercado Pago / payment states (...) are a later migration's ADD to
-- the CHECK list + a nullable payment_status column — nothing here
-- encodes 'confirmed implies paid'." This migration delivers exactly
-- that: `payment_status` stays a fully independent axis from
-- `status` (fulfillment) — no coupling either way.
--
-- payment_configs mirrors ai_configs (migration 029): account-scoped,
-- UNIQUE(account_id), secrets AES-256-GCM-encrypted with the same
-- encrypt()/decrypt() from src/lib/whatsapp/encryption.ts, RLS
-- readable by any member (so the UI can show "is payment on?")
-- writable by admin only.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- PAYMENT CONFIGS
-- ============================================================
CREATE TABLE IF NOT EXISTS payment_configs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  created_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  provider           TEXT NOT NULL DEFAULT 'mercado_pago' CHECK (provider = 'mercado_pago'),
  -- AES-256-GCM-encrypted (same encrypt()/decrypt() as whatsapp_config.access_token / ai_configs.api_key).
  mp_access_token    TEXT NOT NULL,
  -- Meant to be public (used by MP's client-side SDK later) — plaintext is fine.
  mp_public_key      TEXT,
  -- AES-256-GCM-encrypted — MP's webhook signing secret, distinct from the access token.
  mp_webhook_secret  TEXT NOT NULL,
  enabled            BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_configs_account ON payment_configs(account_id);

ALTER TABLE payment_configs ENABLE ROW LEVEL SECURITY;

-- SELECT: any member of the account (viewer+) can see the config so
-- the UI knows whether payment is on, same reasoning as ai_configs.
DROP POLICY IF EXISTS payment_configs_select ON payment_configs;
CREATE POLICY payment_configs_select ON payment_configs FOR SELECT
  USING (is_account_member(account_id));

-- INSERT / UPDATE / DELETE: admin+ only (settings-class).
DROP POLICY IF EXISTS payment_configs_insert ON payment_configs;
CREATE POLICY payment_configs_insert ON payment_configs FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS payment_configs_update ON payment_configs;
CREATE POLICY payment_configs_update ON payment_configs FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS payment_configs_delete ON payment_configs;
CREATE POLICY payment_configs_delete ON payment_configs FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON payment_configs;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON payment_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- delivery_orders — payment fields
--
-- Vocabulary matches Mercado Pago's own `payment.status` field
-- (pending/approved/rejected/refunded/cancelled) 1:1, renaming only
-- 'pending' -> 'pending_payment' so it doesn't visually collide with
-- the fulfillment status 'pending_confirmation'.
-- ============================================================
ALTER TABLE delivery_orders
  ADD COLUMN IF NOT EXISTS payment_status TEXT
    CHECK (payment_status IS NULL OR payment_status IN (
      'pending_payment', 'approved', 'rejected', 'refunded', 'cancelled'
    )),
  ADD COLUMN IF NOT EXISTS mp_preference_id TEXT,
  ADD COLUMN IF NOT EXISTS mp_payment_id TEXT,
  ADD COLUMN IF NOT EXISTS checkout_url TEXT;
