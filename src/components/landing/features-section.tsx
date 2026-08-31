import { getTranslations } from "next-intl/server";
import { Inbox, TrendingUp, Megaphone, Workflow } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

const FEATURES = [
  { key: "inbox", icon: Inbox },
  { key: "pipeline", icon: TrendingUp },
  { key: "broadcast", icon: Megaphone },
  { key: "automations", icon: Workflow },
] as const;

/** "The full CRM underneath" — deliberately lower visual weight than
 *  the hero/how-it-works sections (smaller heading, plain Card grid),
 *  matching the confirmed content angle: AI ordering is the hero,
 *  this is the platform it sits on top of. */
export async function FeaturesSection() {
  const t = await getTranslations("Landing.features");

  return (
    <section id="recursos" className="bg-card-2/40 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <h2 className="text-center font-heading text-2xl font-semibold text-foreground sm:text-3xl">
          {t("title")}
        </h2>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map(({ key, icon: Icon }) => (
            <Card key={key} className="border-border/60 bg-card">
              <CardHeader>
                <Icon className="h-5 w-5 text-primary" />
                <CardTitle className="mt-2">{t(`${key}.title`)}</CardTitle>
                <CardDescription>{t(`${key}.description`)}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
