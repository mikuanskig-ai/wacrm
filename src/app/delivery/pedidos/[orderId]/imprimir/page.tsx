"use client";

import { use, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatCurrency } from "@/lib/currency";
import type { DeliveryOrder } from "@/types";
import { Loader2, Printer } from "lucide-react";
import { useTranslations } from "next-intl";

type ReceiptOrder = DeliveryOrder & { account: { name: string } | null };

// Deliberately outside the (dashboard) route group — no sidebar/
// header chrome, just this receipt. Printing goes through the
// browser's native print dialog (window.print()), not a raw ESC/POS
// protocol to a thermal printer — a web app can't talk directly to a
// USB/serial printer without a local bridge agent, out of scope for
// this pass. This works with whatever printer the OS already has
// configured, same as printing any other web page.
export default function PrintReceiptPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = use(params);
  const t = useTranslations("Delivery.printReceipt");
  const tStatus = useTranslations("Delivery.orderStatus");
  const [order, setOrder] = useState<ReceiptOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    supabase
      .from("delivery_orders")
      .select("*, items:delivery_order_items(*), account:accounts(name)")
      .eq("id", orderId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        if (!data) {
          setNotFound(true);
        } else {
          setOrder(data as unknown as ReceiptOrder);
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  useEffect(() => {
    if (order) window.print();
  }, [order]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (notFound || !order) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        {t("notFound")}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-sm p-6 text-foreground">
      <div className="mb-4 flex justify-end print:hidden">
        <button
          type="button"
          onClick={() => window.print()}
          className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted"
        >
          <Printer className="h-4 w-4" />
          {t("printAgain")}
        </button>
      </div>

      <div className="space-y-3 text-sm">
        <div className="text-center">
          <h1 className="text-base font-semibold">{order.account?.name}</h1>
          <p className="text-muted-foreground">{t("orderNumber", { id: order.id.slice(0, 8) })}</p>
          <p className="text-muted-foreground">{tStatus(order.status)}</p>
        </div>

        <div className="border-t border-dashed border-border pt-2">
          <p>
            <span className="text-muted-foreground">{t("customer")}: </span>
            {order.contact?.name || order.customer_name || t("unknownCustomer")}
          </p>
          {order.delivery_address && (
            <p>
              <span className="text-muted-foreground">{t("address")}: </span>
              {order.delivery_address}
            </p>
          )}
          {order.notes && (
            <p>
              <span className="text-muted-foreground">{t("notes")}: </span>
              {order.notes}
            </p>
          )}
        </div>

        <div className="border-t border-dashed border-border pt-2 space-y-1">
          {(order.items ?? []).map((item) => (
            <div key={item.id}>
              <div className="flex justify-between">
                <span>
                  {item.quantity}× {item.product_name}
                </span>
                <span>{formatCurrency(item.line_total, order.currency)}</span>
              </div>
              {item.addons_snapshot.length > 0 && (
                <p className="pl-4 text-xs text-muted-foreground">
                  {item.addons_snapshot.map((a) => a.option_name).join(", ")}
                </p>
              )}
              {item.notes && <p className="pl-4 text-xs text-muted-foreground">{item.notes}</p>}
            </div>
          ))}
        </div>

        <div className="border-t border-dashed border-border pt-2 space-y-0.5">
          <div className="flex justify-between text-muted-foreground">
            <span>{t("subtotal")}</span>
            <span>{formatCurrency(order.subtotal, order.currency)}</span>
          </div>
          {order.delivery_fee != null && (
            <div className="flex justify-between text-muted-foreground">
              <span>{t("deliveryFee")}</span>
              <span>{formatCurrency(order.delivery_fee, order.currency)}</span>
            </div>
          )}
          <div className="flex justify-between font-semibold">
            <span>{t("total")}</span>
            <span>{formatCurrency(order.total, order.currency)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
