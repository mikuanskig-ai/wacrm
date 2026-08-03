"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowLeft, Loader2, Ban, CheckCircle2, CreditCard } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { MODULE_KEYS, type ModuleKey } from "@/lib/accounts/modules";
import { formatPriceCents } from "@/lib/billing/invoices";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";

interface AdminInvoice {
  id: string;
  plan_name: string;
  amount_cents: number;
  currency: string;
  status: "pending" | "paid" | "overdue" | "cancelled";
  period_start: string;
  period_end: string;
  due_date: string;
  paid_at: string | null;
}

interface AdminAccountDetail {
  account: {
    id: string;
    name: string;
    slug: string | null;
    status: "active" | "suspended";
    suspended_reason: "manual" | "overdue" | null;
    enabled_modules: string[];
    plan_id: string | null;
    created_at: string;
  };
  owner_email: string | null;
  whatsapp: { status: string; connected_at: string | null; wuzapi_instance_name: string | null } | null;
  plan: { id: string; name: string; price_cents: number; currency: string; billing_cycle: string } | null;
  invoices: AdminInvoice[];
  ai_usage: { window_days: number; by_provider: { provider: string; total_tokens: number }[] };
}

interface PlanOption {
  id: string;
  name: string;
  price_cents: number;
  currency: string;
  is_active: boolean;
}

const NO_PLAN = "__none__";

export default function AdminAccountDetailPage() {
  const t = useTranslations("Admin.detail");
  const tCommon = useTranslations("Common");
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const { isPlatformAdmin, profileLoading } = useAuth();
  const router = useRouter();
  const params = useParams<{ accountId: string }>();
  const accountId = params.accountId;

  const [detail, setDetail] = useState<AdminAccountDetail | null>(null);
  const [error, setError] = useState(false);
  const [enabledModules, setEnabledModules] = useState<string[]>([]);
  const [savingModules, setSavingModules] = useState(false);
  const [togglingStatus, setTogglingStatus] = useState(false);
  const [planOptions, setPlanOptions] = useState<PlanOption[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<string>(NO_PLAN);
  const [savingPlan, setSavingPlan] = useState(false);
  const [markingPaidId, setMarkingPaidId] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/admin/accounts/${accountId}`)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data: AdminAccountDetail) => {
        setDetail(data);
        setEnabledModules(data.account.enabled_modules);
        setSelectedPlanId(data.account.plan_id ?? NO_PLAN);
      })
      .catch(() => setError(true));
  }, [accountId]);

  useEffect(() => {
    if (profileLoading) return;
    if (!isPlatformAdmin) {
      router.replace("/dashboard");
      return;
    }
    load();
    fetch("/api/admin/plans")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => setPlanOptions(data.plans as PlanOption[]))
      .catch(() => {
        // Best-effort — the plan card just shows the current plan
        // read-only if the options list fails to load.
      });
  }, [isPlatformAdmin, profileLoading, router, load]);

  const dirty =
    !!detail &&
    (enabledModules.length !== detail.account.enabled_modules.length ||
      enabledModules.some((m) => !detail.account.enabled_modules.includes(m)));

  function toggleModule(key: ModuleKey, on: boolean) {
    setEnabledModules((prev) =>
      on ? [...new Set([...prev, key])] : prev.filter((k) => k !== key),
    );
  }

  async function handleSaveModules() {
    setSavingModules(true);
    const res = await fetch(`/api/admin/accounts/${accountId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled_modules: enabledModules }),
    });
    setSavingModules(false);
    if (!res.ok) {
      toast.error(t("modulesSaveFailed"));
      return;
    }
    toast.success(t("modulesSaveSuccess"));
    load();
  }

  async function handleChangePlan() {
    setSavingPlan(true);
    const res = await fetch(`/api/admin/accounts/${accountId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan_id: selectedPlanId === NO_PLAN ? null : selectedPlanId }),
    });
    setSavingPlan(false);
    if (!res.ok) {
      toast.error(t("planSaveFailed"));
      return;
    }
    toast.success(t("planSaveSuccess"));
    load();
  }

  async function handleMarkPaid(invoiceId: string) {
    const yes = await confirm({
      title: t("confirmMarkPaid"),
      confirmLabel: tCommon("confirm"),
    });
    if (!yes) return;
    setMarkingPaidId(invoiceId);
    const res = await fetch(`/api/admin/invoices/${invoiceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "paid" }),
    });
    setMarkingPaidId(null);
    if (!res.ok) {
      toast.error(t("markPaidFailed"));
      return;
    }
    toast.success(t("markPaidSuccess"));
    load();
  }

  async function handleToggleSuspend() {
    if (!detail) return;
    const suspending = detail.account.status !== "suspended";
    const confirmMsg = suspending ? t("confirmSuspend") : t("confirmReactivate");
    const yes = await confirm({
      title: confirmMsg,
      confirmLabel: tCommon("confirm"),
      destructive: suspending,
    });
    if (!yes) return;

    setTogglingStatus(true);
    const res = await fetch(`/api/admin/accounts/${accountId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: suspending ? "suspended" : "active" }),
    });
    setTogglingStatus(false);
    if (!res.ok) {
      toast.error(t("statusUpdateFailed"));
      return;
    }
    toast.success(suspending ? t("suspendSuccess") : t("reactivateSuccess"));
    load();
  }

  if (profileLoading || (!error && !detail)) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t("loading")}
      </div>
    );
  }

  if (error || !detail) {
    return (
      <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {t("loadFailed")}
      </p>
    );
  }

  const suspended = detail.account.status === "suspended";

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <Button variant="ghost" size="sm" onClick={() => router.push("/admin")} className="mb-2 -ml-2">
          <ArrowLeft className="mr-1 h-4 w-4" /> {t("back")}
        </Button>
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-foreground">{detail.account.name}</h1>
          <Badge variant={suspended ? "destructive" : "secondary"}>
            {suspended ? t("statusSuspended") : t("statusActive")}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">{detail.owner_email ?? "—"}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("infoTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-muted-foreground">{t("infoSlug")}</p>
            <p className="text-foreground">{detail.account.slug ?? "—"}</p>
          </div>
          <div>
            <p className="text-muted-foreground">{t("infoCreatedAt")}</p>
            <p className="text-foreground">{new Date(detail.account.created_at).toLocaleDateString()}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CreditCard className="h-4 w-4 text-primary" /> {t("planTitle")}
          </CardTitle>
          {detail.plan && (
            <CardDescription>
              {formatPriceCents(detail.plan.price_cents, detail.plan.currency)} · {t(`cycle.${detail.plan.billing_cycle}`)}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="flex items-end gap-2">
          <div className="flex-1 space-y-2">
            <Select value={selectedPlanId} onValueChange={(v) => setSelectedPlanId(v ?? NO_PLAN)}>
              <SelectTrigger>
                <SelectValue>
                  {(value: string | null) => {
                    if (!value || value === NO_PLAN) return t("noPlan");
                    const plan = planOptions.find((p) => p.id === value);
                    if (plan) return plan.name;
                    // Not in planOptions yet (e.g. inactive plan filtered
                    // out, or options still loading) — fall back to the
                    // detail payload's own plan name instead of the id.
                    return detail.plan && detail.plan.id === value ? detail.plan.name : value;
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PLAN}>{t("noPlan")}</SelectItem>
                {planOptions
                  .filter((p) => p.is_active || p.id === detail.account.plan_id)
                  .map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} — {formatPriceCents(p.price_cents, p.currency)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={handleChangePlan} disabled={savingPlan || selectedPlanId === (detail.account.plan_id ?? NO_PLAN)}>
            {savingPlan && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("planSave")}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("invoicesTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          {detail.invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("invoicesEmpty")}</p>
          ) : (
            <div className="space-y-2">
              {detail.invoices.map((inv) => (
                <div
                  key={inv.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3 text-sm"
                >
                  <div>
                    <p className="font-medium text-foreground">
                      {formatPriceCents(inv.amount_cents, inv.currency)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t("invoiceDue", { date: new Date(inv.due_date).toLocaleDateString() })}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={
                        inv.status === "paid"
                          ? "secondary"
                          : inv.status === "overdue"
                            ? "destructive"
                            : "outline"
                      }
                    >
                      {t(`invoiceStatus.${inv.status}`)}
                    </Badge>
                    {(inv.status === "pending" || inv.status === "overdue") && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleMarkPaid(inv.id)}
                        disabled={markingPaidId === inv.id}
                      >
                        {markingPaidId === inv.id && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                        {t("markPaid")}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("whatsappTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {detail.whatsapp ? (
            <div className="flex items-center gap-2">
              <Badge variant={detail.whatsapp.status === "connected" ? "secondary" : "outline"}>
                {detail.whatsapp.status === "connected" ? t("whatsappConnected") : t("whatsappDisconnected")}
              </Badge>
              {detail.whatsapp.connected_at && (
                <span className="text-muted-foreground">
                  {t("whatsappConnectedAt", { date: new Date(detail.whatsapp.connected_at).toLocaleString() })}
                </span>
              )}
            </div>
          ) : (
            <p className="text-muted-foreground">{t("whatsappNotConfigured")}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("aiUsageTitle")}</CardTitle>
          <CardDescription>{t("aiUsageDesc", { days: detail.ai_usage.window_days })}</CardDescription>
        </CardHeader>
        <CardContent>
          {detail.ai_usage.by_provider.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("aiUsageEmpty")}</p>
          ) : (
            <div className="space-y-1 text-sm">
              {detail.ai_usage.by_provider.map((row) => (
                <div key={row.provider} className="flex items-center justify-between">
                  <span className="text-foreground">{row.provider}</span>
                  <span className="text-muted-foreground">
                    {t("aiUsageTokens", { tokens: row.total_tokens.toLocaleString() })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("modulesTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3">
            {MODULE_KEYS.map((key) => (
              <div
                key={key}
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3"
              >
                <span className="text-sm font-medium text-foreground">{key}</span>
                <Switch
                  checked={enabledModules.includes(key)}
                  onCheckedChange={(v) => toggleModule(key, v)}
                />
              </div>
            ))}
          </div>
          <Button onClick={handleSaveModules} disabled={savingModules || !dirty}>
            {savingModules && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("modulesSave")}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("dangerZoneTitle")}</CardTitle>
          <CardDescription>
            {suspended
              ? detail.account.suspended_reason === "overdue"
                ? t("dangerZoneDescOverdue")
                : t("dangerZoneDescSuspended")
              : t("dangerZoneDescActive")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant={suspended ? "outline" : "destructive"}
            onClick={handleToggleSuspend}
            disabled={togglingStatus}
          >
            {togglingStatus ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : suspended ? (
              <CheckCircle2 className="mr-2 h-4 w-4" />
            ) : (
              <Ban className="mr-2 h-4 w-4" />
            )}
            {suspended ? t("reactivateAccount") : t("suspendAccount")}
          </Button>
        </CardContent>
      </Card>
      {confirmDialog}
    </div>
  );
}
