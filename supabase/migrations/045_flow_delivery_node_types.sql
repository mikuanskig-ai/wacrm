-- ============================================================
-- 045_flow_delivery_node_types.sql
--
-- Fixes: saving a Flow with an `add_order_item` or `order_summary`
-- node (Zontalk Delivery node types, migration 042) fails with
-- "new row for relation flow_nodes violates check constraint
-- flow_nodes_node_type_check" — these two node types were added to
-- the TS union (src/lib/flows/types.ts) and wired through the
-- builder/engine/validator in Fase 1, but the DB CHECK constraint on
-- `flow_nodes.node_type` was never updated to match. It still only
-- allowed the list from migration 016 (up through 'send_media').
--
-- Same drop-and-recreate pattern as migrations 010/016.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;

ALTER TABLE flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'send_media',
    'collect_input',
    'condition',
    'set_tag',
    'handoff',
    'http_fetch',
    'end',
    'add_order_item',
    'order_summary'
  ));
