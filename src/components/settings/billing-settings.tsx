"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Receipt } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { formatPriceCents } from "@/lib/billing/invoices";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SettingsPanelHead } from "./settings-panel-head";

interface CurrentPlanResponse {
  plan: {
    id: string | null;
    name: string;
    maxUsers: number | null;
    enabledModules: string[];
    billable: boolean;
  };
  accountStatus: "active" | "suspended";
}

interface TenantInvoice {
  id: string;
  plan_name: string;
  amount_cents: number;
  currency: string;
  status: "pending" | "paid" | "overdue" | "cancelled";
  due_date: string;
  paid_at: string | null;
}

/**
 * Mounted in TWO places (same component, same endpoints, deliberately
 * — see the platform-admin/billing plan): the normal Settings >
 * Faturamento panel, and inside `SuspendedScreen`
 * (`dashboard-shell.tsx`) so a tenant suspended for non-payment can
 * still see and pay the invoice that suspended them. Both routes this
 * calls (`/api/billing/current-plan`, `/api/billing/invoices`,
 * `/api/billing/invoices/[id]/checkout`) are suspension-tolerant.
 */
export function BillingSettings() {
  const t = useTranslations("Settings.billing");
  const { canEditSettings } = useAuth();

  const [plan, setPlan] = useState<CurrentPlanResponse["plan"] | null>(null);
  const [invoices, setInvoices] = useState<TenantInvoice[] | null>(null);
  const [error, setError] = useState(false);
  const [payingId, setPayingId] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([
      fetch("/api/billing/current-plan").then((res) => (res.ok ? res.json() : Promise.reject())),
      fetch("/api/billing/invoices").then((res) => (res.ok ? res.json() : Promise.reject())),
    ])
      .then(([planData, invoicesData]: [CurrentPlanResponse, { invoices: TenantInvoice[] }]) => {
        setPlan(planData.plan);
        setInvoices(invoicesData.invoices);
      })
      .catch(() => setError(true));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handlePay(invoiceId: string) {
    setPayingId(invoiceId);
    try {
      const res = await fetch(`/api/billing/invoices/${invoiceId}/checkout`);
      if (!res.ok) {
        toast.error(t("checkoutFailed"));
        return;
      }
      const data = await res.json();
      if (data.paid) {
        toast.success(t("alreadyPaid"));
        load();
        return;
      }
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      }
    } finally {
      setPayingId(null);
    }
  }

  if (error) {
    return (
      <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {t("loadFailed")}
      </p>
    );
  }

  if (!plan || invoices === null) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t("loading")}
      </div>
    );
  }

  const outstanding = invoices.filter((i) => i.status === "pending" || i.status === "overdue");

  return (
    <section className="max-w-2xl space-y-6">
      <SettingsPanelHead title={t("title")} description={t("description")} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Receipt className="h-4 w-4 text-primary" /> {t("currentPlanTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {plan.billable ? (
            <p className="text-foreground">{plan.name}</p>
          ) : (
            <p className="text-muted-foreground">{t("noPlan")}</p>
          )}
        </CardContent>
      </Card>

      {outstanding.length > 0 && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-base text-destructive">{t("outstandingTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {outstanding.map((inv) => (
              <div
                key={inv.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3 text-sm"
              >
                <div>
                  <p className="font-medium text-foreground">{formatPriceCents(inv.amount_cents, inv.currency)}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("invoiceDue", { date: new Date(inv.due_date).toLocaleDateString() })}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={inv.status === "overdue" ? "destructive" : "outline"}>
                    {t(`invoiceStatus.${inv.status}`)}
                  </Badge>
                  {canEditSettings && (
                    <Button size="sm" onClick={() => handlePay(inv.id)} disabled={payingId === inv.id}>
                      {payingId === inv.id && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                      {t("pay")}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("historyTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          {invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("historyEmpty")}</p>
          ) : (
            <div className="space-y-2">
              {invoices.map((inv) => (
                <div key={inv.id} className="flex items-center justify-between text-sm">
                  <span className="text-foreground">{formatPriceCents(inv.amount_cents, inv.currency)}</span>
                  <span className="text-muted-foreground">{new Date(inv.due_date).toLocaleDateString()}</span>
                  <Badge
                    variant={
                      inv.status === "paid" ? "secondary" : inv.status === "overdue" ? "destructive" : "outline"
                    }
                  >
                    {t(`invoiceStatus.${inv.status}`)}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
