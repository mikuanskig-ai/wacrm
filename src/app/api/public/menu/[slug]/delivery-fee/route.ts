// ============================================================
// POST /api/public/menu/[slug]/delivery-fee
//
// Public — no auth required. Live delivery-fee preview for the
// cardápio checkout (cart-drawer.tsx), fired as the customer edits
// the address field. This is a preview only — `order/route.ts`
// recomputes the fee again server-side right before creating the
// order, exactly like it already re-validates business hours, so
// nothing here needs to be trusted downstream.
// ============================================================

import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/payments/admin-client';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { resolveAccountBySlug } from '@/lib/delivery/public-menu';
import { calculateDeliveryFeeForAccount } from '@/lib/delivery/fee-engine';

function getClientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const xri = request.headers.get('x-real-ip');
  if (xri) return xri.trim();
  return 'unknown';
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const ip = getClientIp(request);
  const limit = checkRateLimit(`public-menu-delivery-fee:${ip}`, RATE_LIMITS.publicMenuCalculate);
  if (!limit.success) return rateLimitResponse(limit);

  const { slug } = await params;
  const db = supabaseAdmin();

  const account = await resolveAccountBySlug(db, slug);
  if (!account) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const address = typeof body.address === 'string' ? body.address : undefined;
  const subtotal = typeof body.subtotal === 'number' && Number.isFinite(body.subtotal) ? body.subtotal : 0;

  const result = await calculateDeliveryFeeForAccount(db, account.id, { address, subtotal });
  return NextResponse.json(result);
}
