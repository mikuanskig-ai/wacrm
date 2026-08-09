-- ============================================================
-- 071_payment_pix_key.sql — a static Pix key, independent of the
--                            Mercado Pago checkout integration.
--
-- Requested by an account owner (2026-08-09) who was hardcoding their
-- Pix key straight into the AI's free-text system prompt as a
-- workaround ("Se Pix: envie a chave 45999526657") — fragile (a typo
-- or prompt edit silently breaks payment collection) and invisible to
-- the deterministic order-confirmation message, which is what
-- actually needs to send it reliably.
--
-- Deliberately NOT tied to Mercado Pago being configured: a business
-- collecting payment manually via a Pix key/QR code (no online
-- checkout at all) is a normal, common setup — `mp_access_token` and
-- `mp_webhook_secret` are relaxed to nullable so a `payment_configs`
-- row can exist with only `pix_key` set. `enabled` (checkout on/off)
-- still only ever means "Mercado Pago checkout is on"; a Pix key
-- being present has no bearing on it.
--
-- Plaintext, not encrypted (unlike mp_access_token/mp_webhook_secret)
-- — a Pix key is meant to be shown directly to every paying customer,
-- it isn't a secret the way a provider credential is.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE payment_configs
  ALTER COLUMN mp_access_token DROP NOT NULL,
  ALTER COLUMN mp_webhook_secret DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS pix_key TEXT;
