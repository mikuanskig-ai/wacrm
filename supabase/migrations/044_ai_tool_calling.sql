-- ============================================================
-- 044_ai_tool_calling.sql — AI tool-calling for Delivery (Fase 2).
--
-- Lets the AI auto-reply bot look up the menu, build a cart, and place
-- a real order over a free-text WhatsApp conversation, instead of only
-- generating a single free-text reply. Opt-in and additive:
--
--   - `ai_configs.tools_enabled` — a NEW switch, separate from
--     `auto_reply_enabled`. Defaults false, so every existing account
--     keeps behaving exactly as before until an admin explicitly turns
--     this on in Settings.
--   - `conversations.ai_cart` — the cart the bot accumulates across
--     turns while a customer orders in free text. Same pattern as the
--     other `ai_*` columns already on this table (`ai_reply_count`,
--     `ai_autoreply_disabled`).
--   - `conversations.ai_last_tool_message_id` + `claim_ai_tool_turn` —
--     idempotency guard. Once tools can create a real `delivery_orders`
--     row, a redelivered webhook running the dispatch twice risks a
--     second real order (not just a duplicate text reply, which was the
--     only previous exposure). Mirrors `claim_ai_reply_slot` (migration
--     029/031): an atomic compare-and-set on the inbound WhatsApp
--     message id, so a retried dispatch for the same message is a
--     silent no-op.
--   - `delivery_orders.source` gains a third value, `'ai_chat'`, so
--     orders placed by the free-text AI path are distinguishable from
--     `'whatsapp_flow'` (the structured Flow-builder path, Fase 1).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_cart jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_last_tool_message_id text;

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS tools_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE delivery_orders DROP CONSTRAINT IF EXISTS delivery_orders_source_check;
ALTER TABLE delivery_orders ADD CONSTRAINT delivery_orders_source_check
  CHECK (source IN ('manual', 'whatsapp_flow', 'ai_chat'));

-- ============================================================
-- Atomic per-inbound-message tool-turn claim — same shape as
-- claim_ai_reply_slot, but keyed on the WhatsApp message id rather than
-- a counter: `IS DISTINCT FROM` makes the UPDATE (and therefore the
-- claim) a no-op when this exact message id was already recorded,
-- which is exactly the "redelivered webhook" case this guards against.
-- ============================================================
CREATE OR REPLACE FUNCTION public.claim_ai_tool_turn(
  conversation_id uuid,
  message_id text
)
RETURNS boolean AS $$
  WITH claimed AS (
    UPDATE conversations
    SET ai_last_tool_message_id = message_id
    WHERE id = conversation_id
      AND ai_last_tool_message_id IS DISTINCT FROM message_id
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

-- Only the service-role auto-reply bot claims tool turns (no
-- auth.uid() on the inbound webhook path) — see migration 031's note
-- on why SECURITY DEFINER alone isn't sufficient on hardened instances.
GRANT EXECUTE ON FUNCTION public.claim_ai_tool_turn(uuid, text) TO service_role;
