"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Loader2, ShieldCheck, LayoutDashboard, Building2, Wallet, CreditCard } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { AdminDashboardTab } from "./dashboard-tab";
import { AdminAccountsTab } from "./accounts-tab";
import { AdminFinanceTab } from "./finance-tab";
import { AdminPlansTab } from "./plans-tab";

type Tab = "dashboard" | "accounts" | "finance" | "plans";
const TABS: Tab[] = ["dashboard", "accounts", "finance", "plans"];

// Same `?tab=`-is-the-source-of-truth pattern as /settings: deep-linkable
// (the old standalone /admin/plans route now redirects to ?tab=plans) and
// keeps the URL shareable between platform admins. useSearchParams needs
// a Suspense boundary or the build bails to client-only rendering.
export default function AdminPage() {
  return (
    <Suspense fallback={null}>
      <AdminPageInner />
    </Suspense>
  );
}

function AdminPageInner() {
  const t = useTranslations("Admin.list");
  const { isPlatformAdmin, profileLoading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  const rawTab = searchParams.get("tab");
  const tab: Tab = TABS.includes(rawTab as Tab) ? (rawTab as Tab) : "dashboard";

  useEffect(() => {
    if (profileLoading) return;
    if (!isPlatformAdmin) router.replace("/dashboard");
  }, [isPlatformAdmin, profileLoading, router]);

  const go = (next: Tab) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", next);
    router.replace(`/admin?${params.toString()}`, { scroll: false });
  };

  if (profileLoading || !isPlatformAdmin) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t("loading")}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-primary" />
        <div>
          <h1 className="text-lg font-semibold text-foreground">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => go(v as Tab)}>
        <TabsList>
          <TabsTrigger value="dashboard">
            <LayoutDashboard className="mr-1.5 h-4 w-4" /> {t("tabDashboard")}
          </TabsTrigger>
          <TabsTrigger value="accounts">
            <Building2 className="mr-1.5 h-4 w-4" /> {t("tabAccounts")}
          </TabsTrigger>
          <TabsTrigger value="plans">
            <CreditCard className="mr-1.5 h-4 w-4" /> {t("tabPlans")}
          </TabsTrigger>
          <TabsTrigger value="finance">
            <Wallet className="mr-1.5 h-4 w-4" /> {t("tabFinance")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="dashboard" className="mt-4">
          <AdminDashboardTab />
        </TabsContent>

        <TabsContent value="accounts" className="mt-4">
          <AdminAccountsTab />
        </TabsContent>

        <TabsContent value="plans" className="mt-4">
          <AdminPlansTab />
        </TabsContent>

        <TabsContent value="finance" className="mt-4">
          <AdminFinanceTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
