import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { encrypt } from '@/lib/whatsapp/encryption'
import { getPaymentConfigSecrets, getPixKey } from './config'

function fakeDb(row: Record<string, unknown> | null): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: row, error: null }),
        }),
      }),
    }),
  } as unknown as SupabaseClient
}

describe('getPixKey', () => {
  it('returns the plaintext key when set', async () => {
    const db = fakeDb({ pix_key: '45999526657' })
    expect(await getPixKey(db, 'acct-1')).toBe('45999526657')
  })

  it('returns null when no row exists at all', async () => {
    const db = fakeDb(null)
    expect(await getPixKey(db, 'acct-1')).toBeNull()
  })

  it('returns null when a row exists (e.g. Mercado Pago configured) but no Pix key was ever set', async () => {
    const db = fakeDb({ pix_key: null })
    expect(await getPixKey(db, 'acct-1')).toBeNull()
  })
})

describe('getPaymentConfigSecrets', () => {
  it('decrypts and returns both secrets when both are set', async () => {
    const db = fakeDb({
      enabled: true,
      mp_access_token: encrypt('APP_USR-token'),
      mp_webhook_secret: encrypt('whsec_123'),
    })
    expect(await getPaymentConfigSecrets(db, 'acct-1')).toEqual({
      enabled: true,
      mpAccessToken: 'APP_USR-token',
      mpWebhookSecret: 'whsec_123',
    })
  })

  it('returns null when no row exists', async () => {
    const db = fakeDb(null)
    expect(await getPaymentConfigSecrets(db, 'acct-1')).toBeNull()
  })

  it('returns null (not a decrypt crash) when a row exists but Mercado Pago was never configured — regression, 2026-08-09', async () => {
    // Migration 071 made mp_access_token/mp_webhook_secret nullable so
    // an account can save just a Pix key with no Mercado Pago setup at
    // all — this must not try to decrypt(null) for that row.
    const db = fakeDb({ enabled: false, mp_access_token: null, mp_webhook_secret: null, pix_key: '123' })
    expect(await getPaymentConfigSecrets(db, 'acct-1')).toBeNull()
  })
})
