"use client";

/**
 * First-login checklist (UX audit Parte 4) — shown on the Dashboard
 * instead of the regular widgets until the account's basics are in
 * place. Only rendered for admin+ (the steps below are all admin-only
 * actions elsewhere in the app — a viewer/agent could never clear
 * them), and only for accounts created after migration 065 (existing
 * accounts were backfilled with `onboarding_dismissed_at` already set,
 * so they never see this at all).
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  CheckCircle2,
  Circle,
  Loader2,
  PlugZap,
  Blocks,
  Bot,
  TestTube2,
  UsersRound,
  X,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  computeOnboardingSteps,
  isOnboardingComplete,
  type OnboardingStepKey,
} from "@/lib/onboarding/checklist";

const STEP_ICON: Record<OnboardingStepKey, typeof PlugZap> = {
  whatsapp: PlugZap,
  businessType: Blocks,
  aiAgent: Bot,
  aiTested: TestTube2,
  inviteTeam: UsersRound,
};

const STEP_HREF: Record<OnboardingStepKey, string> = {
  whatsapp: "/settings?tab=whatsapp",
  businessType: "/settings?tab=modules",
  aiAgent: "/agents",
  aiTested: "/agents",
  inviteTeam: "/settings?tab=members",
};

export function OnboardingChecklist() {
  const { accountId, canEditSettings, canManageMembers, profileLoading } = useAuth();
  const t = useTranslations("Onboarding");

  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [signals, setSignals] = useState<{
    whatsappConnected: boolean;
    businessTypeDecidedAt: string | null;
    aiConfigured: boolean;
    aiTestedAt: string | null;
    teamSize: number;
  } | null>(null);

  useEffect(() => {
    if (profileLoading || !accountId || !canEditSettings) return;
    let cancelled = false;
    const supabase = createClient();

    (async () => {
      const [accountRes, whatsappRes, aiRes, membersRes, invitesRes] =
        await Promise.allSettled([
          supabase
            .from("accounts")
            .select("onboarding_business_type_at, onboarding_dismissed_at")
            .eq("id", accountId)
            .maybeSingle(),
          supabase
            .from("whatsapp_config")
            .select("status")
            .eq("account_id", accountId)
            .maybeSingle(),
          fetch("/api/ai/config").then((r) => r.json()),
          fetch("/api/account/members").then((r) => r.json()),
          canManageMembers
            ? fetch("/api/account/invitations").then((r) => r.json())
            : Promise.resolve({ invitations: [] }),
        ]);

      if (cancelled) return;

      const account =
        accountRes.status === "fulfilled" ? accountRes.value.data : null;
      if (account?.onboarding_dismissed_at) {
        setDismissed(true);
        setLoading(false);
        return;
      }

      const whatsapp =
        whatsappRes.status === "fulfilled" ? whatsappRes.value.data : null;
      const ai = aiRes.status === "fulfilled" ? aiRes.value : null;
      const members =
        membersRes.status === "fulfilled" && Array.isArray(membersRes.value?.members)
          ? membersRes.value.members.length
          : 1;
      const invites =
        invitesRes.status === "fulfilled" &&
        Array.isArray(invitesRes.value?.invitations)
          ? invitesRes.value.invitations.length
          : 0;

      setSignals({
        whatsappConnected: whatsapp?.status === "connected",
        businessTypeDecidedAt: account?.onboarding_business_type_at ?? null,
        aiConfigured: Boolean(ai?.configured),
        aiTestedAt: ai?.onboarding_tested ? "yes" : null,
        teamSize: members + invites,
      });
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [accountId, canEditSettings, canManageMembers, profileLoading]);

  async function handleSkip() {
    if (!accountId) return;
    setDismissing(true);
    const supabase = createClient();
    await supabase
      .from("accounts")
      .update({ onboarding_dismissed_at: new Date().toISOString() })
      .eq("id", accountId);
    setDismissed(true);
    setDismissing(false);
  }

  // Non-admins can't act on any of these steps elsewhere in the app
  // (WhatsApp/AI/module settings are all admin+-gated), so they never
  // see the checklist at all rather than a wall they can't clear.
  if (profileLoading || !canEditSettings) return null;

  if (loading) {
    return (
      <Card className="items-center px-5 py-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </Card>
    );
  }

  if (dismissed || !signals) return null;

  const steps = computeOnboardingSteps(signals);
  if (isOnboardingComplete(steps)) return null;

  const doneCount = steps.filter((s) => s.done).length;

  return (
    <Card className="px-5 py-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">{t("title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleSkip}
          disabled={dismissing}
          className="shrink-0 text-muted-foreground"
        >
          {dismissing ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
          {t("skip")}
        </Button>
      </div>

      <p className="mt-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {t("progress", { done: doneCount, total: steps.length })}
      </p>

      <div className="mt-2 grid gap-2">
        {steps.map((step) => {
          const Icon = STEP_ICON[step.key];
          return (
            <div
              key={step.key}
              className={cn(
                "flex items-center gap-3 rounded-lg border border-border p-3",
                step.done ? "bg-muted/30" : "bg-card",
              )}
            >
              {step.done ? (
                <CheckCircle2 className="size-5 shrink-0 text-primary" />
              ) : (
                <Circle className="size-5 shrink-0 text-muted-foreground/40" />
              )}
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "text-sm font-medium",
                      step.done ? "text-muted-foreground line-through" : "text-foreground",
                    )}
                  >
                    {t(`steps.${step.key}.title`)}
                  </span>
                  {step.optional && (
                    <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {t("optional")}
                    </span>
                  )}
                </div>
                {!step.done && (
                  <p className="text-xs text-muted-foreground">
                    {t(`steps.${step.key}.description`)}
                  </p>
                )}
              </div>
              {!step.done && (
                <Link
                  href={STEP_HREF[step.key]}
                  className={buttonVariants({
                    variant: "outline",
                    size: "sm",
                    className: "shrink-0",
                  })}
                >
                  {t(`steps.${step.key}.cta`)}
                </Link>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
