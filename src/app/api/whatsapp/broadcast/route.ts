import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createCampaign, BroadcastError } from '@/lib/whatsapp/broadcast-core'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import type { CampaignSegment } from '@/types'

/**
 * Create a campaign from the dashboard wizard. Sending itself is
 * handled asynchronously by the `/cron` route (scheduled + paced) —
 * this just persists the campaign + resolves its audience.
 *
 * Body:
 *   {
 *     name?: string,
 *     message_variants: string[],       // 1-3, one picked at random per recipient
 *     media_url?: string,
 *     delay_seconds?: number,           // default 30
 *     scheduled_at?: string | null,     // ISO; omitted/null = send now
 *     segment: { type: 'all' } | { type: 'tags', tag_ids: string[] }
 *   }
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const limit = checkRateLimit(`broadcast:${user.id}`, RATE_LIMITS.broadcast)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const body = await request.json()
    const {
      name,
      message_variants,
      media_url,
      delay_seconds,
      scheduled_at,
      segment,
    } = body as {
      name?: string
      message_variants?: string[]
      media_url?: string
      delay_seconds?: number
      scheduled_at?: string | null
      segment?: CampaignSegment
    }

    if (!segment || (segment.type !== 'all' && segment.type !== 'tags')) {
      return NextResponse.json(
        { error: "`segment` must be { type: 'all' } or { type: 'tags', tag_ids: [...] }" },
        { status: 400 }
      )
    }

    const result = await createCampaign(supabase, accountId, user.id, {
      name,
      messageVariants: message_variants ?? [],
      mediaUrl: media_url ?? null,
      delaySeconds: delay_seconds ?? 30,
      scheduledAt: scheduled_at ?? null,
      segment,
    })

    return NextResponse.json({
      success: true,
      broadcast_id: result.broadcastId,
      total_recipients: result.totalRecipients,
      rejected: result.rejected,
    })
  } catch (error) {
    if (error instanceof BroadcastError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    console.error('Error in WhatsApp broadcast POST:', error)
    return NextResponse.json(
      { error: 'Failed to create campaign' },
      { status: 500 }
    )
  }
}
