import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";

/** Sticky top nav for the landing page. Server Component (no
 *  interactivity needed) — the anchor links just get hidden below
 *  sm/md instead of collapsing into a drawer; logo + "Entrar" + the
 *  signup CTA fit comfortably at any width, so there's no mobile menu
 *  to build or ship client JS for. */
export async function LandingHeader() {
  const t = await getTranslations("Landing.header");

  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element -- brand mark */}
          <img src="/logo-mark.png" alt="" className="h-8 w-8 rounded-lg" />
          <span className="font-heading text-lg font-semibold text-foreground">
            ZonTalk
          </span>
        </Link>

        <nav className="hidden items-center gap-8 md:flex">
          <a
            href="#como-funciona"
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            {t("navHowItWorks")}
          </a>
          <a
            href="#recursos"
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            {t("navFeatures")}
          </a>
          <Link
            href="/pricing"
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            {t("navPricing")}
          </Link>
        </nav>

        <div className="flex items-center gap-2">
          <Link href="/login">
            <Button variant="ghost" size="sm">
              {t("login")}
            </Button>
          </Link>
          <Link href="/signup">
            <Button
              size="sm"
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {t("cta")}
            </Button>
          </Link>
        </div>
      </div>
    </header>
  );
}
