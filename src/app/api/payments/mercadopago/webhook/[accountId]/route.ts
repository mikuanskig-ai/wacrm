import { NextResponse, after } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getPaymentConfigSecrets } from '@/lib/payments/config'
import { getPayment } from '@/lib/payments/mercadopago-api'
import { verifyMercadoPagoWebhookSignature } from '@/lib/payments/webhook-signature'
import { supabaseAdmin } from '@/lib/payments/admin-client'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { formatCurrency } from '@/lib/currency'
import type { DeliveryPaymentStatus } from '@/types'

// Mirrors src/app/api/whatsapp/webhook/route.ts's shape: ack fast,
// do the real work in after() so a slow MP API round-trip never risks
// missing MP's own delivery timeout.
export const maxDuration = 30

type Params = { params: Promise<{ accountId: string }> }

// Maps Mercado Pago's own `payment.status` vocabulary onto ours
// (migration 046) — 1:1 except 'pending'/'in_process' both collapse
// to 'pending_payment', and 'charged_back' is treated as a refund.
const MP_STATUS_MAP: Record<string, DeliveryPaymentStatus> = {
  pending: 'pending_payment',
  in_process: 'pending_payment',
  approved: 'approved',
  rejected: 'rejected',
  refunded: 'refunded',
  charged_back: 'refunded',
  cancelled: 'cancelled',
}

/**
 * POST /api/payments/mercadopago/webhook/[accountId]
 *
 * Mercado Pago doesn't identify the account anywhere in the payload —
 * the only way to know which account's credentials/secret to verify
 * against is the accountId embedded in the notification_url we gave MP
 * when creating the preference (see create-order.ts's
 * mercadoPagoNotificationUrl). Never trust the webhook body's own
 * fields for status/amount — always re-fetch the authoritative record
 * via getPayment() with that account's access token.
 */
export async function POST(request: Request, { params }: Params) {
  const { accountId } = await params
  const rawBody = await request.text()
  const url = new URL(request.url)

  let parsedBody: { data?: { id?: string } } = {}
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : {}
  } catch {
    parsedBody = {}
  }

  const dataId =
    url.searchParams.get('data.id') || url.searchParams.get('id') || parsedBody?.data?.id || null

  const db = supabaseAdmin()
  const config = await getPaymentConfigSecrets(db, accountId)
  if (!config) {
    // No payment_configs row for this account — nothing to verify
    // against or act on. 200 (not 404) so this is indistinguishable
    // from "verified but no-op" to anyone probing account ids.
    return NextResponse.json({ status: 'ignored' }, { status: 200 })
  }

  const verified = verifyMercadoPagoWebhookSignature({
    xSignature: request.headers.get('x-signature'),
    xRequestId: request.headers.get('x-request-id'),
    dataId,
    secret: config.mpWebhookSecret,
  })
  if (!verified) {
    console.warn(`[mercadopago-webhook] rejected request with invalid signature for account ${accountId}`)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  after(async () => {
    try {
      await processPaymentNotification(db, accountId, config.mpAccessToken, dataId!)
    } catch (err) {
      console.error('[mercadopago-webhook] processing error:', err)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processPaymentNotification(
  db: SupabaseClient,
  accountId: string,
  accessToken: string,
  paymentId: string,
) {
  const payment = await getPayment({ accessToken, paymentId })
  if (!payment.externalReference) {
    console.warn(`[mercadopago-webhook] payment ${paymentId} has no external_reference — skipping`)
    return
  }

  const { data: order, error: findErr } = await db
    .from('delivery_orders')
    .select('id, account_id, contact_id, conversation_id, payment_status, total, currency')
    .eq('id', payment.externalReference)
    .maybeSingle()

  if (findErr || !order) {
    console.warn(`[mercadopago-webhook] order ${payment.externalReference} not found`)
    return
  }
  // Defense in depth: the order must belong to the same account whose
  // token/secret this request was just verified against.
  if (order.account_id !== accountId) {
    console.warn(
      `[mercadopago-webhook] order ${order.id} belongs to a different account than the webhook URL (${accountId}) — rejecting`,
    )
    return
  }

  const paymentStatus = MP_STATUS_MAP[payment.status] ?? null
  if (!paymentStatus || order.payment_status === paymentStatus) return

  const { data: updated, error: updateErr } = await db
    .from('delivery_orders')
    .update({ payment_status: paymentStatus, mp_payment_id: payment.id })
    .eq('id', order.id)
    .select()
    .single()
  if (updateErr || !updated) {
    console.error('[mercadopago-webhook] failed to update order:', updateErr)
    return
  }

  await dispatchWebhookEvent(db, accountId, 'order.payment_updated', {
    order_id: updated.id,
    previous_payment_status: order.payment_status,
    payment_status: updated.payment_status,
  })

  await runAutomationsForTrigger({
    accountId,
    triggerType: 'order_payment_status_changed',
    contactId: updated.contact_id,
    context: {
      payment_status: updated.payment_status,
      vars: {
        order_id: updated.id,
        order_payment_status: updated.payment_status,
        order_previous_payment_status: order.payment_status,
        order_total: updated.total,
        order_currency: updated.currency,
      },
    },
  })

  // Deterministic template, never model-generated — same reasoning as
  // auto-reply.ts's formatOrderConfirmation: a customer whose payment
  // was approved must never be left without a confirmation message.
  if (paymentStatus === 'approved' && updated.conversation_id) {
    try {
      await sendMessageToConversation(db, accountId, {
        conversationId: updated.conversation_id,
        messageType: 'text',
        contentText: `Pagamento de ${formatCurrency(updated.total, updated.currency)} confirmado! Seu pedido já está sendo preparado.`,
      })
    } catch (err) {
      console.error('[mercadopago-webhook] failed to send payment confirmation message:', err)
    }
  }
}
