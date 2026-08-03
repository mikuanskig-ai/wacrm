// ============================================================
// Plan resolution — the single place that defines what
// `accounts.plan_id IS NULL` means. Every other file (module gating,
// seat limits, the admin UI) reads through here rather than
// re-deriving the fallback.
//
// NULL happens for: accounts that predate this feature (backfilled to
// a "Legacy" plan by migration 063, so this should be rare in
// practice) and any account created by calling
// `supabase.auth.signUp()` directly instead of going through
// /pricing (e.g. a script, or the public API). The fallback is
// deliberately permissive — it must match "no restriction", the
// behavior every account had before plans existed, since an invite-
// redemption throwaway account also has plan_id NULL and must never
// be blocked from anything.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { MODULE_KEYS } from '@/lib/accounts/modules'

export interface AccountPlan {
  id: string | null
  name: string
  maxUsers: number | null
  enabledModules: string[]
  /** False for the no-plan fallback — nothing to bill, no invoice
   *  generation should ever target this account. */
  billable: boolean
}

const NO_PLAN_FALLBACK: AccountPlan = {
  id: null,
  name: 'No plan',
  maxUsers: null,
  enabledModules: [...MODULE_KEYS],
  billable: false,
}

export async function getAccountPlan(
  db: SupabaseClient,
  accountId: string,
): Promise<AccountPlan> {
  const { data: account } = await db
    .from('accounts')
    .select('plan_id')
    .eq('id', accountId)
    .maybeSingle()

  if (!account?.plan_id) return NO_PLAN_FALLBACK

  const { data: plan } = await db
    .from('plans')
    .select('id, name, max_users, enabled_modules')
    .eq('id', account.plan_id)
    .maybeSingle()

  // plan_id has an ON DELETE RESTRICT FK, so this should be
  // unreachable in practice — defensive fallback rather than a crash
  // if it ever happens (e.g. manual DB surgery).
  if (!plan) return NO_PLAN_FALLBACK

  return {
    id: plan.id,
    name: plan.name,
    maxUsers: plan.max_users,
    enabledModules: plan.enabled_modules ?? [],
    billable: true,
  }
}

/** Members + outstanding (unaccepted, unexpired) invitations — an
 *  admin shouldn't be able to create 10 pending invites against a
 *  5-seat plan just because none of them have been redeemed yet. */
export async function countSeats(db: SupabaseClient, accountId: string): Promise<number> {
  const [{ count: memberCount }, { count: inviteCount }] = await Promise.all([
    db.from('profiles').select('id', { count: 'exact', head: true }).eq('account_id', accountId),
    db
      .from('account_invitations')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .is('accepted_at', null)
      .gt('expires_at', new Date().toISOString()),
  ])
  return (memberCount ?? 0) + (inviteCount ?? 0)
}

export function canInvite(plan: AccountPlan, currentSeats: number): boolean {
  return plan.maxUsers === null || currentSeats < plan.maxUsers
}
