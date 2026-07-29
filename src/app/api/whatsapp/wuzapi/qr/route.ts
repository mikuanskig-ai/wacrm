import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getQrCode } from '@/lib/whatsapp/wuzapi-api'

/**
 * GET /api/whatsapp/wuzapi/qr
 *
 * Proxies WuzAPI's /session/qr. Meant to be polled every 2-3s by the
 * settings UI while pairing is in progress — WuzAPI only returns a
 * code once the session is connected and not yet logged in, so a
 * "no QR yet" response here is normal right after /connect and while
 * already logged in (nothing to scan).
 */
export async function GET() {
  try {
    const ctx = await getCurrentAccount()

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
      const qr = await getQrCode({
        baseUrl: config.wuzapi_base_url,
        token: decrypt(config.wuzapi_token),
      })
      return NextResponse.json({ qr_code: qr.QRCode || null })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown WuzAPI error'
      // Not an error state from the UI's PoV — this is the normal
      // "no code available right now" response while the poll loop
      // waits for the session to reach the right internal state.
      return NextResponse.json({ qr_code: null, message })
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}
