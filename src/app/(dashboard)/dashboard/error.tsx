"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Route-level error boundary (Next.js 16 `error.js` convention).
 * Before this existed, a render-time crash anywhere on the dashboard
 * left a blank/frozen page with zero recovery — this is the last
 * resort behind each widget's own error+retry state (UX audit,
 * Parte 2 "tela de erro + retry no Dashboard").
 */
export default function DashboardError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  const t = useTranslations("Dashboard.page");

  useEffect(() => {
    console.error("[dashboard] route error boundary:", error);
  }, [error]);

  return (
    <div className="flex h-full min-h-[60vh] flex-col items-center justify-center gap-3 px-4 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertTriangle className="h-6 w-6" />
      </div>
      <h2 className="text-lg font-semibold text-foreground">{t("errorTitle")}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">{t("errorDescription")}</p>
      <Button onClick={() => unstable_retry()} className="mt-2">
        {t("errorRetry")}
      </Button>
    </div>
  );
}
