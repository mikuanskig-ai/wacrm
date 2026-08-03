// ============================================================
// POST /api/v1/broadcasts — launch a WuzAPI campaign
// (scope: broadcasts:send).
//
// Body:
//   {
//     "name": "July promo",                    // optional label
//     "message_variants": ["Oi {{contato...}}"], // required, 1-3 — one
//                                                  // picked at random
//                                                  // per recipient
//     "media_url": "https://…/promo.jpg",       // optional
//     "delay_seconds": 30,                      // optional, default 30
//     "scheduled_at": "2026-08-01T12:00:00Z",   // optional; omitted = now
//     "recipients": [                           // required, 1..2000
//       { "to": "+14155550123", "name": "Jane" },
//       { "to": "+14155550124" }
//     ]
//   }
//
// The campaign + its recipient rows are persisted synchronously; the
// actual paced WuzAPI sends are drained by the `/cron` route (respects
// scheduled_at + delay_seconds). Poll `GET /api/v1/broadcasts/{id}`
// for progress.
//
// Response (202):
//   { "data": { "broadcast_id", "status", "total_recipients", "rejected" } }
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts';
import { createCampaign, BroadcastError } from '@/lib/whatsapp/broadcast-core';

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'broadcasts:send');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const messageVariants = Array.isArray(body.message_variants)
      ? (body.message_variants as unknown[]).filter((v): v is string => typeof v === 'string')
      : [];
    const recipients = Array.isArray(body.recipients) ? body.recipients : [];

    const auditUserId = await resolveAuditUserId(ctx.supabase, ctx.accountId);

    const result = await createCampaign(ctx.supabase, ctx.accountId, auditUserId, {
      name: typeof body.name === 'string' ? body.name : null,
      messageVariants,
      mediaUrl: typeof body.media_url === 'string' ? body.media_url : null,
      delaySeconds: typeof body.delay_seconds === 'number' ? body.delay_seconds : 30,
      scheduledAt: typeof body.scheduled_at === 'string' ? body.scheduled_at : null,
      recipients: (recipients as Array<Record<string, unknown>>).map((r) => ({
        to: typeof r?.to === 'string' ? r.to : '',
        name: typeof r?.name === 'string' ? r.name : undefined,
      })),
    });

    return ok(
      {
        broadcast_id: result.broadcastId,
        status: 'scheduled',
        total_recipients: result.totalRecipients,
        rejected: result.rejected,
      },
      202
    );
  } catch (err) {
    if (err instanceof BroadcastError) {
      return fail(err.code, err.message, err.status);
    }
    if (err instanceof ContactError) {
      return fail(
        err.status === 400 ? 'bad_request' : 'internal',
        err.message,
        err.status
      );
    }
    return toApiErrorResponse(err);
  }
}
