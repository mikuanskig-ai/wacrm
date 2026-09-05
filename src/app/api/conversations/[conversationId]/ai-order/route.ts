import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { getAccountCurrency } from '@/lib/flows/engine';
import { finalizeDeliveryOrder, type CartLineItem } from '@/lib/delivery/create-order';
import { readCart, writeCart } from '@/lib/ai/tools/delivery';
import { readOrderInfo, writeOrderInfo } from '@/lib/ai/order-state';

type Params = { params: Promise<{ conversationId: string }> };

// GET/POST /api/conversations/[id]/ai-order  (agent+)
//
// The staff-side rescue path for exactly the failure class this
// project kept finding all through August 2026: the AI tool-calling
// path builds up a real cart (ai_cart) and order info (ai_order_info)
// turn by turn, but sometimes never calls place_order — a hallucinated
// "pedido confirmado" with nothing behind it (Francisco, Fernanda), a
// hard handoff mid-order, or any other reason the thread ends up
// paused with real, useful state sitting on the conversation and no
// order to show for it. Until now there was no way to turn that
// state into a real (printed) order except retyping everything into
// the from-scratch manual order form — this reads it back for review
// and, on confirm, runs it through the exact same finalizeDeliveryOrder
// place_order itself uses (source: 'manual', conversationId set — so
// it's still auditable as "rescued from an AI thread" via that link),
// which unconditionally enqueues a print job. Deliberately requires an
// explicit items array on confirm rather than trusting ai_cart blinds —
// this exists BECAUSE the AI's own cart-building has had real bugs
// (an item silently missing, a quantity silently doubled); the whole
// point is a human reviewing (and, in the UI, editing) what actually
// goes to the kitchen before it's committed and printed.
export async function GET(request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { conversationId } = await params;

    const { data: conv } = await supabase
      .from('conversations')
      .select('id, contact_id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (!conv) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });

    const [cart, orderInfo, currency] = await Promise.all([
      readCart(supabase, conversationId),
      readOrderInfo(supabase, conversationId),
      getAccountCurrency(supabase, accountId),
    ]);

    return NextResponse.json({ cart, orderInfo, currency });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');
    const { conversationId } = await params;

    const limit = checkRateLimit(`ai-order-confirm:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { data: conv } = await supabase
      .from('conversations')
      .select('id, contact_id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (!conv) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });

    const body = await request.json().catch(() => null);
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });

    const items = Array.isArray(body.items) ? (body.items as CartLineItem[]) : [];
    if (items.length === 0) {
      return NextResponse.json({ error: 'items is required and must be non-empty' }, { status: 400 });
    }
    for (const item of items) {
      if (!item.product_id || !item.product_name || typeof item.unit_price !== 'number' || !item.quantity) {
        return NextResponse.json(
          { error: 'Each item needs product_id, product_name, unit_price, quantity' },
          { status: 400 },
        );
      }
    }

    const isPickup = body.is_pickup === true;
    const deliveryAddress = !isPickup && typeof body.delivery_address === 'string' ? body.delivery_address : null;
    const deliveryFee = typeof body.delivery_fee === 'number' ? body.delivery_fee : 0;

    const currency = await getAccountCurrency(supabase, accountId);

    const order = await finalizeDeliveryOrder(supabase, {
      accountId,
      contactId: (conv as { contact_id: string | null }).contact_id,
      conversationId,
      userId,
      source: 'manual',
      cart: items,
      currency,
      deliveryAddress,
      deliveryFee,
      customerName: typeof body.customer_name === 'string' ? body.customer_name : null,
      notes: typeof body.notes === 'string' ? body.notes : null,
      paymentMethod: typeof body.payment_method === 'string' ? body.payment_method : null,
      paymentNotes: typeof body.payment_notes === 'string' ? body.payment_notes : null,
    });

    // Same cleanup place_order itself does after a successful order
    // (tools/delivery.ts) — clears the cart just committed and the fee
    // quote tied to it, records lastPlacedOrderId/-Total so the AI (if
    // this thread ever resumes) knows an order already exists here and
    // offers cancel_order instead of placing a second one.
    await writeCart(supabase, conversationId, []);
    const orderInfo = await readOrderInfo(supabase, conversationId);
    await writeOrderInfo(supabase, conversationId, {
      ...orderInfo,
      lastFeeQuote: null,
      lastPlacedOrderId: order.id,
      lastPlacedOrderTotal: order.total,
      lastPlacedOrderAt: new Date().toISOString(),
    });

    return NextResponse.json({ order }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
