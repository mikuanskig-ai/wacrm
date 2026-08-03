-- ============================================================
-- 052_delivery_product_day_price.sql — per-weekday price overrides
-- for a Delivery product (e.g. a dish that costs more on Saturdays).
--
-- Mirrors delivery_business_hours.hours (047): a small, product-scoped
-- JSONB map rather than a child table — no relational value over a
-- table here, and it stays in the same SELECT as the base `price`
-- everywhere a product is read (public menu, WhatsApp Flow engine, AI
-- ordering tool), so nothing risks quoting a stale/base price on a day
-- that has an override.
--
-- Shape: {"sat": 45.00, "sun": 45.00} — same 3-letter lowercase DayKey
-- convention as business-hours.ts (mon/tue/wed/thu/fri/sat/sun).
-- Missing key = use the base `price` column that day.
-- ============================================================

ALTER TABLE delivery_products
  ADD COLUMN IF NOT EXISTS day_price_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;
