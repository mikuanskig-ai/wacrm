import type { DeliveryOrder } from "@/types";
import { useAuth } from "@/hooks/use-auth";
import { formatCurrency } from "@/lib/currency";
import { OrderStatusBadge } from "./order-status-badge";
import { useTranslations } from "next-intl";

interface DeliveryOrderMiniCardProps {
  order: DeliveryOrder;
  onClick?: () => void;
}

export function DeliveryOrderMiniCard({ order, onClick }: DeliveryOrderMiniCardProps) {
  const t = useTranslations("Delivery.miniCard");
  const { defaultCurrency } = useAuth();

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full flex-col gap-1 rounded-lg border border-border bg-muted/40 p-2.5 text-left transition-colors hover:bg-muted"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground">
          {t("orderNumber", { id: order.id.slice(0, 8) })}
        </span>
        <OrderStatusBadge status={order.status} />
      </div>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{order.items?.length ?? 0} {t("items")}</span>
        <span className="font-semibold text-primary">
          {formatCurrency(order.total, order.currency || defaultCurrency)}
        </span>
      </div>
    </button>
  );
}
