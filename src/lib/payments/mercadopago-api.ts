/**
 * Mercado Pago REST helpers — Zontalk Delivery Fase 4 (Checkout).
 *
 * Thin wrapper, same shape as src/lib/whatsapp/wuzapi-api.ts: named-args
 * per function, no SDK dependency. The API is a plain Bearer-token REST
 * API, not worth pulling in the `mercadopago` npm package for two
 * endpoints.
 *
 * Docs: https://www.mercadopago.com.br/developers/en/reference
 */

const MP_API_BASE = 'https://api.mercadopago.com'

interface MpErrorEnvelope {
  message?: string
  error?: string
}

async function mpRequest<T>(args: {
  path: string
  method?: string
  accessToken: string
  body?: unknown
}): Promise<T> {
  const { path, method = 'GET', accessToken, body } = args
  const response = await fetch(`${MP_API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  let json: unknown
  try {
    json = await response.json()
  } catch {
    json = null
  }

  if (!response.ok) {
    const message =
      (json as MpErrorEnvelope | null)?.message ||
      (json as MpErrorEnvelope | null)?.error ||
      `Mercado Pago error: ${response.status}`
    throw new Error(message)
  }

  return json as T
}

export interface CreatePreferenceItem {
  title: string
  quantity: number
  unit_price: number
}

export interface CreatePreferenceArgs {
  accessToken: string
  /** Correlation key read back on the webhook — never trust any other field for this. */
  orderId: string
  items: CreatePreferenceItem[]
  /** ISO 4217 currency code, e.g. 'BRL'. */
  currency: string
  notificationUrl: string
}

export interface CreatePreferenceResult {
  preferenceId: string
  initPoint: string
}

interface MpPreferenceResponse {
  id: string
  init_point: string
}

export async function createPreference(
  args: CreatePreferenceArgs,
): Promise<CreatePreferenceResult> {
  const { accessToken, orderId, items, currency, notificationUrl } = args
  const data = await mpRequest<MpPreferenceResponse>({
    path: '/checkout/preferences',
    method: 'POST',
    accessToken,
    body: {
      items: items.map((item) => ({
        title: item.title,
        quantity: item.quantity,
        unit_price: item.unit_price,
        currency_id: currency,
      })),
      external_reference: orderId,
      notification_url: notificationUrl,
      auto_return: 'approved',
    },
  })
  return { preferenceId: data.id, initPoint: data.init_point }
}

export interface GetPaymentArgs {
  accessToken: string
  paymentId: string
}

export interface GetPaymentResult {
  id: string
  /** MP's own vocabulary: pending/approved/rejected/refunded/cancelled/... */
  status: string
  externalReference: string | null
  transactionAmount: number
}

interface MpPaymentResponse {
  id: number | string
  status: string
  external_reference: string | null
  transaction_amount: number
}

/**
 * Cheap read used only to validate a newly-entered access token before
 * persisting it — same "verify before save" discipline as the AI and
 * WhatsApp config forms (validateAiCredentials / Meta registration
 * check). Throws if the token is invalid/expired.
 */
export async function verifyAccessToken(accessToken: string): Promise<void> {
  await mpRequest<{ id: number }>({ path: '/users/me', accessToken })
}

/**
 * Fetches the authoritative payment record from MP's own API. The
 * webhook body only ever says "something changed" — never trust its
 * fields for status/amount, always re-fetch with the account's token.
 */
export async function getPayment(args: GetPaymentArgs): Promise<GetPaymentResult> {
  const { accessToken, paymentId } = args
  const data = await mpRequest<MpPaymentResponse>({
    path: `/v1/payments/${paymentId}`,
    accessToken,
  })
  return {
    id: String(data.id),
    status: data.status,
    externalReference: data.external_reference,
    transactionAmount: data.transaction_amount,
  }
}
