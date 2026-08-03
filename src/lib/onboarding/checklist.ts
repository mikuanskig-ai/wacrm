// ============================================================
// First-login checklist (UX audit Parte 4) — replaces the generic
// Dashboard for a brand-new account until the basics are in place:
// WhatsApp connected, business type decided, AI agent configured and
// test-driven, team invited (optional). See migration 065 for the
// three columns this reads (accounts.onboarding_business_type_at/
// onboarding_dismissed_at, ai_configs.onboarding_tested_at).
//
// Every step but one is derived from data that already has its own
// source of truth (whatsapp_config.status, ai_configs having a key,
// member/invite counts) — no separate "done" flag to drift out of
// sync. The one exception is "business type decided": enabling
// Delivery is a real signal, but *deciding not to* leaves no row
// anywhere, so that step alone needs the explicit timestamp.
// ============================================================

export type OnboardingStepKey =
  | "whatsapp"
  | "businessType"
  | "aiAgent"
  | "aiTested"
  | "inviteTeam";

export interface OnboardingStep {
  key: OnboardingStepKey;
  done: boolean;
  /** Optional steps don't block the checklist from being considered complete. */
  optional?: boolean;
}

export interface OnboardingSignals {
  whatsappConnected: boolean;
  businessTypeDecidedAt: string | null;
  aiConfigured: boolean;
  aiTestedAt: string | null;
  teamSize: number;
}

export function computeOnboardingSteps(signals: OnboardingSignals): OnboardingStep[] {
  return [
    { key: "whatsapp", done: signals.whatsappConnected },
    { key: "businessType", done: signals.businessTypeDecidedAt !== null },
    { key: "aiAgent", done: signals.aiConfigured },
    { key: "aiTested", done: signals.aiTestedAt !== null },
    { key: "inviteTeam", done: signals.teamSize > 1, optional: true },
  ];
}

/** Required (non-optional) steps all done — the checklist can retire in favor of the real Dashboard. */
export function isOnboardingComplete(steps: OnboardingStep[]): boolean {
  return steps.filter((s) => !s.optional).every((s) => s.done);
}
