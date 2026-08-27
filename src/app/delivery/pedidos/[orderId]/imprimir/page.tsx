"use client";

import { use, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatCurrency } from "@/lib/currency";
import type { DeliveryOrder } from "@/types";
import { Loader2, Printer } from "lucide-react";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

type ReceiptOrder = DeliveryOrder & {
  account: { name: string } | null;
  contact: { name: string | null; phone: string | null } | null;
};

function formatDateTime(iso: string): string {
  return format(new Date(iso), "dd/MM/yyyy - HH:mm", { locale: ptBR });
}

const SOURCE_LABEL_KEY: Record<DeliveryOrder["source"], "sourceManual" | "sourceFlow" | "sourceAiChat" | "sourcePublicWeb"> = {
  manual: "sourceManual",
  whatsapp_flow: "sourceFlow",
  ai_chat: "sourceAiChat",
  public_web: "sourcePublicWeb",
};

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
  const tSource = useTranslations("Delivery.orderList");
  const [order, setOrder] = useState<ReceiptOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    supabase
      .from("delivery_orders")
      .select("*, items:delivery_order_items(*), account:accounts(name), contact:contacts(name, phone)")
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

      <div className="space-y-3 text-base font-mono">
        <div className="text-center">
          <h1 className="text-lg font-semibold">{order.account?.name}</h1>
          <p className="text-muted-foreground">{t("orderNumber", { id: order.id.slice(0, 8) })}</p>
          <p className="text-sm text-muted-foreground">
            {formatDateTime(order.created_at)} · {tSource(SOURCE_LABEL_KEY[order.source])}
          </p>
          <p className="text-muted-foreground">{tStatus(order.status)}</p>
        </div>

        <div className="border-t border-dashed border-border pt-2">
          <p>
            <span className="text-muted-foreground">{t("customer")}: </span>
            {order.contact?.name || order.customer_name || t("unknownCustomer")}
          </p>
          {order.contact?.phone && (
            <p>
              <span className="text-muted-foreground">{t("phone")}: </span>
              {order.contact.phone}
            </p>
          )}
          {order.delivery_address ? (
            <p className="font-semibold">
              <span className="font-normal text-muted-foreground">{t("address")}: </span>
              {order.delivery_address}
            </p>
          ) : (
            <p className="font-semibold">{t("pickup")}</p>
          )}
        </div>

        {/* Each item's own modifiers/notes use the SAME "-> " prefix and
            sit directly under it, separated from the NEXT item by a
            dashed rule — previously addons and item.notes rendered as
            two visually-identical muted lines with no separation from
            each other or from the next item, which read to a kitchen
            employee/customer as duplicated observations (reported
            live). */}
        <div className="border-t border-dashed border-border pt-2 space-y-2">
          {(order.items ?? []).map((item) => (
            <div key={item.id} className="border-b border-dotted border-border pb-2 last:border-b-0 last:pb-0">
              <div className="flex justify-between">
                <span>
                  {item.quantity}× {item.product_name}
                  {item.quantity > 1 && (
                    <span className="text-sm text-muted-foreground">
                      {" "}
                      ({formatCurrency(item.unit_price, order.currency)} {t("each")})
                    </span>
                  )}
                </span>
                <span className="whitespace-nowrap">{formatCurrency(item.line_total, order.currency)}</span>
              </div>
              {item.addons_snapshot.map((a, i) => (
                <p key={i} className="pl-4 text-sm text-muted-foreground">
                  → {a.option_name}
                </p>
              ))}
              {item.notes && <p className="pl-4 text-sm text-muted-foreground">→ {item.notes}</p>}
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

        {order.payment_method && (
          <div className="border-t border-dashed border-border pt-2">
            <p>
              <span className="text-muted-foreground">{t("paymentMethod")}: </span>
              {order.payment_method}
            </p>
            {order.payment_notes && (
              <p>
                <span className="text-muted-foreground">{t("paymentNotes")}: </span>
                {order.payment_notes}
              </p>
            )}
          </div>
        )}

        {/* Order-level note, kept visually apart (its own labeled,
            bordered block at the very end) from the per-item "-> "
            notes above — so a general instruction is never confused
            with a specific product's modifier. */}
        {order.notes && (
          <div className="border-t border-2 border-dashed border-border pt-2">
            <p className="text-sm font-semibold text-muted-foreground">{t("generalNote")}:</p>
            <p className="italic">&ldquo;{order.notes}&rdquo;</p>
          </div>
        )}

        <div className="flex justify-center gap-6 border-t border-dashed border-border pt-3 text-sm text-muted-foreground print:flex">
          <span>[ ] {t("checkedLabel")}</span>
          <span>[ ] {t("packedLabel")}</span>
        </div>
      </div>
    </div>
  );
}
