-- ============================================================
-- 077_backfill_last_placed_order_at.sql — one-time data backfill for
-- the new `lastPlacedOrderAt` field on `conversations.ai_order_info`
-- (see src/lib/ai/order-state.ts's OrderInfo/isLastPlacedOrderStale).
--
-- Root cause this closes: `lastPlacedOrderId` never expired — a
-- WhatsApp conversation thread in this app never gets a fresh
-- conversation_id just because time passed, so a `lastPlacedOrderId`
-- written once stayed "still open this conversation" forever.
-- Confirmed live (2026-09-05, Davi Santos, Concórdia): an order placed
-- 2026-08-29 was still sitting there a week later — when the same
-- customer ordered again, the model (correctly following the prompt's
-- own "cancel before recreating" instruction) silently cancelled that
-- week-old, almost-certainly-already-delivered order before placing
-- the new one. The code fix (isLastPlacedOrderStale, order-state.ts)
-- treats a `lastPlacedOrderId` older than STALE_LAST_PLACED_ORDER_MS
-- (or missing its timestamp entirely) as no longer "open" — but every
-- row written before this migration has NO `lastPlacedOrderAt` at all,
-- and "missing = stale" would flip every one of them, including orders
-- placed minutes before this deploys, briefly losing the duplicate-
-- order protection for anything already in flight until it naturally
-- refreshes (self-heals within 6h, or on the next place_order/cancel_order
-- call — see order-state.ts) — bounded, but avoidable here since the
-- real order date is right there in `delivery_orders.created_at`.
--
-- Idempotent — only touches rows that have a lastPlacedOrderId and are
-- still missing lastPlacedOrderAt; safe to run more than once.
-- ============================================================

UPDATE conversations c
SET ai_order_info = jsonb_set(
  c.ai_order_info,
  '{lastPlacedOrderAt}',
  to_jsonb(o.created_at::text)
)
FROM delivery_orders o
WHERE c.ai_order_info ? 'lastPlacedOrderId'
  AND NOT (c.ai_order_info ? 'lastPlacedOrderAt')
  AND o.id::text = c.ai_order_info->>'lastPlacedOrderId';
