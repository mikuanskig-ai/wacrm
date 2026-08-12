-- ============================================================
-- 073_delivery_payment_method.sql
--
-- Records the payment method the customer picked, on the order
-- itself — today it's only ever captured transiently in
-- conversations.ai_order_info (via the AI's update_order_info tool)
-- and used for the WhatsApp confirmation text / Pix card, then
-- discarded. Distinct from payment_status (migration 042), which
-- tracks the Mercado Pago checkout lifecycle, not what the customer
-- said they'd pay with.
--
-- payment_notes carries free text alongside it (e.g. "troco pra
-- R$100"), same pairing already used in ai_order_info.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE delivery_orders
  ADD COLUMN IF NOT EXISTS payment_method text,
  ADD COLUMN IF NOT EXISTS payment_notes text;
