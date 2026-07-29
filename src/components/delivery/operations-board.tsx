"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { DeliveryOrder, DeliveryOrderStatus } from "@/types";
import { STATUS_FLOW } from "@/lib/delivery/status-flow";
import { PaymentStatusBadge } from "./payment-status-badge";
import { Button } from "@/components/ui/button";
import { Loader2, Printer, Clock } from "lucide-react";
import { useTranslations } from "next-intl";

// Fixed visual thresholds (Fase 5 plan §8) — not a configurable
// per-account SLA, just a heuristic so a stuck order stands out on
// the board.
const WARN_AFTER_MINUTES = 15;
const ALERT_AFTER_MINUTES = 30;

function elapsedMinutes(since: string): number {
  return Math.floor((Date.now() - new Date(since).getTime()) / 60000);
}

// Keyed by `since` at the call site (below) so a changed `since` remounts
// this component instead of needing a synchronous setState-in-effect
// resync — the lazy useState initializer then just picks up the fresh
// value, and the interval only has to handle the passage of time.
function ElapsedBadge({ since }: { since: string }) {
  const [minutes, setMinutes] = useState(() => elapsedMinutes(since));

  useEffect(() => {
    const id = setInterval(() => setMinutes(elapsedMinutes(since)), 30_000);
    return () => clearInterval(id);
  }, [since]);

  const tone =
    minutes >= ALERT_AFTER_MINUTES
      ? "border-red-500/40 bg-red-500/10 text-red-300"
      : minutes >= WARN_AFTER_MINUTES
        ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
        : "border-border bg-muted text-muted-foreground";

  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone}`}>
      <Clock className="h-3 w-3" />
      {minutes}m
    </span>
  );
}

interface OperationsBoardProps {
  orders: DeliveryOrder[];
  canEdit: boolean;
  onOrderUpdated: () => void;
}

// Active columns only — `delivered` orders are done, they don't need
// to stay on an operations board waiting for anyone's attention.
const ACTIVE_STATUSES = STATUS_FLOW.filter((s) => s !== "delivered");

export function OperationsBoard({ orders, canEdit, onOrderUpdated }: OperationsBoardProps) {
  const t = useTranslations("Delivery.operationsBoard");
  const tStatus = useTranslations("Delivery.orderStatus");
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  async function advance(order: DeliveryOrder) {
    const idx = STATUS_FLOW.indexOf(order.status);
    const next = idx >= 0 && idx < STATUS_FLOW.length - 1 ? STATUS_FLOW[idx + 1] : null;
    if (!next) return;
    setUpdatingId(order.id);
    const res = await fetch(`/api/delivery/orders/${order.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    const data = await res.json().catch(() => ({}));
    setUpdatingId(null);
    if (!res.ok) {
      toast.error(data?.error ?? t("toastFailedUpdate"));
      return;
    }
    onOrderUpdated();
  }

  function print(order: DeliveryOrder) {
    window.open(`/delivery/pedidos/${order.id}/imprimir`, "_blank");
  }

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {ACTIVE_STATUSES.map((status: DeliveryOrderStatus) => {
        const columnOrders = orders.filter((o) => o.status === status);
        return (
          <div key={status} className="flex w-72 shrink-0 flex-col gap-2">
            <div className="flex items-center justify-between px-1">
              <h3 className="text-sm font-semibold text-foreground">{tStatus(status)}</h3>
              <span className="text-xs text-muted-foreground">{columnOrders.length}</span>
            </div>
            <div className="flex flex-col gap-2">
              {columnOrders.map((order) => (
                <div key={order.id} className="rounded-lg border border-border bg-card p-2.5 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs text-muted-foreground">#{order.id.slice(0, 8)}</span>
                    <ElapsedBadge
                      key={order.status_changed_at ?? order.created_at}
                      since={order.status_changed_at ?? order.created_at}
                    />
                  </div>
                  <p className="mt-1 truncate text-foreground">
                    {order.contact?.name || order.customer_name || t("unknownCustomer")}
                  </p>
                  <div className="mt-1">
                    <PaymentStatusBadge status={order.payment_status} />
                  </div>
                  <div className="mt-2 flex gap-1.5">
                    {canEdit && (
                      <Button
                        size="sm"
                        onClick={() => advance(order)}
                        disabled={updatingId === order.id}
                        className="h-7 flex-1 bg-primary text-xs text-primary-foreground hover:bg-primary/90"
                      >
                        {updatingId === order.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : status === "out_for_delivery" ? (
                          t("markDelivered")
                        ) : (
                          t("advance")
                        )}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => print(order)}
                      className="h-7 border-border bg-transparent px-2 text-muted-foreground hover:bg-muted"
                    >
                      <Printer className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
              {columnOrders.length === 0 && (
                <div className="rounded-lg border border-dashed border-border py-6 text-center text-xs text-muted-foreground">
                  {t("emptyColumn")}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
