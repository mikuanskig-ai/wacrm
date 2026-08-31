import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

/** A short invite to /pricing, not a duplicate of it — the real plan
 *  cards (fetched from /api/public/plans) already live there. */
export async function PricingTeaserSection() {
  const t = await getTranslations("Landing.pricingTeaser");

  return (
    <section className="mx-auto max-w-3xl px-4 py-20 text-center sm:px-6 sm:py-24">
      <h2 className="font-heading text-2xl font-semibold text-foreground sm:text-3xl">
        {t("title")}
      </h2>
      <p className="mt-3 text-muted-foreground">{t("description")}</p>
      <Link href="/pricing" className="mt-8 inline-block">
        <Button variant="outline" size="lg" className="h-11 gap-2 px-6 text-base">
          {t("cta")}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </Link>
    </section>
  );
}
