-- ============================================================
-- 058_delivery_fee_origin_structured.sql — Zontalk Delivery module
-- (Motor de Cálculo de Entrega, fix).
--
-- Splits the restaurant's own origin address into structured fields
-- (street, neighbourhood, city, state, postal code) instead of a
-- single free-text blob. A single string was insufficient for ORS's
-- geocoder to reliably resolve small Brazilian towns — observed live:
-- a free-text address matched a same-named street in a DIFFERENT
-- state ~400km away with high self-reported confidence. Passing the
-- same fields to OpenRouteService's structured endpoint resolved the
-- correct city (see src/lib/delivery/providers/openrouteservice.ts).
--
-- `origin_address` is kept — now a derived, human-readable composition
-- of the structured fields (written by the API route on every save),
-- not hand-typed free text. No backfill: 0 rows depend on it in
-- production/test today (confirmed on the test VPS before this
-- migration), so existing rows just get NULL structured fields until
-- next save.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE delivery_fee_configs
  ADD COLUMN IF NOT EXISTS origin_street TEXT,
  ADD COLUMN IF NOT EXISTS origin_neighbourhood TEXT,
  ADD COLUMN IF NOT EXISTS origin_city TEXT,
  ADD COLUMN IF NOT EXISTS origin_state TEXT,
  ADD COLUMN IF NOT EXISTS origin_postal_code TEXT,
  -- The provider's own resolved label (e.g. "Santa Tereza do Oeste,
  -- PR, Brazil"), NOT a copy of origin_address — the whole point is
  -- letting the admin see what the geocoder actually matched, to catch
  -- a wrong-city resolution, so it can never just echo their own input.
  ADD COLUMN IF NOT EXISTS origin_resolved_label TEXT;

COMMENT ON COLUMN delivery_fee_configs.origin_address IS
  'Human-readable composition of the structured origin_* fields, written on save — display only, never geocoded directly.';

COMMENT ON COLUMN delivery_fee_configs.origin_resolved_label IS
  'The geocoding provider''s own label for the resolved origin_lat/origin_lng — lets the admin confirm the match (e.g. catch a wrong-city resolution) instead of trusting it silently.';
