-- ============================================================
-- 076_delivery_customer_funnel.sql — dashboard customer funnel RPC
--
-- Why an RPC (not client-side aggregation, the dashboard's usual
-- pattern — see src/lib/dashboard/queries.ts header comment)
--
--   This needs the LIFETIME order count per contact (all-time, not
--   bounded by the dashboard's date filter) to classify a customer as
--   returning (2+ orders ever) or loyal (3+ ever) — that means
--   scanning every non-cancelled delivery_orders row for any contact
--   who ordered in the selected period. Pulling that client-side would
--   mean fetching the full orders table per request; a single indexed
--   query does it in one round trip and keeps the counting logic in
--   one place.
--
-- Funnel definition (confirmed with account owner, 2026-09-04)
--
--   1. new_contacts        — contacts.created_at in [p_from, p_to]
--   2. ordering_customers  — of those, contacts with >=1 non-cancelled
--                             order ALSO created in [p_from, p_to]
--                             (keeps the funnel period-bound and
--                             strictly decreasing: stage 2 is a
--                             subset of stage 1)
--   3. returning_customers — of stage 2, contacts with >=2 non-cancelled
--                             orders LIFETIME (no date bound)
--   4. loyal_customers     — of stage 2, contacts with >=3 non-cancelled
--                             orders LIFETIME
--   5. unattributed_orders — non-cancelled orders in [p_from, p_to]
--                             with contact_id NULL. Every order placed
--                             through the public menu checkout
--                             (source='public_web') has no contact_id
--                             by design today (see
--                             src/app/api/public/menu/[slug]/order/route.ts,
--                             "matching contacts unresolved by design")
--                             — those orders are surfaced as a separate
--                             count, not folded into the funnel above,
--                             since we can't tell if two such orders
--                             are the same returning customer.
--
-- Security: SECURITY INVOKER (the default) — runs as the caller, so
-- the existing RLS on contacts/delivery_orders (is_account_member,
-- migrations 017/042) scopes every read to the caller's account. Same
-- pattern as filter_contacts_by_tags (migration 025). p_account_id is
-- passed as an explicit business filter, not a security boundary.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- Covers new_contacts_cte (contacts.account_id + created_at range).
-- No existing index spans created_at for contacts.
CREATE INDEX IF NOT EXISTS idx_contacts_account_created
  ON contacts(account_id, created_at);

-- Partial (WHERE status <> 'cancelled') because every read this
-- migration does — and the existing Pedidos date-range filter — only
-- ever cares about non-cancelled orders. Smaller index, same shape as
-- the existing idx_delivery_orders_account_status.
CREATE INDEX IF NOT EXISTS idx_delivery_orders_account_created
  ON delivery_orders(account_id, created_at)
  WHERE status <> 'cancelled';

CREATE OR REPLACE FUNCTION public.delivery_customer_funnel(
  p_account_id UUID,
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ
)
RETURNS TABLE (
  new_contacts BIGINT,
  ordering_customers BIGINT,
  returning_customers BIGINT,
  loyal_customers BIGINT,
  unattributed_orders BIGINT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH new_contacts_cte AS (
    SELECT c.id
    FROM contacts c
    WHERE c.account_id = p_account_id
      AND c.created_at >= p_from
      AND c.created_at <= p_to
  ),
  ordering_cte AS (
    -- Stage-1 contacts who also placed >=1 non-cancelled order in the
    -- SAME window — keeps the funnel strictly period-bound.
    SELECT DISTINCT o.contact_id AS id
    FROM delivery_orders o
    JOIN new_contacts_cte nc ON nc.id = o.contact_id
    WHERE o.account_id = p_account_id
      AND o.created_at >= p_from
      AND o.created_at <= p_to
      AND o.status <> 'cancelled'
  ),
  lifetime_cte AS (
    -- Lifetime count (no date bound) — only for contacts already in
    -- ordering_cte, so this never scans an order for a contact
    -- outside the funnel.
    SELECT o.contact_id AS id, count(*) AS lifetime_orders
    FROM delivery_orders o
    WHERE o.account_id = p_account_id
      AND o.status <> 'cancelled'
      AND o.contact_id IN (SELECT id FROM ordering_cte)
    GROUP BY o.contact_id
  )
  SELECT
    (SELECT count(*) FROM new_contacts_cte)::BIGINT,
    (SELECT count(*) FROM ordering_cte)::BIGINT,
    (SELECT count(*) FROM lifetime_cte WHERE lifetime_orders >= 2)::BIGINT,
    (SELECT count(*) FROM lifetime_cte WHERE lifetime_orders >= 3)::BIGINT,
    (
      SELECT count(*)
      FROM delivery_orders o
      WHERE o.account_id = p_account_id
        AND o.created_at >= p_from
        AND o.created_at <= p_to
        AND o.status <> 'cancelled'
        AND o.contact_id IS NULL
    )::BIGINT;
$$;

ALTER FUNCTION public.delivery_customer_funnel(UUID, TIMESTAMPTZ, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delivery_customer_funnel(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delivery_customer_funnel(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;
