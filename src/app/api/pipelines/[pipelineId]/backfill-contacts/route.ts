import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { backfillContactsToStage } from '@/lib/pipelines/auto-add'

type Params = { params: Promise<{ pipelineId: string }> }

/**
 * POST /api/pipelines/[pipelineId]/backfill-contacts  (admin)
 *
 * One-off "add existing contacts now" action from Pipeline Settings —
 * the complement to the `auto_add_contacts` toggle, which only covers
 * contacts created *after* it's turned on. Body: { stage_id }. Takes
 * the stage straight from the request rather than reading the
 * pipeline's persisted `auto_add_stage_id`, so it works even if the
 * admin picked a stage but hasn't hit Save yet.
 *
 * Same admin-only bar as pipelines_update RLS (creating deals in bulk
 * across the whole account's contact list is a settings-tier action,
 * not an everyday agent one).
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`pipeline-backfill:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { pipelineId } = await params
    const body = await request.json().catch(() => null)
    const stageId = typeof body?.stage_id === 'string' ? body.stage_id : null
    if (!stageId) {
      return NextResponse.json({ error: 'stage_id is required' }, { status: 400 })
    }

    const [{ data: pipeline, error: pipeErr }, { data: stage, error: stageErr }] =
      await Promise.all([
        supabase
          .from('pipelines')
          .select('id')
          .eq('id', pipelineId)
          .eq('account_id', accountId)
          .maybeSingle(),
        supabase
          .from('pipeline_stages')
          .select('id')
          .eq('id', stageId)
          .eq('pipeline_id', pipelineId)
          .maybeSingle(),
      ])
    if (pipeErr || stageErr) {
      console.error('[pipelines/backfill-contacts] lookup error:', pipeErr ?? stageErr)
      return NextResponse.json({ error: 'Failed to load pipeline' }, { status: 500 })
    }
    if (!pipeline) {
      return NextResponse.json({ error: 'Pipeline not found' }, { status: 404 })
    }
    if (!stage) {
      return NextResponse.json({ error: 'Stage not found on this pipeline' }, { status: 404 })
    }

    const { data: contacts, error: contactsErr } = await supabase
      .from('contacts')
      .select('id, name, phone')
      .eq('account_id', accountId)
    if (contactsErr) {
      console.error('[pipelines/backfill-contacts] contacts fetch error:', contactsErr)
      return NextResponse.json({ error: 'Failed to load contacts' }, { status: 500 })
    }

    const added = await backfillContactsToStage(
      supabase,
      accountId,
      userId,
      pipelineId,
      stageId,
      contacts ?? [],
    )

    return NextResponse.json({
      success: true,
      added,
      total: (contacts ?? []).length,
      alreadyInPipeline: (contacts ?? []).length - added,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
