import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Closing banner — the last, biggest "always selling" push before
 *  the footer. */
export async function FinalCtaSection() {
  const t = await getTranslations("Landing.finalCta");

  return (
    <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6 sm:pb-28">
      <div className="rounded-3xl border border-primary/20 bg-gradient-to-br from-primary-soft to-primary-soft-2 px-6 py-16 text-center sm:px-12 sm:py-20">
        <h2 className="text-balance font-heading text-3xl font-semibold text-foreground sm:text-4xl">
          {t("title")}
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-muted-foreground">{t("description")}</p>
        <Link href="/signup" className="mt-8 inline-block">
          <Button
            size="lg"
            className="h-11 gap-2 bg-primary px-6 text-base text-primary-foreground hover:bg-primary/90"
          >
            {t("cta")}
            <ArrowRight className="h-4 w-4" />
          </Button>
        </Link>
      </div>
    </section>
  );
}
