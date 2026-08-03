// ============================================================
// Platform-admin suspension gate (migration 062). A suspended
// account is blocked everywhere: dashboard (src/lib/auth/account.ts),
// public API (src/lib/auth/api-context.ts), the WuzAPI webhook, the
// automation/broadcast crons, and the public delivery menu
// (src/lib/delivery/public-menu.ts). This file is the single source
// of truth for "is this account suspended" so every call site reads
// the same column the same way.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

export async function isAccountSuspended(
  db: SupabaseClient,
  accountId: string,
): Promise<boolean> {
  const { data } = await db
    .from('accounts')
    .select('status')
    .eq('id', accountId)
    .maybeSingle();
  return data?.status === 'suspended';
}

/**
 * Bulk variant for crons that drain many rows across many accounts in
 * one pass — one query up front instead of one per row.
 */
export async function getSuspendedAccountIds(
  db: SupabaseClient,
): Promise<Set<string>> {
  const { data } = await db.from('accounts').select('id').eq('status', 'suspended');
  return new Set((data ?? []).map((row) => row.id as string));
}
