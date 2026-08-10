"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Ban, CheckCircle2, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { formatPriceCents } from "@/lib/billing/invoices";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";

interface AdminAccountRow {
  id: string;
  name: string;
  slug: string | null;
  status: "active" | "suspended";
  suspended_reason: "manual" | "overdue" | null;
  enabled_modules: string[];
  created_at: string;
  owner_email: string | null;
  whatsapp: { status: string; connected_at: string | null } | null;
  plan_id: string | null;
  plan_name: string | null;
  billing_status: "current" | "pending" | "overdue";
  revenue_paid_cents: number;
}

interface PlanOption {
  id: string;
  name: string;
  price_cents: number;
  currency: string;
  is_active: boolean;
}

const NO_PLAN = "__none__";

/** The account list. Fase 4 of the platform admin expansion added the
 *  filter bar, the Receita column, and inline suspend/reactivate +
 *  plan-reassign actions — before this an admin had to open every
 *  account (`/admin/[accountId]`, still where AI usage / invoice
 *  history / modules live) just to suspend it or see what it pays. */
export function AdminAccountsTab() {
  const t = useTranslations("Admin.list");
  const tDetail = useTranslations("Admin.detail");
  const tCommon = useTranslations("Common");
  const router = useRouter();
  const { confirm, dialog } = useConfirmDialog();

  const [accounts, setAccounts] = useState<AdminAccountRow[] | null>(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [planFilter, setPlanFilter] = useState("");
  const [whatsappFilter, setWhatsappFilter] = useState("");
  const [planOptions, setPlanOptions] = useState<PlanOption[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(false);
    fetch("/api/admin/accounts")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => setAccounts(data.accounts as AdminAccountRow[]))
      .catch(() => setError(true));
  }, []);

  useEffect(() => {
    load();
    fetch("/api/admin/plans")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => setPlanOptions(data.plans as PlanOption[]))
      .catch(() => {
        // Best-effort — the plan column just falls back to plain text
        // (no inline reassign) if the options list fails to load.
      });
  }, [load]);

  const filtered = useMemo(() => {
    if (!accounts) return [];
    const q = query.trim().toLowerCase();
    return accounts.filter((a) => {
      if (q && !a.name.toLowerCase().includes(q) && !(a.owner_email ?? "").toLowerCase().includes(q)) return false;
      if (statusFilter && a.status !== statusFilter) return false;
      if (planFilter && a.plan_id !== planFilter) return false;
      if (whatsappFilter === "connected" && a.whatsapp?.status !== "connected") return false;
      if (whatsappFilter === "disconnected" && a.whatsapp?.status === "connected") return false;
      return true;
    });
  }, [accounts, query, statusFilter, planFilter, whatsappFilter]);

  async function toggleSuspend(account: AdminAccountRow, e: React.MouseEvent) {
    e.stopPropagation();
    const suspending = account.status !== "suspended";
    const ok = await confirm({
      title: suspending ? tDetail("confirmSuspend") : tDetail("confirmReactivate"),
      description: suspending
        ? t("suspendConfirmDesc", { name: account.name })
        : t("reactivateConfirmDesc", { name: account.name }),
      confirmLabel: tCommon("confirm"),
      destructive: suspending,
    });
    if (!ok) return;
    setBusyId(account.id);
    try {
      const res = await fetch(`/api/admin/accounts/${account.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: suspending ? "suspended" : "active" }),
      });
      if (res.ok) {
        toast.success(suspending ? tDetail("suspendSuccess") : tDetail("reactivateSuccess"));
        load();
      } else {
        toast.error(tDetail("statusUpdateFailed"));
      }
    } finally {
      setBusyId(null);
    }
  }

  async function changePlan(account: AdminAccountRow, planId: string) {
    const nextPlanId = planId === NO_PLAN ? null : planId;
    if (nextPlanId === account.plan_id) return;
    setBusyId(account.id);
    try {
      const res = await fetch(`/api/admin/accounts/${account.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_id: nextPlanId }),
      });
      if (res.ok) {
        toast.success(tDetail("planSaveSuccess"));
        load();
      } else {
        toast.error(tDetail("planSaveFailed"));
      }
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      {dialog}
      <div className="mb-6 flex items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t("title")}</h2>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <Button variant="outline" onClick={() => router.push("/admin?tab=plans")}>
          {t("managePlans")}
        </Button>
      </div>

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {t("loadFailed")}
        </p>
      )}

      {!error && accounts === null && (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t("loading")}
        </div>
      )}

      {accounts !== null && (
        <>
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("searchPlaceholder")}
            />
            <Select value={statusFilter || "all"} onValueChange={(v) => setStatusFilter(v === "all" ? "" : (v ?? ""))}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("filterStatusAll")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("filterStatusAll")}</SelectItem>
                <SelectItem value="active">{t("statusActive")}</SelectItem>
                <SelectItem value="suspended">{t("statusSuspended")}</SelectItem>
              </SelectContent>
            </Select>
            <Select value={planFilter || "all"} onValueChange={(v) => setPlanFilter(v === "all" ? "" : (v ?? ""))}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("filterPlanAll")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("filterPlanAll")}</SelectItem>
                {planOptions.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={whatsappFilter || "all"} onValueChange={(v) => setWhatsappFilter(v === "all" ? "" : (v ?? ""))}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("filterWhatsappAll")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("filterWhatsappAll")}</SelectItem>
                <SelectItem value="connected">{t("whatsappConnected")}</SelectItem>
                <SelectItem value="disconnected">{t("whatsappDisconnected")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("colName")}</TableHead>
                  <TableHead>{t("colOwner")}</TableHead>
                  <TableHead>{t("colPlan")}</TableHead>
                  <TableHead>{t("colRevenue")}</TableHead>
                  <TableHead>{t("colModules")}</TableHead>
                  <TableHead>{t("colWhatsapp")}</TableHead>
                  <TableHead>{t("colStatus")}</TableHead>
                  <TableHead>{t("colCreatedAt")}</TableHead>
                  <TableHead>{t("colActions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((a) => (
                  <TableRow
                    key={a.id}
                    className="cursor-pointer"
                    onClick={() => router.push(`/admin/${a.id}`)}
                  >
                    <TableCell className="font-medium text-foreground">{a.name}</TableCell>
                    <TableCell className="text-muted-foreground">{a.owner_email ?? "—"}</TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-1.5">
                        <Select
                          value={a.plan_id ?? NO_PLAN}
                          onValueChange={(v) => changePlan(a, v ?? NO_PLAN)}
                        >
                          <SelectTrigger className="h-8 w-[150px]" disabled={busyId === a.id}>
                            <SelectValue>
                              {(value: string | null) => {
                                if (!value || value === NO_PLAN) return t("noPlan");
                                return planOptions.find((p) => p.id === value)?.name ?? a.plan_name ?? t("noPlan");
                              }}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NO_PLAN}>{t("noPlan")}</SelectItem>
                            {planOptions
                              .filter((p) => p.is_active || p.id === a.plan_id)
                              .map((p) => (
                                <SelectItem key={p.id} value={p.id}>
                                  {p.name}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                        {a.billing_status !== "current" && (
                          <Badge variant={a.billing_status === "overdue" ? "destructive" : "outline"}>
                            {a.billing_status === "overdue" ? t("billingOverdue") : t("billingPending")}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-foreground">
                      {formatPriceCents(a.revenue_paid_cents, "BRL")}
                    </TableCell>
                    <TableCell>
                      {a.enabled_modules.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {a.enabled_modules.map((m) => (
                            <Badge key={m} variant="outline">
                              {m}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={a.whatsapp?.status === "connected" ? "secondary" : "outline"}>
                        {a.whatsapp?.status === "connected" ? t("whatsappConnected") : t("whatsappDisconnected")}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={a.status === "suspended" ? "destructive" : "secondary"}>
                        {a.status === "suspended" ? t("statusSuspended") : t("statusActive")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(a.created_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        title={a.status === "suspended" ? tDetail("reactivateAccount") : tDetail("suspendAccount")}
                        disabled={busyId === a.id}
                        onClick={(e) => toggleSuspend(a, e)}
                      >
                        {busyId === a.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : a.status === "suspended" ? (
                          <CheckCircle2 className="h-4 w-4" />
                        ) : (
                          <Ban className="h-4 w-4" />
                        )}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {filtered.length === 0 && (
            <p className="mt-6 text-center text-sm text-muted-foreground">{t("noResults")}</p>
          )}
        </>
      )}
    </div>
  );
}
