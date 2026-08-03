"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Check, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { formatPriceCents } from "@/lib/billing/invoices";

interface PublicPlan {
  id: string;
  name: string;
  description: string | null;
  price_cents: number;
  currency: string;
  billing_cycle: "monthly" | "quarterly" | "semiannual" | "annual";
  max_users: number | null;
  enabled_modules: string[];
}

export default function PricingPage() {
  const t = useTranslations("Pricing");
  const [plans, setPlans] = useState<PublicPlan[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/public/plans")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => {
        if (!cancelled) setPlans(data.plans as PublicPlan[]);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto max-w-5xl px-4 py-16 sm:py-24">
      <header className="text-center">
        <div className="mb-4 flex justify-center">
          <ShieldCheck className="h-8 w-8 text-primary" />
        </div>
        <h1 className="text-3xl font-bold text-foreground sm:text-4xl">{t("title")}</h1>
        <p className="mt-3 text-muted-foreground">{t("subtitle")}</p>
      </header>

      {error && (
        <p className="mt-12 text-center text-sm text-destructive">{t("loadFailed")}</p>
      )}

      {!error && plans === null && (
        <div className="mt-16 flex items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> {t("loading")}
        </div>
      )}

      {plans !== null && plans.length === 0 && !error && (
        <p className="mt-12 text-center text-sm text-muted-foreground">{t("empty")}</p>
      )}

      {plans !== null && plans.length > 0 && (
        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {plans.map((plan) => (
            <Card key={plan.id} className="flex flex-col">
              <CardHeader>
                <CardTitle className="text-xl">{plan.name}</CardTitle>
                {plan.description && <CardDescription>{plan.description}</CardDescription>}
              </CardHeader>
              <CardContent className="flex-1">
                <p className="text-3xl font-bold text-foreground">
                  {formatPriceCents(plan.price_cents, plan.currency)}
                </p>
                <p className="text-sm text-muted-foreground">{t(`cycle.${plan.billing_cycle}`)}</p>

                <ul className="mt-5 space-y-2 text-sm text-foreground">
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 shrink-0 text-primary" />
                    {plan.max_users === null
                      ? t("usersUnlimited")
                      : t("usersLimited", { count: plan.max_users })}
                  </li>
                  {plan.enabled_modules.map((m) => (
                    <li key={m} className="flex items-center gap-2">
                      <Check className="h-4 w-4 shrink-0 text-primary" />
                      {t(`module.${m}`, { fallback: m })}
                    </li>
                  ))}
                </ul>
              </CardContent>
              <CardFooter>
                <Link href={`/signup?plan=${plan.id}`} className="w-full">
                  <Button className="w-full bg-primary text-primary-foreground hover:bg-primary/90">
                    {t("subscribe")}
                  </Button>
                </Link>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      <p className="mt-12 text-center text-sm text-muted-foreground">
        {t("alreadyHaveAccount")}{" "}
        <Link href="/login" className="text-primary hover:text-primary/80">
          {t("signIn")}
        </Link>
      </p>
    </div>
  );
}
