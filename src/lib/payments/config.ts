import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'

/**
 * Decrypted `payment_configs` row for one account. Shared by
 * create-order.ts (needs the access token to open a preference) and
 * the Mercado Pago webhook route (needs both the access token and the
 * webhook secret) — kept in one place so the select + decrypt logic
 * isn't duplicated between them.
 */
export interface PaymentConfigSecrets {
  enabled: boolean
  mpAccessToken: string
  mpWebhookSecret: string
}

export async function getPaymentConfigSecrets(
  db: SupabaseClient,
  accountId: string,
): Promise<PaymentConfigSecrets | null> {
  const { data } = await db
    .from('payment_configs')
    .select('enabled, mp_access_token, mp_webhook_secret')
    .eq('account_id', accountId)
    .maybeSingle()

  if (!data) return null

  return {
    enabled: data.enabled,
    mpAccessToken: decrypt(data.mp_access_token),
    mpWebhookSecret: decrypt(data.mp_webhook_secret),
  }
}
