import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { dispatchDueCampaigns } from '@/lib/whatsapp/broadcast-core'

/**
 * Drain due campaign sends: for every campaign whose scheduled_at has
 * been reached and whose own delay_seconds has elapsed since its last
 * send, send the next pending recipient. Runs a bounded internal loop
 * (rather than sending exactly one message per invocation) so a short
 * delay_seconds (e.g. 15s) is paced accurately even though the
 * external pinger only needs to hit this once a minute — the loop
 * itself is what enforces per-campaign pacing, the external schedule
 * is just a resume-if-the-process-died safety net.
 *
 * Auth: same `AUTOMATION_CRON_SECRET` as the flows/automations cron
 * endpoints — one secret for operators to provision, independent URLs
 * so one sweep failing doesn't block another.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Just under a minute so a once-a-minute external ping never
  // overlaps two runs of this loop.
  const { sent } = await dispatchDueCampaigns(supabaseAdmin(), 50_000)

  return NextResponse.json({ sent })
}
