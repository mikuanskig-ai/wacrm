// ============================================================
// Opt-in feature modules per account (migration 041). Each entry is a
// larger vertical (Delivery being the first) a customer turns on for
// themselves in Settings — not a rollout flag (that's
// `profiles.beta_features`) and not a per-user preference.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

export const MODULE_KEYS = ["delivery"] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

export function hasModule(
  account: { enabled_modules?: string[] | null } | null | undefined,
  key: ModuleKey,
): boolean {
  return !!account?.enabled_modules?.includes(key);
}

/**
 * Server-side lookup of `accounts.enabled_modules`, for call sites that
 * only have an `accountId` (the AI dispatch/draft/playground routes) and
 * not an already-loaded `account` object from `useAuth()`. Returns `[]`
 * on a missing account rather than throwing — callers treat "no
 * modules" and "account not found" the same way (no module-gated
 * feature is available).
 */
export async function getEnabledModules(
  db: SupabaseClient,
  accountId: string,
): Promise<string[]> {
  const { data } = await db
    .from("accounts")
    .select("enabled_modules")
    .eq("id", accountId)
    .maybeSingle();
  return data?.enabled_modules ?? [];
}
