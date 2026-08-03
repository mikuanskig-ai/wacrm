-- ============================================================
-- 051_flow_numeric_menu_node.sql
--
-- Adds 'numeric_menu' to `flow_nodes.node_type` — a plain-text
-- numbered-menu node (channel-agnostic, unlike send_buttons/send_list
-- which are Meta Cloud API only). See src/lib/flows/types.ts's
-- NumericMenuNodeConfig and src/lib/flows/engine.ts's
-- matchNumericMenuReply.
--
-- Same drop-and-recreate pattern as migrations 010/016/045.
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
    'order_summary',
    'numeric_menu'
  ));
