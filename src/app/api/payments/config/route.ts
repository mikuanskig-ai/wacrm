import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { verifyAccessToken } from '@/lib/payments/mercadopago-api'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * GET /api/payments/config
 *
 * Any member may read the config so the UI can reflect whether
 * payment is set up. Neither secret is ever returned — only
 * has_access_token / has_webhook_secret flags, same discipline as
 * /api/ai/config.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const { data, error } = await supabase
      .from('payment_configs')
      .select('provider, mp_public_key, enabled, mp_access_token, mp_webhook_secret')
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) {
      console.error('[payments/config GET] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load payment configuration' }, { status: 500 })
    }

    if (!data) return NextResponse.json({ configured: false })

    return NextResponse.json({
      configured: true,
      provider: data.provider,
      mp_public_key: data.mp_public_key,
      enabled: data.enabled,
      has_access_token: !!data.mp_access_token,
      has_webhook_secret: !!data.mp_webhook_secret,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/payments/config  (admin+)
 *
 * Upsert the account's Mercado Pago config. Validates the access token
 * with MP before persisting (GET /users/me — same "verify before save"
 * discipline as /api/ai/config's provider round-trip), then stores
 * both secrets AES-256-GCM-encrypted. Omitted secrets reuse the
 * existing stored value (the form only sends one when re-entered).
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`payments-config:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const enabled = body.enabled === true
    const mpPublicKey =
      typeof body.mp_public_key === 'string' && body.mp_public_key.trim()
        ? body.mp_public_key.trim()
        : null

    const rawAccessToken =
      typeof body.mp_access_token === 'string' ? body.mp_access_token.trim() : ''
    const rawWebhookSecret =
      typeof body.mp_webhook_secret === 'string' ? body.mp_webhook_secret.trim() : ''

    const { data: existing } = await supabase
      .from('payment_configs')
      .select('id, mp_access_token, mp_webhook_secret')
      .eq('account_id', accountId)
      .maybeSingle()

    let accessTokenPlain: string
    if (rawAccessToken) {
      accessTokenPlain = rawAccessToken
    } else if (existing?.mp_access_token) {
      try {
        accessTokenPlain = decrypt(existing.mp_access_token)
      } catch {
        return bad('Stored access token could not be decrypted — re-enter it.')
      }
    } else {
      return bad('mp_access_token is required')
    }

    if (!rawWebhookSecret && !existing?.mp_webhook_secret) {
      return bad('mp_webhook_secret is required')
    }

    // Only spend a round-trip to MP when the token actually changed.
    if (rawAccessToken || !existing) {
      try {
        await verifyAccessToken(accessTokenPlain)
      } catch (err) {
        console.error('[payments/config POST] token validation error:', err)
        return bad('Could not validate the access token with Mercado Pago.')
      }
    }

    const shared: Record<string, unknown> = {
      enabled,
      mp_public_key: mpPublicKey,
    }
    if (rawAccessToken) shared.mp_access_token = encrypt(accessTokenPlain)
    if (rawWebhookSecret) shared.mp_webhook_secret = encrypt(rawWebhookSecret)

    if (existing) {
      const { error: upErr } = await supabase
        .from('payment_configs')
        .update(shared)
        .eq('account_id', accountId)
      if (upErr) {
        console.error('[payments/config POST] update error:', upErr)
        return NextResponse.json({ error: 'Failed to save payment configuration' }, { status: 500 })
      }
    } else {
      const { error: insErr } = await supabase.from('payment_configs').insert({
        account_id: accountId,
        created_by: userId,
        mp_access_token: encrypt(accessTokenPlain),
        mp_webhook_secret: encrypt(rawWebhookSecret),
        ...shared,
      })
      if (insErr) {
        console.error('[payments/config POST] insert error:', insErr)
        return NextResponse.json({ error: 'Failed to save payment configuration' }, { status: 500 })
      }
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/payments/config  (admin+)
 *
 * Removes the account's payment config — turns Checkout off and
 * forgets the credentials. Also used to recover from a corrupted
 * encrypted secret.
 */
export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { error } = await supabase.from('payment_configs').delete().eq('account_id', accountId)
    if (error) {
      console.error('[payments/config DELETE] error:', error)
      return NextResponse.json({ error: 'Failed to delete payment configuration' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
