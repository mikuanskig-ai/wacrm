"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { hasModule } from "@/lib/accounts/modules";
import { useCan } from "@/hooks/use-can";
import type { DeliveryOrder } from "@/types";
import { STATUS_FLOW } from "@/lib/delivery/status-flow";
import { OperationsBoard } from "@/components/delivery/operations-board";
import { Button } from "@/components/ui/button";
import { ArrowLeft, UtensilsCrossed } from "lucide-react";
import { useTranslations } from "next-intl";

const ACTIVE_STATUSES = STATUS_FLOW.filter((s) => s !== "delivered");

export default function DeliveryOperationsPage() {
  const t = useTranslations("Delivery.operationsBoard");
  const supabase = createClient();
  const { account, accountId, profileLoading } = useAuth();
  const canEdit = useCan("send-messages");

  const [orders, setOrders] = useState<DeliveryOrder[]>([]);
  const [loading, setLoading] = useState(true);

  const moduleEnabled = hasModule(account, "delivery");

  const loadOrders = useCallback(async () => {
    const { data } = await supabase
      .from("delivery_orders")
      .select("*, contact:contacts(*)")
      .in("status", ACTIVE_STATUSES)
      .order("created_at", { ascending: true });
    setOrders((data ?? []) as DeliveryOrder[]);
  }, [supabase]);

  useEffect(() => {
    if (profileLoading || !moduleEnabled) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- kicks off the async load, settled inside the .finally callback
    setLoading(true);
    loadOrders().finally(() => setLoading(false));
  }, [profileLoading, moduleEnabled, loadOrders]);

  // Realtime — same postgres_changes pattern as src/hooks/use-realtime.ts,
  // but a dedicated subscription here rather than extending that hook:
  // different table, different lifecycle (this board only cares about
  // delivery_orders, not messages/conversations).
  const loadOrdersRef = useRef(loadOrders);
  useEffect(() => {
    loadOrdersRef.current = loadOrders;
  }, [loadOrders]);

  useEffect(() => {
    if (!accountId || !moduleEnabled) return;
    const channel = supabase
      .channel(`delivery-operations-${accountId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "delivery_orders", filter: `account_id=eq.${accountId}` },
        () => loadOrdersRef.current(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, accountId, moduleEnabled]);

  if (profileLoading) {
    return <div className="h-8 w-48 animate-pulse rounded bg-muted" />;
  }

  if (!moduleEnabled) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-20">
        <UtensilsCrossed className="h-12 w-12 text-muted-foreground" />
        <h3 className="mt-4 text-lg font-medium text-foreground">{t("moduleOffTitle")}</h3>
        <Button
          render={<Link href="/settings?tab=modules" />}
          className="mt-4 bg-primary text-primary-foreground hover:bg-primary/90"
        >
          {t("goToSettings")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button
          render={<Link href="/delivery/pedidos" />}
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-xl font-semibold text-foreground">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
      </div>

      {loading ? (
        <div className="h-64 animate-pulse rounded-xl bg-muted/50" />
      ) : (
        <OperationsBoard orders={orders} canEdit={canEdit} onOrderUpdated={loadOrders} />
      )}
    </div>
  );
}
