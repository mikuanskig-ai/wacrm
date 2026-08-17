"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { hasModule } from "@/lib/accounts/modules";
import { useCan } from "@/hooks/use-can";
import type { DeliveryOrder, DeliveryOrderStatus } from "@/types";
import { OrderList } from "@/components/delivery/order-list";
import { OrderForm } from "@/components/delivery/order-form";
import { OrderDetailSheet } from "@/components/delivery/order-detail-sheet";
import { OrderDateRangeFilter, type OrderDateRange } from "@/components/delivery/order-date-range-filter";
import { GatedButton } from "@/components/ui/gated-button";
import { Button } from "@/components/ui/button";
import { ArrowLeft, LayoutGrid, Plus, UtensilsCrossed } from "lucide-react";
import { useTranslations } from "next-intl";

// `useSearchParams` (for the ?order= deep link) opts this page out of
// static prerendering unless it sits under a Suspense boundary — same
// reasoning and split as settings/page.tsx.
export default function DeliveryOrdersPage() {
  return (
    <Suspense fallback={null}>
      <DeliveryOrdersPageInner />
    </Suspense>
  );
}

function DeliveryOrdersPageInner() {
  const t = useTranslations("Delivery.ordersPage");
  const supabase = createClient();
  const { account, accountId, profileLoading } = useAuth();
  const canCreateOrders = useCan("send-messages");
  const router = useRouter();
  const searchParams = useSearchParams();
  const deepLinkOrderId = searchParams.get("order");

  const [orders, setOrders] = useState<DeliveryOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<DeliveryOrderStatus | "all">("all");
  // null = no date filter, every order loads (today's default — same
  // behaviour as before this filter existed).
  const [dateRange, setDateRange] = useState<OrderDateRange | null>(null);
  const [orderFormOpen, setOrderFormOpen] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<DeliveryOrder | null>(null);

  const moduleEnabled = hasModule(account, "delivery");

  const loadOrders = useCallback(async () => {
    let query = supabase
      .from("delivery_orders")
      .select("*, contact:contacts(*), items:delivery_order_items(*)")
      .order("created_at", { ascending: false });
    // Filtered server-side (not sliced from an already-loaded array) —
    // an account with months of order history shouldn't have to
    // download all of it just to look at today's orders.
    if (dateRange) {
      query = query.gte("created_at", dateRange.from.toISOString()).lte("created_at", dateRange.to.toISOString());
    }
    const { data } = await query;
    setOrders((data ?? []) as DeliveryOrder[]);
  }, [supabase, dateRange]);

  useEffect(() => {
    if (profileLoading || !moduleEnabled) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- kicks off the async load, settled inside the .finally callback
    setLoading(true);
    loadOrders().finally(() => setLoading(false));
  }, [profileLoading, moduleEnabled, loadOrders]);

  // Realtime — same postgres_changes pattern as the Operations board
  // (delivery/operacao/page.tsx). Before this, a new order or a status
  // change made on Operação (or by the AI agent/public menu) only
  // showed up here after a manual reload, even though it's the exact
  // same table both screens read.
  const loadOrdersRef = useRef(loadOrders);
  useEffect(() => {
    loadOrdersRef.current = loadOrders;
  }, [loadOrders]);

  useEffect(() => {
    if (!accountId || !moduleEnabled) return;
    const channel = supabase
      .channel(`delivery-orders-list-${accountId}`)
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

  // Deep link from the Inbox contact sidebar's order mini-cards
  // (?order=<id>) — auto-opens that order's detail sheet once the
  // list has loaded, then clears the param. Re-runs as `orders` fills
  // in after the initial empty array, but only acts while the param is
  // still present — clearing it via replace() is what stops this from
  // firing again on a later reload/refresh.
  useEffect(() => {
    if (!deepLinkOrderId || orders.length === 0) return;
    const match = orders.find((o) => o.id === deepLinkOrderId);
    if (match) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot deep-link resolution, not a render-driven sync
      setSelectedOrder(match);
    }
    router.replace("/delivery/pedidos", { scroll: false });
  }, [deepLinkOrderId, orders, router]);

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
            render={<Link href="/delivery/cardapio" />}
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
        <div className="flex flex-wrap gap-2">
          <OrderDateRangeFilter value={dateRange} onChange={setDateRange} />
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
