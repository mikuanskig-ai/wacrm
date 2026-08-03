// ============================================================
// POST /api/public/menu/[slug]/order
//
// Public — no auth required. Completes a checkout started on the
// /c/[slug] cardápio page.
//
// Security model (mirrors the public GET route + the AI tool-calling
// path in src/lib/ai/tools/delivery.ts):
//   - No session, no RLS: supabaseAdmin() scoped by the account
//     resolved from the slug.
//   - The client sends only product_id/addon_option_ids/quantity —
//     NEVER a price. Every price is reloaded from the DB here and the
//     cart is rebuilt server-side, exactly like `addToCartTool`
//     ("never trust an id or a price coming from the caller").
//   - Business hours are re-checked here even though the page already
//     disables the checkout button when closed — the button is UX
//     only, this is the real gate (same split as pricing).
//   - Slug/module-disabled 404s with the identical body the GET route
//     uses.
// ============================================================

import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/payments/admin-client';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { resolveAccountBySlug, loadPublicMenu, type PublicMenuProduct } from '@/lib/delivery/public-menu';
import { getBusinessHours, isWithinBusinessHours, closedMessage } from '@/lib/delivery/business-hours';
import {
  finalizeDeliveryOrder,
  computeCartTotal,
  type CartLineItem,
  type CartLineItemAddon,
} from '@/lib/delivery/create-order';
import { calculateDeliveryFeeForAccount } from '@/lib/delivery/fee-engine';

function getClientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const xri = request.headers.get('x-real-ip');
  if (xri) return xri.trim();
  return 'unknown';
}

interface RequestedItem {
  product_id: string;
  quantity: number;
  addon_option_ids: string[];
  notes: string | null;
}

function parseItems(raw: unknown): RequestedItem[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const items: RequestedItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null;
    const productId = (entry as Record<string, unknown>).product_id;
    if (typeof productId !== 'string' || !productId) return null;
    const rawQuantity = (entry as Record<string, unknown>).quantity;
    const quantity = Math.max(1, Math.min(20, Math.trunc(Number(rawQuantity)) || 1));
    const rawAddonIds = (entry as Record<string, unknown>).addon_option_ids;
    const addonOptionIds = Array.isArray(rawAddonIds)
      ? rawAddonIds.filter((v): v is string => typeof v === 'string')
      : [];
    const notes = (entry as Record<string, unknown>).notes;
    items.push({
      product_id: productId,
      quantity,
      addon_option_ids: addonOptionIds,
      notes: typeof notes === 'string' ? notes : null,
    });
  }
  return items;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const ip = getClientIp(request);
  const limit = checkRateLimit(`public-menu-order:${ip}`, RATE_LIMITS.publicMenuOrder);
  if (!limit.success) return rateLimitResponse(limit);

  const { slug } = await params;
  const db = supabaseAdmin();

  const account = await resolveAccountBySlug(db, slug);
  if (!account) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const businessHours = await getBusinessHours(db, account.id);
  if (businessHours?.enabled && !isWithinBusinessHours(businessHours.hours, businessHours.timezone)) {
    return NextResponse.json(
      { error: 'closed', message: closedMessage(businessHours.hours) },
      { status: 409 },
    );
  }

  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const items = parseItems(body.items);
  if (!items) {
    return NextResponse.json({ error: 'items is required and must be non-empty' }, { status: 400 });
  }

  const { categories, uncategorizedProducts } = await loadPublicMenu(db, account.id);
  const products: PublicMenuProduct[] = [
    ...categories.flatMap((c) => c.products),
    ...uncategorizedProducts,
  ];
  const productById = new Map(products.map((p) => [p.id, p]));

  const cart: CartLineItem[] = [];
  for (const item of items) {
    const product = productById.get(item.product_id);
    if (!product) {
      return NextResponse.json({ error: `Unknown or inactive product_id: ${item.product_id}` }, { status: 400 });
    }

    const allOptions = product.addon_groups.flatMap((g) =>
      g.options.map((o) => ({ ...o, group_id: g.id, group_name: g.name })),
    );
    const addons: CartLineItemAddon[] = item.addon_option_ids
      .map((id) => allOptions.find((o) => o.id === id))
      .filter((o): o is (typeof allOptions)[number] => !!o)
      .map((o) => ({
        group_id: o.group_id,
        group_name: o.group_name,
        option_id: o.id,
        option_name: o.name,
        price_delta: o.price_delta,
      }));

    cart.push({
      product_id: product.id,
      product_name: product.name,
      unit_price: product.price,
      quantity: item.quantity,
      addons,
      notes: item.notes,
    });
  }

  const customerName = typeof body.customer_name === 'string' && body.customer_name.trim()
    ? body.customer_name.trim()
    : null;
  const customerPhone = typeof body.customer_phone === 'string' && body.customer_phone.trim()
    ? body.customer_phone.trim()
    : null;
  const deliveryAddress = typeof body.delivery_address === 'string' && body.delivery_address.trim()
    ? body.delivery_address.trim()
    : null;
  const orderNotes = typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null;
  // No dedicated phone column on delivery_orders — fold it into notes
  // so staff still see it on the order (matching contacts unresolved
  // by design here, see plan's "fora de escopo").
  const notes = customerPhone
    ? [`Telefone: ${customerPhone}`, orderNotes].filter(Boolean).join('\n')
    : orderNotes;

  // Never trust a fee the client showed earlier (same "never trust a
  // price coming from the caller" principle as the cart above) — the
  // delivery fee is always recomputed here, right before the order is
  // created.
  const { subtotal } = computeCartTotal(cart);
  const feeResult = await calculateDeliveryFeeForAccount(db, account.id, {
    address: deliveryAddress,
    subtotal,
  });
  if (!feeResult.ok) {
    return NextResponse.json({ error: 'delivery_fee_unavailable', reason: feeResult.reason }, { status: 422 });
  }

  const order = await finalizeDeliveryOrder(db, {
    accountId: account.id,
    source: 'public_web',
    cart,
    customerName,
    deliveryAddress,
    deliveryFee: feeResult.fee,
    notes,
    currency: account.currency,
  });

  return NextResponse.json(
    {
      order_id: order.id,
      total: order.total,
      delivery_fee: order.delivery_fee,
      currency: order.currency,
      checkout_url: order.checkout_url ?? null,
    },
    { status: 201 },
  );
}
