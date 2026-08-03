"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ArrowLeft, Loader2, Plus } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { formatPriceCents } from "@/lib/billing/invoices";
import { PlanFormDialog, type AdminPlan } from "@/components/admin/plan-form-dialog";

export default function AdminPlansPage() {
  const t = useTranslations("Admin.plans");
  const { isPlatformAdmin, profileLoading } = useAuth();
  const router = useRouter();

  const [plans, setPlans] = useState<AdminPlan[] | null>(null);
  const [error, setError] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AdminPlan | null>(null);

  const load = useCallback(() => {
    fetch("/api/admin/plans")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => setPlans(data.plans as AdminPlan[]))
      .catch(() => setError(true));
  }, []);

  useEffect(() => {
    if (profileLoading) return;
    if (!isPlatformAdmin) {
      router.replace("/dashboard");
      return;
    }
    load();
  }, [isPlatformAdmin, profileLoading, router, load]);

  if (profileLoading || (!error && plans === null)) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t("loading")}
      </div>
    );
  }

  return (
    <div>
      <Button variant="ghost" size="sm" onClick={() => router.push("/admin")} className="mb-4 -ml-2">
        <ArrowLeft className="mr-1 h-4 w-4" /> {t("backToAccounts")}
      </Button>

      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-foreground">{t("listTitle")}</h1>
          <p className="text-sm text-muted-foreground">{t("listDescription")}</p>
        </div>
        <Button
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <Plus className="mr-1 h-4 w-4" /> {t("newPlan")}
        </Button>
      </div>

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {t("loadFailed")}
        </p>
      )}

      {plans !== null && (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("name")}</TableHead>
                <TableHead>{t("priceLabel")}</TableHead>
                <TableHead>{t("cycleLabel")}</TableHead>
                <TableHead>{t("maxUsersLabel")}</TableHead>
                <TableHead>{t("modulesLabel")}</TableHead>
                <TableHead>{t("statusColumn")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plans.map((plan) => (
                <TableRow
                  key={plan.id}
                  className="cursor-pointer"
                  onClick={() => {
                    setEditing(plan);
                    setDialogOpen(true);
                  }}
                >
                  <TableCell className="font-medium text-foreground">{plan.name}</TableCell>
                  <TableCell>{formatPriceCents(plan.price_cents, plan.currency)}</TableCell>
                  <TableCell className="text-muted-foreground">{t(`cycle.${plan.billing_cycle}`)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {plan.max_users ?? t("unlimited")}
                  </TableCell>
                  <TableCell>
                    {plan.enabled_modules.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {plan.enabled_modules.map((m) => (
                          <Badge key={m} variant="outline">
                            {m}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {!plan.is_active && <Badge variant="destructive">{t("inactive")}</Badge>}
                      {plan.is_active && !plan.is_public && <Badge variant="outline">{t("privateBadge")}</Badge>}
                      {plan.is_active && plan.is_public && <Badge variant="secondary">{t("publicBadge")}</Badge>}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <PlanFormDialog open={dialogOpen} onOpenChange={setDialogOpen} plan={editing} onSaved={load} />
    </div>
  );
}
