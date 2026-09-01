import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { notifyOrderCancellation } from '@/lib/delivery/print-queue';
import type { DeliveryOrderStatus, DeliveryPaymentStatus } from '@/types';

const VALID_STATUSES: DeliveryOrderStatus[] = [
  'draft',
  'pending_confirmation',
  'confirmed',
  'in_production',
  'ready',
  'out_for_delivery',
  'delivered',
  'cancelled',
];

// Fase 4 (Checkout): lets an admin mark a cash/Pix-fora-do-app order as
// paid manually — independent of the Mercado Pago webhook, same
// vocabulary as the `payment_status` CHECK (migration 046).
const VALID_PAYMENT_STATUSES: DeliveryPaymentStatus[] = [
  'pending_payment',
  'approved',
  'rejected',
  'refunded',
  'cancelled',
];

type Params = { params: Promise<{ orderId: string }> };

// PATCH /api/delivery/orders/[orderId]  (agent+)  — status / payment_status
// change only. Edits to items/customer info aren't supported in Fase 1
// (an order is either right or gets cancelled and re-created). `status`
// (fulfillment) and `payment_status` are independent axes — either or
// both may be sent in one request.
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(`delivery-order-status:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { orderId } = await params;
    const body = await request.json().catch(() => null);

    const hasStatus = body && 'status' in body;
    const hasPaymentStatus = body && 'payment_status' in body;
    if (!hasStatus && !hasPaymentStatus) {
      return NextResponse.json({ error: 'status or payment_status is required' }, { status: 400 });
    }

    const status = body.status;
    if (hasStatus && (typeof status !== 'string' || !VALID_STATUSES.includes(status as DeliveryOrderStatus))) {
      return NextResponse.json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` }, { status: 400 });
    }

    const paymentStatus = body.payment_status;
    if (
      hasPaymentStatus &&
      (typeof paymentStatus !== 'string' || !VALID_PAYMENT_STATUSES.includes(paymentStatus as DeliveryPaymentStatus))
    ) {
      return NextResponse.json(
        { error: `payment_status must be one of: ${VALID_PAYMENT_STATUSES.join(', ')}` },
        { status: 400 },
      );
    }

    const { data: existing, error: findErr } = await supabase
      .from('delivery_orders')
      .select('id, status, payment_status')
      .eq('id', orderId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (findErr) {
      console.error('[api/delivery/orders/:id PATCH] lookup error:', findErr);
      return NextResponse.json({ error: 'Failed to load order' }, { status: 500 });
    }
    if (!existing) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    const statusChanged = hasStatus && existing.status !== status;
    const paymentStatusChanged = hasPaymentStatus && existing.payment_status !== paymentStatus;

    if (!statusChanged && !paymentStatusChanged) {
      return NextResponse.json({ order: existing });
    }

    const patch: Record<string, string> = {};
    if (statusChanged) {
      patch.status = status;
      // Fase 5 (Operação): separate from the generic updated_at (which
      // the payment-only branch below also touches) so the operations
      // board's "time in status" clock only moves on a real status change.
      patch.status_changed_at = new Date().toISOString();
    }
    if (paymentStatusChanged) patch.payment_status = paymentStatus;

    const { data: updated, error: updateErr } = await supabase
      .from('delivery_orders')
      .update(patch)
      .eq('id', orderId)
      .select()
      .single();
    if (updateErr || !updated) {
      console.error('[api/delivery/orders/:id PATCH] update error:', updateErr);
      return NextResponse.json({ error: 'Failed to update order' }, { status: 500 });
    }

    if (statusChanged) {
      // If a staff member is cancelling an order the kitchen already
      // has a printed ticket for, they need a corrected one — paper
      // already printed can't be recalled. See notifyOrderCancellation's
      // own doc (print-queue.ts).
      if (updated.status === 'cancelled') {
        await notifyOrderCancellation(accountId, updated.id);
      }

      await dispatchWebhookEvent(supabase, accountId, 'order.status_changed', {
        order_id: updated.id,
        previous_status: existing.status,
        status: updated.status,
      });

      await runAutomationsForTrigger({
        accountId,
        triggerType: 'order_status_changed',
        contactId: updated.contact_id,
        context: {
          order_status: updated.status,
          vars: {
            order_id: updated.id,
            order_status: updated.status,
            order_previous_status: existing.status,
            order_total: updated.total,
            order_currency: updated.currency,
          },
        },
      });
    }

    if (paymentStatusChanged) {
      await dispatchWebhookEvent(supabase, accountId, 'order.payment_updated', {
        order_id: updated.id,
        previous_payment_status: existing.payment_status,
        payment_status: updated.payment_status,
      });

      await runAutomationsForTrigger({
        accountId,
        triggerType: 'order_payment_status_changed',
        contactId: updated.contact_id,
        context: {
          payment_status: updated.payment_status,
          vars: {
            order_id: updated.id,
            order_payment_status: updated.payment_status,
            order_previous_payment_status: existing.payment_status,
            order_total: updated.total,
            order_currency: updated.currency,
          },
        },
      });
    }

    return NextResponse.json({ order: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
