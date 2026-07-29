-- ============================================================
-- 039_ticket_flow.sql — Whaticket-style ticket buckets (Phase 1)
--
-- Turns the inbox into an explicit start/close attendance flow. The
-- existing 3-value `status` enum (open/pending/closed) already maps
-- 1:1 onto ABERTO/PENDENTE/FECHADO — no new status value is added and
-- the CHECK constraint from 001_initial_schema.sql is untouched.
-- CHATBOT is NOT a DB status; it's a bucket derived in application
-- code from columns that already exist:
--
--   status = 'pending' AND assigned_agent_id IS NULL
--     AND ai_autoreply_disabled = false
--     AND the account has ai_configs.auto_reply_enabled = true
--
-- Two changes:
--
--   1. New conversations must start as PENDENTES, not ABERTOS — a
--      human (or the bot) hasn't started attendance yet. The column
--      previously defaulted to 'open', which silently put every new
--      ticket straight into ABERTOS with nobody having "started"
--      anything. `findOrCreateConversation`
--      (src/lib/whatsapp/inbound-message.ts) is also updated to pass
--      `status: 'pending'` explicitly — this DEFAULT is
--      belt-and-suspenders, not the only fix.
--
--   2. Audit columns for the two new explicit actions ("start
--      attendance" moves PENDENTES/CHATBOT -> ABERTOS, "close
--      attendance" moves ABERTOS -> FECHADOS, both via
--      POST /api/conversations/[id]/attendance). Mirrors how
--      `assigned_agent_id` already answers "who" but never "when" —
--      these columns exist so the inbox/reports can show "opened by
--      X at T" / "closed by Y at T, reason: Z" without scraping
--      automation/flow logs for a proxy signal.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE conversations
  ALTER COLUMN status SET DEFAULT 'pending';

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS opened_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS opened_by    UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS closed_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_by    UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS close_reason TEXT;

COMMENT ON COLUMN conversations.opened_at IS
  'Stamped by POST /api/conversations/[id]/attendance {action:"start"} — when a human explicitly started attendance (PENDENTES/CHATBOT -> ABERTOS). NULL if never started.';
COMMENT ON COLUMN conversations.opened_by IS
  'User who started attendance — see opened_at.';
COMMENT ON COLUMN conversations.closed_at IS
  'Stamped by POST /api/conversations/[id]/attendance {action:"close"} — when a human explicitly closed attendance (ABERTOS -> FECHADOS). NULL if never closed, or cleared on reopen.';
COMMENT ON COLUMN conversations.closed_by IS
  'User who closed attendance — see closed_at.';
COMMENT ON COLUMN conversations.close_reason IS
  'Optional free-text reason captured on close. NULL-able; cleared on reopen.';

-- No RLS policy change: conversations_select/insert/update/delete
-- (017_account_sharing.sql) are column-agnostic — is_account_member()
-- checks the row's account_id, not which columns are being written.
