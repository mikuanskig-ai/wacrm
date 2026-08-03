import type { DeliveryOrderStatus } from "@/types";

/**
 * The fulfillment ladder's "happy path" order, excluding the terminal
 * `cancelled` branch (which any status can jump to via a dedicated
 * action, not a "next" step). Shared by order-detail-sheet.tsx (single-
 * order advance button) and operations-board.tsx (Fase 5 KDS columns)
 * so the two never drift apart.
 */
export const STATUS_FLOW: DeliveryOrderStatus[] = [
  "pending_confirmation",
  "confirmed",
  "in_production",
  "ready",
  "out_for_delivery",
  "delivered",
];
