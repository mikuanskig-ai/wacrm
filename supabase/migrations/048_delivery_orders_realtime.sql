-- ============================================================
-- 048_delivery_orders_realtime.sql — Zontalk Delivery module (Fase 5: Operação).
--
-- Enables Realtime on delivery_orders so the operations board
-- (/delivery/operacao) reflects new/advanced orders live across every
-- open tablet/monitor, mirroring the ADD TABLE pattern migration 001
-- used for messages/conversations.
--
-- Idempotent — safe to run multiple times.
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'delivery_orders'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE delivery_orders;
  END IF;
END $$;
