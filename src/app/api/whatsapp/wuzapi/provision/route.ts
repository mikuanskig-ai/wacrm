import { NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'
import { provisionUser, configureHmacKey, setWebhook } from '@/lib/whatsapp/wuzapi-api'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

/**
 * Rewrite a browser-facing origin into one WuzAPI (running in its own
 * Docker container per docker-compose.wuzapi.yml) can actually dial
 * back to. `localhost`/`127.0.0.1` from the browser's PoV is the
 * *browser's* host — from inside another container it must be
 * `host.docker.internal` (Docker Desktop's DNS name for the host),
 * or the request never reaches ZonTalk's dev server. Only rewrites the
 * local-loopback case; a real production hostname (once this moves to
 * a VPS) passes through unchanged — WuzAPI will run alongside ZonTalk
 * there with a normal reachable URL.
 */
function toWuzapiReachableOrigin(origin: string): string {
  try {
    const url = new URL(origin)
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      url.hostname = 'host.docker.internal'
    }
    return url.origin
  } catch {
    return origin
  }
}

/**
 * POST /api/whatsapp/wuzapi/provision
 *
 * Creates (or re-creates) the WuzAPI-channel connection for the
 * caller's account.
 *
 * This is a multi-tenant SaaS, not a bring-your-own-server template:
 * the WuzAPI server + its admin token are OPERATOR infrastructure
 * (one server, configured once via WUZAPI_SERVER_URL /
 * WUZAPI_ADMIN_TOKEN env vars — set by whoever runs this ZonTalk
 * deployment, e.g. the reseller), never entered or seen by an end
 * customer. Each account gets its own isolated WuzAPI "user" —
 * generated token + HMAC key, provisioned here — so one account can
 * never see or send through another's WhatsApp connection, even
 * though they all share the same underlying WuzAPI server.
 *
 * Does NOT start the session — call /api/whatsapp/wuzapi/connect
 * next, then poll /qr and /status (the settings UI does this
 * automatically as one "Connect WhatsApp" click).
 */
export async function POST() {
  try {
    const ctx = await requireRole('admin')

    const serverUrl = (process.env.WUZAPI_SERVER_URL || '').trim().replace(/\/$/, '')
    const adminToken = (process.env.WUZAPI_ADMIN_TOKEN || '').trim()

    if (!serverUrl || !adminToken) {
      console.error(
        '[wuzapi/provision] WUZAPI_SERVER_URL / WUZAPI_ADMIN_TOKEN not configured on the server.',
      )
      return NextResponse.json(
        { error: 'WhatsApp (WuzAPI) is not configured on this server yet. Contact your administrator.' },
        { status: 503 },
      )
    }

    // Label shown in wuzapi's own admin list and in this app's
    // settings panel — the account name is unique-enough and
    // meaningful without asking the customer for anything.
    const instanceName = `zontalk-${ctx.account.name}-${ctx.accountId.slice(0, 8)}`

    const origin = process.env.NEXT_PUBLIC_SITE_URL?.trim() || 'http://localhost:3000'
    const webhookUrl = `${toWuzapiReachableOrigin(origin)}/api/whatsapp/webhook/wuzapi`

    const connectionToken = crypto.randomBytes(24).toString('hex')
    const hmacKey = crypto.randomBytes(16).toString('hex') // WuzAPI needs exactly 32 bytes for its AES-256 encryption of this key

    let wuzapiUserId: string
    try {
      const provisioned = await provisionUser({
        baseUrl: serverUrl,
        adminToken,
        name: instanceName,
        token: connectionToken,
        webhookUrl,
      })
      // WuzAPI's own internal user id — NOT the connection token. This
      // is what every inbound webhook payload identifies itself with
      // (`payload.userID`), confirmed against live traffic; there is
      // no token in the webhook body to hash-match against.
      wuzapiUserId = provisioned.id
      await configureHmacKey({ baseUrl: serverUrl, token: connectionToken, hmacKey })
      await setWebhook({ baseUrl: serverUrl, token: connectionToken, webhookUrl })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown WuzAPI error'
      console.error('[wuzapi/provision] setup failed:', message)
      return NextResponse.json(
        { error: `WuzAPI setup failed: ${message}` },
        { status: 400 },
      )
    }

    const tokenHash = crypto.createHash('sha256').update(connectionToken).digest('hex')

    const row = {
      account_id: ctx.accountId,
      user_id: ctx.userId,
      channel_type: 'wuzapi' as const,
      wuzapi_base_url: serverUrl,
      wuzapi_token: encrypt(connectionToken),
      wuzapi_token_hash: tokenHash,
      wuzapi_user_id: wuzapiUserId,
      wuzapi_hmac_key: encrypt(hmacKey),
      wuzapi_instance_name: instanceName,
      status: 'disconnected' as const,
      // Meta-only columns stay NULL — the CHECK constraint from
      // migration 037 only requires them when channel_type='meta'.
      phone_number_id: null,
      access_token: null,
      waba_id: null,
      verify_token: null,
      updated_at: new Date().toISOString(),
    }

    const { data: existing } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    const { error: writeError } = existing
      ? await supabaseAdmin().from('whatsapp_config').update(row).eq('account_id', ctx.accountId)
      : await supabaseAdmin().from('whatsapp_config').insert(row)

    if (writeError) {
      console.error('[wuzapi/provision] failed to persist config:', writeError)
      return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
