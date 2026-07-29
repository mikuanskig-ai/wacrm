import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { connectSession } from '@/lib/whatsapp/wuzapi-api'

/**
 * POST /api/whatsapp/wuzapi/connect
 *
 * Starts (or resumes) the WhatsApp session for the account's WuzAPI
 * connection. Call this once after /provision succeeds, then poll
 * GET /qr (to render the pairing code) and GET /status (to detect a
 * successful scan) from the client.
 */
export async function POST() {
  try {
    const ctx = await requireRole('admin')

    const { data: config, error } = await ctx.supabase
      .from('whatsapp_config')
      .select('wuzapi_base_url, wuzapi_token, channel_type')
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (error || !config || config.channel_type !== 'wuzapi') {
      return NextResponse.json(
        { error: 'No WuzAPI connection configured for this account.' },
        { status: 400 },
      )
    }

    try {
      await connectSession({
        baseUrl: config.wuzapi_base_url,
        token: decrypt(config.wuzapi_token),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown WuzAPI error'
      // WuzAPI treats "connect while already connected" as an error,
      // but for us it's the goal state already achieved (e.g. the
      // session survived a WuzAPI container restart) — the client
      // polls /status next regardless, so just let it observe that.
      if (!/already connected/i.test(message)) {
        console.error('[wuzapi/connect] connect failed:', message)
        return NextResponse.json({ error: `WuzAPI connect failed: ${message}` }, { status: 502 })
      }
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
