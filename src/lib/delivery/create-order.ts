// ============================================================
// Delivery order creation — shared by the manual "/api/delivery/orders"
// route and the `order_summary` Flow node (src/lib/flows/engine.ts).
//
// Lives outside both engines (flows vs automations) rather than inside
// either one, matching the precedent noted for `create_deal`
// (automations/engine.ts:551) — there's no shared helper module
// between the two engines today, so a neutral module here is better
// than duplicating the insert logic in both places.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { getPaymentConfigSecrets } from '@/lib/payments/config';
import { createPreference } from '@/lib/payments/mercadopago-api';
import { sendMessageToConversation } from '@/lib/whatsapp/send-message';
import { formatCurrency } from '@/lib/currency';
import { enqueuePrintJob } from '@/lib/delivery/print-queue';

export interface CartLineItemAddon {
  group_id: string;
  group_name: string;
  option_id: string;
  option_name: string;
  price_delta: number;
}

export interface CartLineItem {
  product_id: string;
  product_name: string;
  unit_price: number;
  quantity: number;
  addons: CartLineItemAddon[];
  notes?: string | null;
  /** ISO timestamp of the last time this exact line was added/merged —
   *  see addToCartTool's re-add guard (tools/delivery.ts). Optional so
   *  older in-flight carts written before this field existed still
   *  deserialize fine. */
  addedAt?: string;
}

export interface CartTotal {
  subtotal: number;
}

/** A cart line older than this never merges by sum in `add_to_cart`
 *  (tools/delivery.ts's exact-match guard), and is what the sweep cron
 *  (`/api/delivery/cart-sweep/cron`) treats as an abandoned session
 *  worth clearing outright. Lives here rather than in tools/delivery.ts
 *  so both consumers share one definition of "stale" instead of
 *  drifting apart. Confirmed live (2026-08-28, Ezequiel — a near-daily
 *  "marmita média pro meio-dia" regular): a line left over from a
 *  previous day's abandoned session (place_order never called, so
 *  ai_cart never reset) silently absorbed a brand-new request into
 *  itself — 1 + 1 = 2. Missing `addedAt` (legacy data written before
 *  this field existed) counts as stale too — there's no way to know
 *  its real age, and treating "unknown" as safe-to-merge is exactly
 *  what let that incident through. 6 hours comfortably covers any
 *  single real order session (including slow back-and-forth) while
 *  safely catching "this is a different day's order." */
export const STALE_CART_LINE_MS = 6 * 60 * 60 * 1000;

export function isStaleCartLine(line: CartLineItem, nowIso: string): boolean {
  if (!line.addedAt) return true;
  return new Date(nowIso).getTime() - new Date(line.addedAt).getTime() > STALE_CART_LINE_MS;
}

/** True when EVERY line in a non-empty cart is stale — i.e. nothing in
 *  it has been touched inside the staleness window, so the whole
 *  session reads as abandoned rather than "an order in progress that
 *  happens to have one older line." A single fresh line is enough to
 *  keep the whole cart alive; only clear when nothing recent anchors
 *  it to a real, ongoing conversation. */
export function isCartAbandoned(cart: CartLineItem[], nowIso: string): boolean {
  if (cart.length === 0) return false;
  return cart.every((line) => isStaleCartLine(line, nowIso));
}

/**
 * Pure — sums (unit_price + sum of addon price_deltas) * quantity across
 * every cart line. Rounded to cents so float drift never lands a
 * fractional-cent value in a NUMERIC(12,2) column.
 */
export function computeCartTotal(cart: CartLineItem[]): CartTotal {
  const subtotal = cart.reduce((sum, item) => {
    // `?? []` — defensive against a cart line persisted before addons
    // existed on this shape, or any other write path that omitted the
    // key. Confirmed live (2026-08-06): a bare `item.addons.reduce`
    // here crashed the whole tool-loop mid `place_order` with
    // "Cannot read properties of undefined (reading 'reduce')",
    // handing the conversation off to a human with no order ever
    // created — so no fee/total shown and nothing to print.
    const addonsTotal = (item.addons ?? []).reduce((s, a) => s + a.price_delta, 0);
    return sum + (item.unit_price + addonsTotal) * item.quantity;
  }, 0);
  return { subtotal: Math.round(subtotal * 100) / 100 };
}

/** Same reasoning as auto-reply.ts's formatOrderConfirmation: a
 *  deterministic template, never model-generated, so a real checkout
 *  link is never garbled or dropped by an LLM paraphrase. */
function formatPaymentLinkMessage(checkoutUrl: string, total: number, currency: string): string {
  return [
    `Seu pedido está pronto para pagamento: ${formatCurrency(total, currency)}.`,
    `Pague com Pix ou cartão neste link: ${checkoutUrl}`,
  ].join('\n');
}

function mercadoPagoNotificationUrl(accountId: string): string {
  const origin = process.env.NEXT_PUBLIC_SITE_URL?.trim() || 'http://localhost:3000';
  return `${origin.replace(/\/+$/, '')}/api/payments/mercadopago/webhook/${accountId}`;
}

export interface FinalizeDeliveryOrderArgs {
  accountId: string;
  contactId?: string | null;
  conversationId?: string | null;
  userId?: string | null;
  flowRunId?: string | null;
  source: 'manual' | 'whatsapp_flow' | 'ai_chat' | 'public_web';
  cart: CartLineItem[];
  deliveryFee?: number | null;
  customerName?: string | null;
  deliveryAddress?: string | null;
  notes?: string | null;
  currency: string;
  paymentMethod?: string | null;
  paymentNotes?: string | null;
}

/**
 * Inserts the order + its line items, dispatches `order.created`, and
 * returns the created row. Not wrapped in a DB transaction (Supabase
 * client doesn't expose multi-statement transactions) — if the items
 * insert fails after the order insert succeeds, the order is left in
 * `confirmed` with zero items rather than rolled back; acceptable for
 * Fase 1 (no payment is captured at this point) and visible/fixable
 * from the Pedidos list.
 *
 * Starts life as `confirmed`, not `pending_confirmation` — the kitchen
 * ticket (`enqueuePrintJob` below) already fires unconditionally on
 * every new order regardless of status, so an extra "needs
 * confirmation" step before the order even shows as confirmed on the
 * Pedidos list was pure friction: the print already happened, there
 * was nothing left to confirm. `pending_confirmation` stays a valid
 * status (existing orders, the DB CHECK, STATUS_FLOW) — it just isn't
 * where a NEW order starts anymore.
 */
export async function finalizeDeliveryOrder(
  db: SupabaseClient,
  args: FinalizeDeliveryOrderArgs,
) {
  const { subtotal } = computeCartTotal(args.cart);
  const deliveryFee = args.deliveryFee ?? null;
  const total = subtotal + (deliveryFee ?? 0);

  const { data: order, error: orderErr } = await db
    .from('delivery_orders')
    .insert({
      account_id: args.accountId,
      contact_id: args.contactId ?? null,
      conversation_id: args.conversationId ?? null,
      user_id: args.userId ?? null,
      flow_run_id: args.flowRunId ?? null,
      status: 'confirmed',
      source: args.source,
      customer_name: args.customerName ?? null,
      delivery_address: args.deliveryAddress ?? null,
      notes: args.notes ?? null,
      payment_method: args.paymentMethod ?? null,
      payment_notes: args.paymentNotes ?? null,
      subtotal,
      delivery_fee: deliveryFee,
      total,
      currency: args.currency,
    })
    .select()
    .single();

  if (orderErr || !order) {
    throw new Error(`Failed to create delivery order: ${orderErr?.message}`);
  }

  const itemRows = args.cart.map((item) => {
    const addonsTotal = (item.addons ?? []).reduce((s, a) => s + a.price_delta, 0);
    return {
      account_id: args.accountId,
      order_id: order.id,
      product_id: item.product_id,
      product_name: item.product_name,
      unit_price: item.unit_price,
      quantity: item.quantity,
      addons_snapshot: item.addons ?? [],
      line_total: (item.unit_price + addonsTotal) * item.quantity,
      notes: item.notes ?? null,
    };
  });

  if (itemRows.length > 0) {
    const { error: itemsErr } = await db.from('delivery_order_items').insert(itemRows);
    if (itemsErr) {
      throw new Error(`Failed to create delivery order items: ${itemsErr.message}`);
    }
  }

  // Fase 4 (Checkout): open a Mercado Pago preference when the account
  // has payment enabled. Never blocks the sale — any failure here
  // (invalid token, MP outage, unsupported currency) just leaves
  // payment_status NULL and the order proceeds exactly as before.
  const paymentConfig = await getPaymentConfigSecrets(db, args.accountId);
  if (paymentConfig?.enabled) {
    try {
      const { preferenceId, initPoint } = await createPreference({
        accessToken: paymentConfig.mpAccessToken,
        orderId: order.id,
        items: itemRows.length > 0
          ? itemRows.map((item) => ({
              title: item.product_name,
              quantity: item.quantity,
              unit_price: item.unit_price,
            }))
          : [{ title: 'Pedido', quantity: 1, unit_price: total }],
        currency: order.currency,
        notificationUrl: mercadoPagoNotificationUrl(args.accountId),
      });

      const { data: updated } = await db
        .from('delivery_orders')
        .update({
          payment_status: 'pending_payment',
          mp_preference_id: preferenceId,
          checkout_url: initPoint,
        })
        .eq('id', order.id)
        .select()
        .single();

      if (updated) Object.assign(order, updated);

      if (order.conversation_id) {
        try {
          await sendMessageToConversation(db, args.accountId, {
            conversationId: order.conversation_id,
            messageType: 'text',
            contentText: formatPaymentLinkMessage(initPoint, order.total, order.currency),
          });
        } catch (sendErr) {
          console.error('[delivery] failed to send payment link message:', sendErr);
        }
      }
    } catch (mpErr) {
      console.error('[delivery] failed to create Mercado Pago preference:', mpErr);
    }
  }

  await enqueuePrintJob(args.accountId, order.id);

  await dispatchWebhookEvent(db, args.accountId, 'order.created', {
    order_id: order.id,
    status: order.status,
    source: order.source,
    total: order.total,
    currency: order.currency,
    contact_id: order.contact_id,
    payment_status: order.payment_status,
  });

  await runAutomationsForTrigger({
    accountId: args.accountId,
    triggerType: 'order_created',
    contactId: order.contact_id,
    context: {
      vars: {
        order_id: order.id,
        order_total: order.total,
        order_currency: order.currency,
        order_customer_name: order.customer_name,
        order_status: order.status,
        order_payment_status: order.payment_status,
        order_checkout_url: order.checkout_url,
      },
    },
  });

  return order;
}
