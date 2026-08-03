// ============================================================
// POST /api/v1/delivery/calculate  (scope: delivery:read)
//
// Delivery-fee calculation for automations like N8N. The tenant comes
// from the API key (`ctx.accountId`), never from the request body —
// same convention as every other /api/v1 route (see requireApiKey in
// src/lib/auth/api-context.ts) — a deliberate deviation from the
// product spec's example body (which showed a `tenantId` field): this
// project's public API always resolves the account from the bearer
// key, not from caller-supplied identifiers.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, badRequest, toApiErrorResponse } from '@/lib/api/v1/respond';
import { calculateDeliveryFeeForAccount } from '@/lib/delivery/fee-engine';

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'delivery:read');

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') throw badRequest('Invalid request body');

    const address = typeof body.address === 'string' ? body.address : undefined;
    const neighborhoodName = typeof body.neighborhood_name === 'string' ? body.neighborhood_name : undefined;
    const subtotal = typeof body.subtotal === 'number' && Number.isFinite(body.subtotal) ? body.subtotal : 0;

    const result = await calculateDeliveryFeeForAccount(ctx.supabase, ctx.accountId, {
      address,
      neighborhoodName,
      subtotal,
    });

    return ok(result);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
