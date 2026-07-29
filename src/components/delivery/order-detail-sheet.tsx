"use client";

import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { formatCurrency } from "@/lib/currency";
import type { DeliveryOrder, DeliveryOrderStatus } from "@/types";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { OrderStatusBadge } from "./order-status-badge";
import { PaymentStatusBadge } from "./payment-status-badge";
import { STATUS_FLOW } from "@/lib/delivery/status-flow";
import { Loader2, Printer } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

interface OrderDetailSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  order: DeliveryOrder | null;
  onStatusChanged: () => void;
}

export function OrderDetailSheet({ open, onOpenChange, order, onStatusChanged }: OrderDetailSheetProps) {
  const t = useTranslations("Delivery.orderDetail");
  const tStatus = useTranslations("Delivery.orderStatus");
  const { defaultCurrency } = useAuth();
  const canEdit = useCan("send-messages");
  const [updating, setUpdating] = useState<DeliveryOrderStatus | null>(null);

  if (!order) return null;

  const currentIndex = STATUS_FLOW.indexOf(order.status);
  const nextStatus = currentIndex >= 0 && currentIndex < STATUS_FLOW.length - 1 ? STATUS_FLOW[currentIndex + 1] : null;
  const isTerminal = order.status === "delivered" || order.status === "cancelled";

  async function handleStatusChange(status: DeliveryOrderStatus) {
    if (!order) return;
    setUpdating(status);
    const res = await fetch(`/api/delivery/orders/${order.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    const data = await res.json().catch(() => ({}));
    setUpdating(null);
    if (!res.ok) {
      toast.error(data?.error ?? t("toastFailedUpdate"));
      return;
    }
    toast.success(t("toastUpdated"));
    onStatusChanged();
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="bg-popover border-border text-popover-foreground sm:max-w-lg w-full p-0"
      >
        <div className="flex h-full flex-col">
          <SheetHeader className="border-b border-border/50 p-4">
            <div className="flex items-center justify-between gap-2">
              <SheetTitle className="flex items-center gap-2 text-popover-foreground">
                {t("orderNumber", { id: order.id.slice(0, 8) })}
                <OrderStatusBadge status={order.status} />
                <PaymentStatusBadge status={order.payment_status} />
              </SheetTitle>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => window.open(`/delivery/pedidos/${order.id}/imprimir`, "_blank")}
                title={t("print")}
              >
                <Printer className="h-4 w-4" />
              </Button>
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div className="grid gap-1 text-sm">
              <p className="text-foreground">
                <span className="text-muted-foreground">{t("customer")}: </span>
                {order.contact?.name || order.customer_name || t("unknownCustomer")}
              </p>
              {order.delivery_address && (
                <p className="text-foreground">
                  <span className="text-muted-foreground">{t("address")}: </span>
                  {order.delivery_address}
                </p>
              )}
              {order.notes && (
                <p className="text-foreground">
                  <span className="text-muted-foreground">{t("notes")}: </span>
                  {order.notes}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                {order.source === "whatsapp_flow"
                  ? t("sourceFlow")
                  : order.source === "ai_chat"
                    ? t("sourceAiChat")
                    : order.source === "public_web"
                      ? t("sourcePublicWeb")
                      : t("sourceManual")}
              </p>
              {order.checkout_url && (
                <p className="text-foreground">
                  <span className="text-muted-foreground">{t("checkoutLink")}: </span>
                  <a
                    href={order.checkout_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline"
                  >
                    {order.checkout_url}
                  </a>
                </p>
              )}
            </div>

            <div className="grid gap-1.5">
              {(order.items ?? []).map((item) => (
                <div key={item.id} className="rounded-lg border border-border bg-muted/30 px-2.5 py-1.5 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-foreground">
                      {item.quantity}× {item.product_name}
                    </span>
                    <span className="font-medium text-foreground">
                      {formatCurrency(item.line_total, order.currency || defaultCurrency)}
                    </span>
                  </div>
                  {item.addons_snapshot.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {item.addons_snapshot.map((a) => a.option_name).join(", ")}
                    </p>
                  )}
                </div>
              ))}
            </div>

            <div className="grid gap-1 border-t border-border/50 pt-3 text-sm">
              <div className="flex justify-between text-muted-foreground">
                <span>{t("subtotal")}</span>
                <span>{formatCurrency(order.subtotal, order.currency || defaultCurrency)}</span>
              </div>
              {order.delivery_fee != null && (
                <div className="flex justify-between text-muted-foreground">
                  <span>{t("deliveryFee")}</span>
                  <span>{formatCurrency(order.delivery_fee, order.currency || defaultCurrency)}</span>
                </div>
              )}
              <div className="flex justify-between font-semibold text-foreground">
                <span>{t("total")}</span>
                <span>{formatCurrency(order.total, order.currency || defaultCurrency)}</span>
              </div>
            </div>
          </div>

          {canEdit && !isTerminal && (
            <div className="border-t border-border/50 bg-popover/80 p-4 space-y-2">
              {nextStatus && (
                <Button
                  onClick={() => handleStatusChange(nextStatus)}
                  disabled={!!updating}
                  className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {updating === nextStatus ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    t("advanceTo", { status: tStatus(nextStatus) })
                  )}
                </Button>
              )}
              <Button
                variant="outline"
                onClick={() => handleStatusChange("cancelled")}
                disabled={!!updating}
                className="w-full border-red-500/30 bg-transparent text-red-400 hover:bg-red-500/10"
              >
                {updating === "cancelled" ? <Loader2 className="h-4 w-4 animate-spin" /> : t("cancelOrder")}
              </Button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
