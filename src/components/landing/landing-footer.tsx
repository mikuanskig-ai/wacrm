import Link from "next/link";
import { getTranslations } from "next-intl/server";

export async function LandingFooter() {
  const t = await getTranslations("Landing.footer");
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-border/60">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 px-4 py-10 sm:flex-row sm:justify-between sm:px-6">
        <div className="flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element -- brand mark */}
          <img src="/logo-mark.png" alt="" className="h-6 w-6 rounded-md" />
          <span className="text-sm text-muted-foreground">{t("tagline")}</span>
        </div>

        <div className="flex items-center gap-6 text-sm text-muted-foreground">
          <Link href="/pricing" className="hover:text-foreground">
            {t("linkPricing")}
          </Link>
          <Link href="/login" className="hover:text-foreground">
            {t("linkLogin")}
          </Link>
          <span>{t("copyright", { year })}</span>
        </div>
      </div>
    </footer>
  );
}
