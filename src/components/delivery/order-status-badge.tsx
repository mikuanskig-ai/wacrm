import type { DeliveryOrderStatus } from "@/types";
import { useTranslations } from "next-intl";

// Ladder progression left-to-right maps loosely to color temperature —
// draft/pending are neutral, in-flight statuses are warm, delivered is
// green, cancelled is red. Purely a visual cue, no business logic here.
const STATUS_STYLE: Record<DeliveryOrderStatus, string> = {
  draft: "border-border bg-muted text-muted-foreground",
  pending_confirmation: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  confirmed: "border-blue-500/40 bg-blue-500/10 text-blue-300",
  in_production: "border-orange-500/40 bg-orange-500/10 text-orange-300",
  ready: "border-purple-500/40 bg-purple-500/10 text-purple-300",
  out_for_delivery: "border-cyan-500/40 bg-cyan-500/10 text-cyan-300",
  delivered: "border-green-500/40 bg-green-500/10 text-green-300",
  cancelled: "border-red-500/40 bg-red-500/10 text-red-300",
};

export function OrderStatusBadge({ status }: { status: DeliveryOrderStatus }) {
  const t = useTranslations("Delivery.orderStatus");
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider ${STATUS_STYLE[status]}`}
    >
      {t(status)}
    </span>
  );
}
