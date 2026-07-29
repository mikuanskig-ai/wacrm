import type { DeliveryPaymentStatus } from "@/types";
import { useTranslations } from "next-intl";

// Same reasoning as order-status-badge.tsx's STATUS_STYLE — purely a
// visual cue, no business logic. Green for money in, red/amber for the
// two outcomes that mean "didn't get paid".
const PAYMENT_STATUS_STYLE: Record<DeliveryPaymentStatus, string> = {
  pending_payment: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  approved: "border-green-500/40 bg-green-500/10 text-green-300",
  rejected: "border-red-500/40 bg-red-500/10 text-red-300",
  refunded: "border-orange-500/40 bg-orange-500/10 text-orange-300",
  cancelled: "border-border bg-muted text-muted-foreground",
};

export function PaymentStatusBadge({ status }: { status: DeliveryPaymentStatus | null | undefined }) {
  const t = useTranslations("Delivery.paymentStatus");
  if (!status) return null;
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider ${PAYMENT_STATUS_STYLE[status]}`}
    >
      {t(status)}
    </span>
  );
}
