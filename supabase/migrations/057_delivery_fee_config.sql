-- ============================================================
-- 057_delivery_fee_config.sql — Zontalk Delivery module (Motor de
-- Cálculo de Entrega).
--
-- One row per account (mirrors delivery_business_hours, migration
-- 047): a single active `delivery_method` (Regra 1 — never more than
-- one), two global gates that apply regardless of method
-- (`max_distance`, `free_shipping_above`), the restaurant's own
-- geocoded location for distance-based methods, and a flexible
-- `settings` JSONB holding whatever the active method needs — no
-- per-method table, same reasoning as `delivery_business_hours.hours`.
--
-- No row = permissive default (free delivery, `fixed` @ 0) until the
-- account configures it — same "no row = feature off" convention as
-- business hours / payment configs, just with a permissive rather
-- than a blocking default (see `getDeliveryFeeConfig` in
-- src/lib/delivery/fee-engine.ts).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS delivery_fee_configs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  delivery_method      TEXT NOT NULL DEFAULT 'fixed'
                         CHECK (delivery_method IN ('fixed', 'neighborhood', 'distance_range', 'per_km')),
  -- Kilometers. NULL = no service-area limit enforced.
  max_distance         NUMERIC(6,2)  CHECK (max_distance IS NULL OR max_distance > 0),
  -- Currency units (account's own currency). NULL = no free-shipping threshold.
  free_shipping_above  NUMERIC(12,2) CHECK (free_shipping_above IS NULL OR free_shipping_above >= 0),
  -- Restaurant's own address, geocoded once when saved (see the
  -- fee-config route) — every per-order calculation only needs to
  -- geocode the customer's destination, not this again.
  origin_address       TEXT,
  origin_lat           NUMERIC(9,6),
  origin_lng           NUMERIC(9,6),
  -- Method-specific payload. Shape depends on delivery_method:
  --   fixed           -> { fixed_price: number }
  --   neighborhood    -> { neighborhoods: { id, name, price }[] }
  --   distance_range  -> { rules: { from, to, price }[] }
  --   per_km          -> { base_price: number, price_per_km: number }
  settings             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_delivery_fee_configs_account ON delivery_fee_configs(account_id);

ALTER TABLE delivery_fee_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS delivery_fee_configs_select ON delivery_fee_configs;
CREATE POLICY delivery_fee_configs_select ON delivery_fee_configs FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS delivery_fee_configs_insert ON delivery_fee_configs;
CREATE POLICY delivery_fee_configs_insert ON delivery_fee_configs FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS delivery_fee_configs_update ON delivery_fee_configs;
CREATE POLICY delivery_fee_configs_update ON delivery_fee_configs FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS delivery_fee_configs_delete ON delivery_fee_configs;
CREATE POLICY delivery_fee_configs_delete ON delivery_fee_configs FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON delivery_fee_configs;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON delivery_fee_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
