-- ============================================================
-- 066_ai_reply_debounce.sql — per-conversation inbound sequence for
--                              AI auto-reply debounce.
--
-- Bug (confirmed live 2026-08-06, screenshots from a client test):
-- when a customer sends two WhatsApp messages back-to-back (typing
-- across bubbles, or an impatient double-send), each inbound message
-- independently triggers `dispatchInboundToAiReply`. Both dispatches
-- read the SAME not-yet-answered conversation context and each
-- generate their own LLM reply — two near-duplicate texts sent to the
-- customer. Worse: `claim_ai_reply_slot` only caps the count, it
-- doesn't dedupe by message, so a burst of 2 replies for what should
-- have been 1 turn burns the per-conversation reply cap
-- (`auto_reply_max_per_conversation`, default 3) twice as fast — the
-- bot then silently goes quiet on the customer's NEXT real message
-- once the cap is exhausted, with no handoff, no visible flag, and
-- the "responding automatically" banner still showing.
--
-- Fix: `conversations.ai_inbound_seq` — bumped once per inbound
-- customer message routed to the AI. `dispatchInboundToAiReply`
-- captures the value assigned to ITS message, sleeps a short debounce
-- window, then re-reads the column: if a newer inbound bumped it
-- meanwhile, this dispatch stands down — the dispatch for that newer
-- message will build context that already includes this one, so only
-- ONE reply goes out per burst instead of one per message.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_inbound_seq bigint NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.bump_ai_inbound_seq(conversation_id uuid)
RETURNS bigint AS $$
  UPDATE conversations
  SET ai_inbound_seq = ai_inbound_seq + 1
  WHERE id = conversation_id
  RETURNING ai_inbound_seq;
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

-- Only the service-role webhook path calls this (no auth.uid() on an
-- inbound webhook) — same reasoning as claim_ai_reply_slot (031) /
-- claim_ai_tool_turn (044).
GRANT EXECUTE ON FUNCTION public.bump_ai_inbound_seq(uuid) TO service_role;
