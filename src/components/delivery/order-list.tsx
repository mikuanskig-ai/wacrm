"use client";

import type { DeliveryOrder, DeliveryOrderStatus } from "@/types";
import { useAuth } from "@/hooks/use-auth";
import { formatCurrency } from "@/lib/currency";
import { OrderStatusBadge } from "./order-status-badge";
import { PaymentStatusBadge } from "./payment-status-badge";
import { ClipboardList } from "lucide-react";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

const STATUS_FILTERS: (DeliveryOrderStatus | "all")[] = [
  "all",
  "pending_confirmation",
  "confirmed",
  "in_production",
  "ready",
  "out_for_delivery",
  "delivered",
  "cancelled",
];

interface OrderListProps {
  orders: DeliveryOrder[];
  statusFilter: DeliveryOrderStatus | "all";
  onStatusFilterChange: (status: DeliveryOrderStatus | "all") => void;
  onSelectOrder: (order: DeliveryOrder) => void;
}

export function OrderList({ orders, statusFilter, onStatusFilterChange, onSelectOrder }: OrderListProps) {
  const t = useTranslations("Delivery.orderList");
  const tStatus = useTranslations("Delivery.orderStatus");
  const { defaultCurrency } = useAuth();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {STATUS_FILTERS.map((status) => (
          <button
            key={status}
            type="button"
            onClick={() => onStatusFilterChange(status)}
            className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
              statusFilter === status
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-card text-muted-foreground hover:bg-muted"
            }`}
          >
            {status === "all" ? t("allStatuses") : tStatus(status)}
          </button>
        ))}
      </div>

      {orders.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-16">
          <ClipboardList className="h-10 w-10 text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">{t("noOrders")}</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">{t("colOrder")}</th>
                <th className="px-3 py-2 text-left font-medium">{t("colDate")}</th>
                <th className="px-3 py-2 text-left font-medium">{t("colCustomer")}</th>
                <th className="px-3 py-2 text-left font-medium">{t("colSource")}</th>
                <th className="px-3 py-2 text-left font-medium">{t("colStatus")}</th>
                <th className="px-3 py-2 text-left font-medium">{t("colPayment")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("colTotal")}</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr
                  key={order.id}
                  onClick={() => onSelectOrder(order)}
                  className="cursor-pointer border-t border-border hover:bg-muted/40"
                >
                  <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground">
                    #{order.id.slice(0, 8)}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-xs text-muted-foreground">
                    {format(new Date(order.created_at), "dd/MM/yyyy HH:mm", { locale: ptBR })}
                  </td>
                  <td className="px-3 py-2.5 text-foreground">
                    {order.contact?.name || order.customer_name || t("unknownCustomer")}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">
                    {order.source === "whatsapp_flow"
                      ? t("sourceFlow")
                      : order.source === "ai_chat"
                        ? t("sourceAiChat")
                        : order.source === "public_web"
                          ? t("sourcePublicWeb")
                          : t("sourceManual")}
                  </td>
                  <td className="px-3 py-2.5">
                    <OrderStatusBadge status={order.status} />
                  </td>
                  <td className="px-3 py-2.5">
                    <PaymentStatusBadge status={order.payment_status} />
                  </td>
                  <td className="px-3 py-2.5 text-right font-medium text-foreground">
                    {formatCurrency(order.total, order.currency || defaultCurrency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
