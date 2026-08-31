import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Sparkles, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

/** The thesis of the whole page — leads with the AI ordering pitch,
 *  not the generic CRM framing (see the plan's confirmed content
 *  angle). The mini conversation mock on the right reuses the exact
 *  bubble classes message-bubble.tsx uses for bot vs. customer
 *  messages (bg-primary/rounded-br-md vs bg-muted/rounded-bl-md) —
 *  a faithful miniature of the real inbox UI, not a fabricated
 *  screenshot. */
export async function HeroSection() {
  const t = await getTranslations("Landing.hero");

  return (
    <section className="relative overflow-hidden bg-[url('/inbox-doodle.svg')] bg-repeat">
      <div className="absolute inset-0 bg-gradient-to-b from-background via-background/95 to-background" />
      <div className="relative mx-auto grid max-w-6xl gap-12 px-4 py-20 sm:px-6 sm:py-28 lg:grid-cols-[1.1fr_0.9fr] lg:items-center lg:py-32">
        <div>
          <div className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary-soft px-3 py-1 text-xs font-medium text-primary">
            <Sparkles className="h-3.5 w-3.5" />
            {t("eyebrow")}
          </div>

          <h1 className="mt-6 text-balance font-heading text-4xl font-semibold leading-[1.1] tracking-tight text-foreground sm:text-5xl lg:text-[3.25rem]">
            {t("headline")}
          </h1>

          <p className="mt-6 max-w-xl text-pretty text-lg leading-relaxed text-muted-foreground">
            {t("subheadline")}
          </p>

          <div className="mt-10 flex flex-wrap items-center gap-3">
            <Link href="/signup">
              <Button
                size="lg"
                className="h-11 gap-2 bg-primary px-6 text-base text-primary-foreground hover:bg-primary/90"
              >
                {t("ctaPrimary")}
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
            <a href="#como-funciona">
              <Button variant="outline" size="lg" className="h-11 px-6 text-base">
                {t("ctaSecondary")}
              </Button>
            </a>
          </div>
        </div>

        {/* Mini conversation mock — decorative on smaller screens. */}
        <div className="hidden lg:block" aria-hidden="true">
          <div className="mx-auto max-w-sm rounded-3xl border border-border/60 bg-card p-5 shadow-2xl shadow-black/20 ring-1 ring-foreground/5">
            <div className="flex flex-col gap-3">
              <div className="max-w-[85%] self-start rounded-2xl rounded-bl-md bg-muted px-3.5 py-2.5 text-sm text-foreground">
                Boa noite! Queria 2 marmitas M, 1 sem macarrão
              </div>
              <div className="max-w-[85%] self-end rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-sm text-primary-foreground">
                Perfeito 😊 Anotei:
                <br />
                1x Marmita M
                <br />
                1x Marmita M — sem macarrão
                <br />
                Total: R$50 — confirma?
              </div>
              <div className="max-w-[85%] self-start rounded-2xl rounded-bl-md bg-muted px-3.5 py-2.5 text-sm text-foreground">
                Sim, pode confirmar
              </div>
              <div className="flex items-center gap-2 self-end rounded-full bg-primary-soft px-3 py-1.5 text-xs font-medium text-primary">
                <Sparkles className="h-3 w-3" />
                Pedido enviado pra impressão
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
