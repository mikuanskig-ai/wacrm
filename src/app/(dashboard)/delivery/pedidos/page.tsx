"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { hasModule } from "@/lib/accounts/modules";
import { useCan } from "@/hooks/use-can";
import type { DeliveryOrder, DeliveryOrderStatus } from "@/types";
import { OrderList } from "@/components/delivery/order-list";
import { OrderForm } from "@/components/delivery/order-form";
import { OrderDetailSheet } from "@/components/delivery/order-detail-sheet";
import { GatedButton } from "@/components/ui/gated-button";
import { Button } from "@/components/ui/button";
import { ArrowLeft, LayoutGrid, Plus, UtensilsCrossed } from "lucide-react";
import { useTranslations } from "next-intl";

export default function DeliveryOrdersPage() {
  const t = useTranslations("Delivery.ordersPage");
  const supabase = createClient();
  const { account, profileLoading } = useAuth();
  const canCreateOrders = useCan("send-messages");

  const [orders, setOrders] = useState<DeliveryOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<DeliveryOrderStatus | "all">("all");
  const [orderFormOpen, setOrderFormOpen] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<DeliveryOrder | null>(null);

  const moduleEnabled = hasModule(account, "delivery");

  const loadOrders = useCallback(async () => {
    const { data } = await supabase
      .from("delivery_orders")
      .select("*, contact:contacts(*), items:delivery_order_items(*)")
      .order("created_at", { ascending: false });
    setOrders((data ?? []) as DeliveryOrder[]);
  }, [supabase]);

  useEffect(() => {
    if (profileLoading || !moduleEnabled) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- kicks off the async load, settled inside the .finally callback
    setLoading(true);
    loadOrders().finally(() => setLoading(false));
  }, [profileLoading, moduleEnabled, loadOrders]);

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

  const filteredOrders = statusFilter === "all" ? orders : orders.filter((o) => o.status === statusFilter);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button
            render={<Link href="/delivery" />}
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
        <div className="flex gap-2">
          <Button
            render={<Link href="/delivery/operacao" />}
            variant="outline"
            className="border-border bg-card text-foreground hover:bg-muted"
          >
            <LayoutGrid className="mr-1.5 h-4 w-4" />
            {t("viewOperations")}
          </Button>
          <GatedButton
            canAct={canCreateOrders}
            gateReason="create delivery orders"
            onClick={() => setOrderFormOpen(true)}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="mr-1 h-4 w-4" />
            {t("newOrder")}
          </GatedButton>
        </div>
      </div>

      {loading ? (
        <div className="h-64 animate-pulse rounded-xl bg-muted/50" />
      ) : (
        <OrderList
          orders={filteredOrders}
          statusFilter={statusFilter}
          onStatusFilterChange={setStatusFilter}
          onSelectOrder={setSelectedOrder}
        />
      )}

      <OrderForm open={orderFormOpen} onOpenChange={setOrderFormOpen} onSaved={loadOrders} />

      <OrderDetailSheet
        open={!!selectedOrder}
        onOpenChange={(open) => {
          if (!open) setSelectedOrder(null);
        }}
        order={selectedOrder}
        onStatusChanged={() => {
          loadOrders();
          setSelectedOrder(null);
        }}
      />
    </div>
  );
}
