import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazy, shared service-role client for payment webhook work. Mirrors
// the pattern used by every other module (automations/flows/ai
// admin-client.ts) — the Mercado Pago webhook route has no logged-in
// user, only an accountId taken from the URL, so it must bypass RLS.
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}
