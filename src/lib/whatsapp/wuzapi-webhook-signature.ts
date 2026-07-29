import crypto from 'node:crypto'

/**
 * Verify the HMAC-SHA256 signature WuzAPI attaches to webhook POSTs.
 *
 * Unlike Meta (one app-wide `META_APP_SECRET`), WuzAPI signs with a
 * key configured PER CONNECTION via `POST /session/hmac/config` at
 * provisioning time (see wuzapi-api.ts `configureHmacKey`) — every
 * wuzapi "user" (= one whatsapp_config row) has its own key, stored
 * encrypted as `whatsapp_config.wuzapi_hmac_key`. The caller looks up
 * the config row first (by `wuzapi_token_hash`, see the wuzapi
 * webhook route), decrypts that row's key, and passes it in here —
 * this function has no env-var fallback and fails closed on a missing
 * key, same posture as verifyMetaWebhookSignature.
 *
 * Reference: github.com/asternic/wuzapi API.md § HMAC Configuration.
 * The signed data is the raw JSON request body; the header is
 * `x-hmac-signature` carrying the raw hex digest (no `sha256=` prefix,
 * unlike Meta's `x-hub-signature-256`).
 */
export function verifyWuzapiWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  hmacKey: string | null | undefined,
): boolean {
  if (!hmacKey) {
    console.error(
      '[wuzapi-webhook] no HMAC key configured for this connection — rejecting request.',
    )
    return false
  }
  if (!signatureHeader) return false

  const expected = crypto
    .createHmac('sha256', hmacKey)
    .update(rawBody)
    .digest('hex')

  const a = Buffer.from(signatureHeader.trim().toLowerCase())
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
