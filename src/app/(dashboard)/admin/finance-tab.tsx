"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  DollarSign,
  CheckCircle2,
  Clock,
  AlertTriangle,
  FileText,
  Receipt,
  TrendingUp,
  Loader2,
  Copy,
  Ban,
} from "lucide-react";
import { MetricCard } from "@/components/dashboard/metric-card";
import { EmptyState } from "@/components/dashboard/empty-state";
import { SkeletonCard } from "@/components/dashboard/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
import { formatCurrency } from "@/lib/currency";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";

type InvoiceStatus = "pending" | "paid" | "overdue" | "cancelled";

interface AdminInvoice {
  id: string;
  accountId: string;
  accountName: string | null;
  ownerEmail: string | null;
  planName: string;
  amountCents: number;
  currency: string;
  status: InvoiceStatus;
  dueDate: string;
  paidAt: string | null;
  checkoutUrl: string | null;
  createdAt: string;
}

interface InvoiceSummary {
  faturamentoTotalCents: number;
  recebidoCents: number;
  emAbertoCents: number;
  vencidoCents: number;
  totalInvoices: number;
  invoicesPagas: number;
  invoicesPendentes: number;
  ticketMedioCents: number;
}

interface Filters {
  from: string;
  to: string;
  status: string;
  accountId: string;
  search: string;
  minValue: string;
  maxValue: string;
}

const EMPTY_FILTERS: Filters = { from: "", to: "", status: "", accountId: "", search: "", minValue: "", maxValue: "" };

const STATUS_BADGE: Record<InvoiceStatus, "secondary" | "outline" | "destructive" | "ghost"> = {
  paid: "secondary",
  pending: "outline",
  overdue: "destructive",
  cancelled: "ghost",
};

/** Financeiro (Fase 2 of the platform admin expansion) — every tenant
 *  invoice across the platform, with the same filters/summary math as
 *  the reference panel's own Financeiro > Receitas tab, adapted to
 *  what wacrm actually tracks (see `GET /api/admin/invoices`'s doc for
 *  the reverse-engineered summary formulas). Despesas/Relatórios/NFS-e
 *  aren't built — there's no expense tracking or tax-invoice
 *  integration in this app to show a real tab for. */
export function AdminFinanceTab() {
  const t = useTranslations("Admin.finance");
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<Filters>(EMPTY_FILTERS);
  const [invoices, setInvoices] = useState<AdminInvoice[] | null>(null);
  const [summary, setSummary] = useState<InvoiceSummary | null>(null);
  const [error, setError] = useState(false);
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { confirm, dialog } = useConfirmDialog();

  useEffect(() => {
    fetch("/api/admin/accounts")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => setAccounts((data.accounts ?? []).map((a: { id: string; name: string }) => ({ id: a.id, name: a.name }))))
      .catch(() => {});
  }, []);

  const load = useCallback((f: Filters) => {
    setError(false);
    setInvoices(null);
    const params = new URLSearchParams();
    if (f.from) params.set("from", f.from);
    if (f.to) params.set("to", f.to);
    if (f.status) params.set("status", f.status);
    if (f.accountId) params.set("accountId", f.accountId);
    if (f.search) params.set("search", f.search);
    if (f.minValue) params.set("minCents", String(Math.round(Number(f.minValue) * 100)));
    if (f.maxValue) params.set("maxCents", String(Math.round(Number(f.maxValue) * 100)));
    fetch(`/api/admin/invoices?${params.toString()}`)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => {
        setInvoices(data.invoices as AdminInvoice[]);
        setSummary(data.summary as InvoiceSummary);
      })
      .catch(() => setError(true));
  }, []);

  useEffect(() => {
    load(appliedFilters);
  }, [appliedFilters, load]);

  const handleSearch = () => setAppliedFilters(filters);
  const handleClear = () => {
    setFilters(EMPTY_FILTERS);
    setAppliedFilters(EMPTY_FILTERS);
  };

  const markPaid = async (invoice: AdminInvoice) => {
    const ok = await confirm({
      title: t("markPaidConfirmTitle"),
      description: t("markPaidConfirmDesc", { name: invoice.accountName ?? "" }),
      confirmLabel: t("markPaidConfirmButton"),
    });
    if (!ok) return;
    setBusyId(invoice.id);
    try {
      const res = await fetch(`/api/admin/invoices/${invoice.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "paid" }),
      });
      if (res.ok) {
        toast.success(t("markPaidSuccess"));
        load(appliedFilters);
      } else {
        toast.error(t("actionFailed"));
      }
    } catch {
      toast.error(t("actionFailed"));
    } finally {
      setBusyId(null);
    }
  };

  const cancelInvoice = async (invoice: AdminInvoice) => {
    const ok = await confirm({
      title: t("cancelConfirmTitle"),
      description: t("cancelConfirmDesc", { name: invoice.accountName ?? "" }),
      confirmLabel: t("cancelConfirmButton"),
      destructive: true,
    });
    if (!ok) return;
    setBusyId(invoice.id);
    try {
      const res = await fetch(`/api/admin/invoices/${invoice.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "cancelled" }),
      });
      if (res.ok) {
        toast.success(t("cancelSuccess"));
        load(appliedFilters);
      } else {
        toast.error(t("actionFailed"));
      }
    } catch {
      toast.error(t("actionFailed"));
    } finally {
      setBusyId(null);
    }
  };

  const copyCheckoutUrl = (url: string) => {
    navigator.clipboard.writeText(url).then(
      () => toast.success(t("linkCopied")),
      () => toast.error(t("actionFailed")),
    );
  };

  return (
    <div className="space-y-6">
      {dialog}

      <div className="rounded-lg border border-border p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">{t("filterFrom")}</label>
            <Input type="date" value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">{t("filterTo")}</label>
            <Input type="date" value={filters.to} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">{t("filterStatus")}</label>
            <Select value={filters.status || "all"} onValueChange={(v) => setFilters((f) => ({ ...f, status: v === "all" ? "" : (v ?? "") }))}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("filterStatusAll")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("filterStatusAll")}</SelectItem>
                <SelectItem value="pending">{t("statusPending")}</SelectItem>
                <SelectItem value="paid">{t("statusPaid")}</SelectItem>
                <SelectItem value="overdue">{t("statusOverdue")}</SelectItem>
                <SelectItem value="cancelled">{t("statusCancelled")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">{t("filterAccount")}</label>
            <Select value={filters.accountId || "all"} onValueChange={(v) => setFilters((f) => ({ ...f, accountId: v === "all" ? "" : (v ?? "") }))}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("filterAccountAll")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("filterAccountAll")}</SelectItem>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <label className="text-xs text-muted-foreground">{t("filterSearch")}</label>
            <Input value={filters.search} onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))} placeholder={t("filterSearchPlaceholder")} />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">{t("filterMin")}</label>
            <Input type="number" min="0" step="0.01" value={filters.minValue} onChange={(e) => setFilters((f) => ({ ...f, minValue: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">{t("filterMax")}</label>
            <Input type="number" min="0" step="0.01" value={filters.maxValue} onChange={(e) => setFilters((f) => ({ ...f, maxValue: e.target.value }))} />
          </div>
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={handleClear}>
            {t("filterClear")}
          </Button>
          <Button size="sm" onClick={handleSearch}>
            {t("filterSearchButton")}
          </Button>
        </div>
      </div>

      {error ? (
        <EmptyState
          title={t("loadFailed")}
          action={
            <Button size="sm" variant="outline" onClick={() => load(appliedFilters)}>
              {t("retry")}
            </Button>
          }
        />
      ) : !summary || !invoices ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard title={t("totalRevenue")} value={formatCurrency(summary.faturamentoTotalCents / 100, "BRL")} icon={DollarSign} />
            <MetricCard title={t("totalReceived")} value={formatCurrency(summary.recebidoCents / 100, "BRL")} icon={CheckCircle2} />
            <MetricCard title={t("totalOutstanding")} value={formatCurrency(summary.emAbertoCents / 100, "BRL")} icon={Clock} />
            <MetricCard title={t("totalOverdue")} value={formatCurrency(summary.vencidoCents / 100, "BRL")} icon={AlertTriangle} />
            <MetricCard title={t("totalInvoices")} value={String(summary.totalInvoices)} icon={FileText} />
            <MetricCard title={t("invoicesPaid")} value={String(summary.invoicesPagas)} icon={Receipt} />
            <MetricCard title={t("invoicesPending")} value={String(summary.invoicesPendentes)} icon={Receipt} />
            <MetricCard title={t("averageTicket")} value={formatCurrency(summary.ticketMedioCents / 100, "BRL")} icon={TrendingUp} />
          </div>

          <div className="rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("colAccount")}</TableHead>
                  <TableHead>{t("colDescription")}</TableHead>
                  <TableHead>{t("colValue")}</TableHead>
                  <TableHead>{t("colDueDate")}</TableHead>
                  <TableHead>{t("colStatus")}</TableHead>
                  <TableHead>{t("colCreatedAt")}</TableHead>
                  <TableHead>{t("colActions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.map((inv) => {
                  const overdue = inv.status === "overdue";
                  return (
                    <TableRow key={inv.id}>
                      <TableCell>
                        <p className="font-medium text-foreground">{inv.accountName ?? "—"}</p>
                        {inv.ownerEmail && <p className="text-xs text-muted-foreground">{inv.ownerEmail}</p>}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{inv.planName}</TableCell>
                      <TableCell className="font-medium text-foreground">{formatCurrency(inv.amountCents / 100, inv.currency)}</TableCell>
                      <TableCell className={overdue ? "font-medium text-destructive" : "text-muted-foreground"}>
                        {new Date(inv.dueDate).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_BADGE[inv.status]}>{t(`status${inv.status[0]!.toUpperCase()}${inv.status.slice(1)}`)}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{new Date(inv.createdAt).toLocaleDateString()}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          {(inv.status === "pending" || inv.status === "overdue") && (
                            <>
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                title={t("markPaidAction")}
                                disabled={busyId === inv.id}
                                onClick={() => markPaid(inv)}
                              >
                                {busyId === inv.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                              </Button>
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                title={t("cancelAction")}
                                disabled={busyId === inv.id}
                                onClick={() => cancelInvoice(inv)}
                              >
                                <Ban className="h-4 w-4" />
                              </Button>
                            </>
                          )}
                          {inv.checkoutUrl && (
                            <Button size="icon-xs" variant="ghost" title={t("copyLinkAction")} onClick={() => copyCheckoutUrl(inv.checkoutUrl!)}>
                              <Copy className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {invoices.length === 0 && <p className="mt-6 text-center text-sm text-muted-foreground">{t("noResults")}</p>}
        </>
      )}
    </div>
  );
}
