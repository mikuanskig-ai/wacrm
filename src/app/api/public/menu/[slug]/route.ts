// ============================================================
// GET /api/public/menu/[slug]
//
// Public — no auth required. Backs the /c/[slug] cardápio page.
//
// Security model
//   - No session, no RLS: reads through supabaseAdmin() (service
//     role), scoped manually to the account resolved from the slug.
//     Same structural shape as the Mercado Pago webhook route
//     (accountId from the URL + service-role client + its own gate —
//     there an HMAC signature, here a rate limit).
//   - Slug not found and slug-found-but-delivery-module-disabled both
//     return the exact same 404 body, so the response never signals
//     which case it was.
//   - Response is a fixed, hand-built shape — never a raw table row —
//     so no internal-only column (account_id, owner_user_id,
//     enabled_modules, inactive products) can leak by accident.
// ============================================================

import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/payments/admin-client';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { resolveAccountBySlug, loadPublicMenu } from '@/lib/delivery/public-menu';
import { getBusinessHours, isWithinBusinessHours, closedMessage } from '@/lib/delivery/business-hours';

function getClientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const xri = request.headers.get('x-real-ip');
  if (xri) return xri.trim();
  return 'unknown';
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const ip = getClientIp(request);
  const limit = checkRateLimit(`public-menu-read:${ip}`, RATE_LIMITS.publicMenuRead);
  if (!limit.success) return rateLimitResponse(limit);

  const { slug } = await params;
  const db = supabaseAdmin();

  const account = await resolveAccountBySlug(db, slug);
  if (!account) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const [{ categories, uncategorizedProducts }, businessHours] = await Promise.all([
    loadPublicMenu(db, account.id),
    getBusinessHours(db, account.id),
  ]);

  const open = !businessHours?.enabled || isWithinBusinessHours(businessHours.hours, businessHours.timezone);

  return NextResponse.json({
    account: { name: account.name, currency: account.currency },
    open,
    closed_message: open ? null : closedMessage(businessHours!.hours),
    categories,
    uncategorized_products: uncategorizedProducts,
  });
}
