import { NextResponse } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getSessionStatus } from '@/lib/whatsapp/wuzapi-api'

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
 * GET /api/whatsapp/wuzapi/status
 *
 * Proxies WuzAPI's /session/status. Meant to be polled by the settings
 * UI while `qr_pending` — once `LoggedIn` flips true, this also
 * flips `whatsapp_config.status` to 'connected' (mirrors the Meta
 * config route's behaviour) so the rest of the app (which reads
 * `status`, not a live WuzAPI probe) sees the connection as live too.
 */
export async function GET() {
  try {
    const ctx = await getCurrentAccount()

    const { data: config, error } = await ctx.supabase
      .from('whatsapp_config')
      .select('id, wuzapi_base_url, wuzapi_token, channel_type, status')
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (error || !config || config.channel_type !== 'wuzapi') {
      return NextResponse.json(
        { error: 'No WuzAPI connection configured for this account.' },
        { status: 400 },
      )
    }

    let statusResult
    try {
      statusResult = await getSessionStatus({
        baseUrl: config.wuzapi_base_url,
        token: decrypt(config.wuzapi_token),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown WuzAPI error'
      return NextResponse.json({ connected: false, logged_in: false, message })
    }

    if (statusResult.loggedIn && config.status !== 'connected') {
      // Service-role write — the caller's RLS-scoped client can UPDATE
      // its own account's row fine too, but using the admin client
      // here matches the pattern the webhook route uses for the same
      // "background state sync" reason: this is a system-observed
      // fact, not a user edit.
      await supabaseAdmin()
        .from('whatsapp_config')
        .update({ status: 'connected', connected_at: new Date().toISOString() })
        .eq('id', config.id)
    }

    return NextResponse.json({
      connected: statusResult.connected,
      logged_in: statusResult.loggedIn,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
