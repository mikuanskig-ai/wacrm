"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Loader2, ShieldCheck } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";

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
  plan_name: string | null;
  billing_status: "current" | "pending" | "overdue";
}

export default function AdminAccountsPage() {
  const t = useTranslations("Admin.list");
  const { isPlatformAdmin, profileLoading } = useAuth();
  const router = useRouter();

  const [accounts, setAccounts] = useState<AdminAccountRow[] | null>(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (profileLoading) return;
    if (!isPlatformAdmin) {
      router.replace("/dashboard");
      return;
    }
    let cancelled = false;
    fetch("/api/admin/accounts")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => {
        if (!cancelled) setAccounts(data.accounts as AdminAccountRow[]);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isPlatformAdmin, profileLoading, router]);

  const filtered = useMemo(() => {
    if (!accounts) return [];
    const q = query.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.owner_email ?? "").toLowerCase().includes(q),
    );
  }, [accounts, query]);

  if (profileLoading || (!isPlatformAdmin && accounts === null)) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t("loading")}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-lg font-semibold text-foreground">{t("title")}</h1>
            <p className="text-sm text-muted-foreground">{t("description")}</p>
          </div>
        </div>
        <Button variant="outline" onClick={() => router.push("/admin/plans")}>
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
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="mb-4 max-w-sm"
          />

          <div className="rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("colName")}</TableHead>
                  <TableHead>{t("colOwner")}</TableHead>
                  <TableHead>{t("colPlan")}</TableHead>
                  <TableHead>{t("colModules")}</TableHead>
                  <TableHead>{t("colWhatsapp")}</TableHead>
                  <TableHead>{t("colStatus")}</TableHead>
                  <TableHead>{t("colCreatedAt")}</TableHead>
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
                    <TableCell>
                      {a.plan_name ? (
                        <div className="flex items-center gap-1.5">
                          <span className="text-foreground">{a.plan_name}</span>
                          {a.billing_status !== "current" && (
                            <Badge variant={a.billing_status === "overdue" ? "destructive" : "outline"}>
                              {a.billing_status === "overdue" ? t("billingOverdue") : t("billingPending")}
                            </Badge>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">{t("noPlan")}</span>
                      )}
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
