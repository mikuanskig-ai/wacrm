import { getTranslations } from "next-intl/server";
import { MessageSquareText, Sparkles, Printer, MousePointerClick } from "lucide-react";

const STEPS = [
  { key: "step1", icon: MessageSquareText },
  { key: "step2", icon: Sparkles },
  { key: "step3", icon: Printer },
] as const;

export async function HowItWorksSection() {
  const t = await getTranslations("Landing.howItWorks");

  return (
    <section id="como-funciona" className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
      <h2 className="text-center font-heading text-3xl font-semibold text-foreground sm:text-4xl">
        {t("title")}
      </h2>

      <div className="mt-14 grid gap-8 sm:grid-cols-3">
        {STEPS.map(({ key, icon: Icon }, i) => (
          <div key={key} className="relative">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary-soft">
              <Icon className="h-6 w-6 text-primary" />
            </div>
            <span className="mt-4 block font-heading text-sm font-medium text-primary">
              {String(i + 1).padStart(2, "0")}
            </span>
            <h3 className="mt-1 font-heading text-lg font-medium text-foreground">
              {t(`${key}.title`)}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {t(`${key}.description`)}
            </p>
          </div>
        ))}
      </div>

      <p className="mx-auto mt-14 flex max-w-2xl items-start gap-2 text-sm text-muted-foreground">
        <MousePointerClick className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        {t("flowNote")}
      </p>
    </section>
  );
}
