-- ============================================================
-- 067_ai_max_tool_iterations.sql — per-account tool-loop ceiling.
--
-- Was a hardcoded constant (MAX_TOOL_ITERATIONS in src/lib/ai/defaults.ts,
-- 6 then 10) bounding how many tool round-trips (search menu, add to
-- cart, calculate fee, place order...) the AI can make within ONE
-- auto-reply turn before giving up and handing off to a human.
--
-- Confirmed live (2026-08-06): a business taking full orders via chat
-- can genuinely need more than a fixed global default in a single
-- turn (multi-item carts, clarifying re-asks), and hitting the
-- ceiling silently stranded an order mid-flow with no error logged
-- anywhere. Moving it into ai_configs lets an account raise it
-- themselves in Settings instead of waiting on a code deploy.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS max_tool_iterations integer NOT NULL DEFAULT 10;

ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_max_tool_iterations_check;
ALTER TABLE ai_configs ADD CONSTRAINT ai_configs_max_tool_iterations_check
  CHECK (max_tool_iterations BETWEEN 1 AND 30);
