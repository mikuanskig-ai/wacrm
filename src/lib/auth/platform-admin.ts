// ============================================================
// Platform-admin identity check — for the /api/admin/* routes that
// manage OTHER tenants' accounts. This is orthogonal to
// `getCurrentAccount`/`requireRole`: those resolve "which account
// does the caller belong to and what's their role in it", while this
// resolves "is the caller the platform operator, period" (see
// profiles.is_platform_admin, migration 062).
//
// Calling convention:
//
//   const { supabase, userId } = await requirePlatformAdmin() // confirms identity only
//   const admin = supabaseAdmin()                              // service-role, for the actual cross-tenant query
//
// The SSR client here is RLS-scoped to the caller's own session —
// good enough to read their own is_platform_admin flag, useless for
// reading/writing other tenants' rows. Every actual admin data
// operation must go through supabaseAdmin() instead, same split
// `requireApiKey` already uses for machine callers.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { createClient } from '@/lib/supabase/server';
import { ForbiddenError, UnauthorizedError } from './account';

export interface PlatformAdminContext {
  /** SSR client, RLS-scoped to the caller. Identity only — do not use for cross-tenant reads/writes. */
  supabase: SupabaseClient;
  userId: string;
}

export async function requirePlatformAdmin(): Promise<PlatformAdminContext> {
  const supabase = await createClient();

  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    throw new UnauthorizedError();
  }

  const { data, error } = await supabase
    .from('profiles')
    .select('is_platform_admin')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) {
    console.error('[requirePlatformAdmin] profile fetch error:', error);
    throw new ForbiddenError('Could not verify platform admin status');
  }
  if (!data?.is_platform_admin) {
    throw new ForbiddenError('Platform admin only');
  }

  return { supabase, userId: user.id };
}
