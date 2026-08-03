import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { findOrCreateContact, ContactError } from '@/lib/api/v1/contacts';
import {
  finalizeDeliveryOrder,
  type CartLineItem,
} from '@/lib/delivery/create-order';

// POST /api/delivery/orders  (agent+)
//
// The one write path for Delivery orders that goes through a server
// route instead of direct-from-client Supabase calls (see plan §3) —
// it needs a server-side place to dispatch the `order.created`
// webhook and, for a brand-new customer, to run findOrCreateContact.
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(`delivery-order-create:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const items = Array.isArray(body.items) ? (body.items as CartLineItem[]) : [];
    if (items.length === 0) {
      return NextResponse.json({ error: 'items is required and must be non-empty' }, { status: 400 });
    }
    for (const item of items) {
      if (!item.product_id || !item.product_name || typeof item.unit_price !== 'number' || !item.quantity) {
        return NextResponse.json({ error: 'Each item needs product_id, product_name, unit_price, quantity' }, { status: 400 });
      }
    }

    let contactId: string | null = typeof body.contact_id === 'string' ? body.contact_id : null;

    if (!contactId && body.new_contact) {
      const { name, phone } = body.new_contact;
      if (typeof phone !== 'string' || !phone.trim()) {
        return NextResponse.json({ error: 'new_contact.phone is required' }, { status: 400 });
      }
      try {
        const result = await findOrCreateContact(supabase, accountId, userId, {
          phone,
          name: typeof name === 'string' ? name : null,
        });
        contactId = result.id;
      } catch (err) {
        if (err instanceof ContactError) {
          return NextResponse.json({ error: err.message }, { status: err.status });
        }
        throw err;
      }
    }

    if (!contactId) {
      return NextResponse.json({ error: 'contact_id or new_contact is required' }, { status: 400 });
    }

    const { data: accountRow } = await supabase
      .from('accounts')
      .select('default_currency')
      .eq('id', accountId)
      .maybeSingle();

    const order = await finalizeDeliveryOrder(supabase, {
      accountId,
      contactId,
      userId,
      source: 'manual',
      cart: items,
      deliveryFee: typeof body.delivery_fee === 'number' ? body.delivery_fee : null,
      deliveryAddress: typeof body.delivery_address === 'string' ? body.delivery_address : null,
      notes: typeof body.notes === 'string' ? body.notes : null,
      currency: accountRow?.default_currency ?? 'USD',
    });

    return NextResponse.json({ order }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
