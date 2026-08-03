import crypto from 'node:crypto'

/**
 * Verify the HMAC-SHA256 signature Mercado Pago attaches to webhook
 * POSTs. Same fail-closed contract as
 * src/lib/whatsapp/webhook-signature.ts's verifyMetaWebhookSignature —
 * a missing secret rejects every request rather than falling open.
 *
 * MP sends two headers instead of signing the raw body directly:
 *   x-signature:   "ts=1704908010,v1=618c853452..."
 *   x-request-id:  a request id, folded into the signed manifest
 *
 * The signed string ("manifest") is NOT the raw body — it's built from
 * the `data.id` query param, the request id, and the timestamp:
 *   id:{dataId};request-id:{xRequestId};ts:{ts};
 * HMAC-SHA256 that with the account's webhook secret; compare to `v1`.
 *
 * Reference:
 *   https://www.mercadopago.com.br/developers/en/docs/your-integrations/notifications/webhooks
 */
export function verifyMercadoPagoWebhookSignature(args: {
  xSignature: string | null
  xRequestId: string | null
  dataId: string | null
  secret: string | null
}): boolean {
  const { xSignature, xRequestId, dataId, secret } = args

  if (!secret) {
    console.error(
      '[mercadopago-webhook] no webhook secret configured for this account — rejecting request.',
    )
    return false
  }
  if (!xSignature || !xRequestId || !dataId) return false

  const parts = new Map<string, string>()
  for (const entry of xSignature.split(',')) {
    const [key, value] = entry.split('=')
    if (key && value) parts.set(key.trim(), value.trim())
  }
  const ts = parts.get('ts')
  const v1 = parts.get('v1')
  if (!ts || !v1) return false

  const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex')

  const a = Buffer.from(v1)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
