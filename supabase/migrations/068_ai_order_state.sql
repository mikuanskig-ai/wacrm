-- ============================================================
-- 068_ai_order_state.sql — persistent order state for the AI
-- tool-calling delivery flow (extends Fase 2 / migration 044).
--
-- Root-cause fix for the pattern behind most AI-order bugs found
-- 2026-08-06/07 (cart duplication, re-asking known info, hallucinated
-- summary numbers, mid-flow handoffs): the model has NO memory of tool
-- calls from earlier turns — only the human-readable transcript
-- (`buildConversationContext`). `ai_cart` (044) already solved this for
-- the cart itself; this does the same for the rest of what an order
-- needs — customer name, confirmed address/neighbourhood, payment
-- method, and the last fee actually calculated — so it can be injected
-- into the system prompt every turn as ground truth instead of
-- something the model has to re-derive (or invent) from memory.
--
-- Same pattern as `ai_cart`: a jsonb blob on `conversations`, written/
-- read by the tool layer (src/lib/ai/order-state.ts), never queried
-- directly by RLS policy or any UI — no schema-level shape enforcement
-- beyond "is an object", same as `ai_cart`'s "is an array" is only
-- enforced in application code (readCart's Array.isArray guard).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_order_info jsonb NOT NULL DEFAULT '{}'::jsonb;
