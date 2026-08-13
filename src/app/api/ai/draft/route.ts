import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadAiConfig } from '@/lib/ai/config'
import { buildConversationContext } from '@/lib/ai/context'
import { retrieveKnowledge } from '@/lib/ai/knowledge'
import { generateReply, generateReplyWithTools } from '@/lib/ai/generate'
import { buildSystemPrompt } from '@/lib/ai/defaults'
import { latestUserMessage } from '@/lib/ai/query'
import { logAiUsage } from '@/lib/ai/usage'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { AiError } from '@/lib/ai/types'
import { getAccountCurrency } from '@/lib/flows/engine'
import { getEnabledModules, hasModule } from '@/lib/accounts/modules'
import { getAvailableTools } from '@/lib/ai/tools/delivery'
import { buildOrderStateSummary } from '@/lib/ai/order-state'
import type { ToolContext } from '@/lib/ai/tools/types'

/**
 * POST /api/ai/draft  (agent+)
 *
 * Body: { conversation_id }
 * Returns: { draft } — a suggested reply for the agent to edit + send.
 *
 * Uses the account's configured provider/key (BYO). Read-only: it never
 * sends or stores anything, just hands text back to the composer.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const userLimit = checkRateLimit(`ai-draft:${userId}`, RATE_LIMITS.aiDraft)
    if (!userLimit.success) return rateLimitResponse(userLimit)
    // Also cap the whole team's draws on the shared BYO provider key.
    const accountLimit = checkRateLimit(
      `ai-draft-acct:${accountId}`,
      RATE_LIMITS.aiDraftAccount,
    )
    if (!accountLimit.success) return rateLimitResponse(accountLimit)

    const body = await request.json().catch(() => null)
    const conversationId =
      body && typeof body.conversation_id === 'string' ? body.conversation_id : ''
    if (!conversationId) {
      return NextResponse.json(
        { error: 'conversation_id is required' },
        { status: 400 },
      )
    }

    // RLS scopes the SSR client to the caller's account, so a missing
    // row means "not yours / not found" either way.
    const { data: conversation, error: convErr } = await supabase
      .from('conversations')
      .select('id, contact_id')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr) {
      console.error('[ai/draft] conversation lookup error:', convErr)
      return NextResponse.json({ error: 'Failed to load conversation' }, { status: 500 })
    }
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const config = await loadAiConfig(supabase, accountId).catch((err) => {
      // Decrypt failure — surface distinctly from "not configured".
      console.error('[ai/draft] loadAiConfig error:', err)
      throw new AiError('Stored API key could not be decrypted.', {
        code: 'key_decrypt_failed',
        status: 400,
      })
    })
    if (!config) {
      return NextResponse.json(
        {
          error: 'AI assistant is not set up. Enable it in Settings → AI Assistant.',
          code: 'ai_not_configured',
        },
        { status: 400 },
      )
    }

    const messages = await buildConversationContext(supabase, conversationId)
    // Nothing to draft from — a brand-new thread with no customer text
    // would otherwise produce a nonsensical reply-to-nothing.
    if (messages.length === 0) {
      return NextResponse.json(
        {
          error: 'No messages to draft from yet.',
          code: 'no_messages',
        },
        { status: 400 },
      )
    }

    // Ground the draft in the account's knowledge base (best-effort —
    // returns [] when there's no KB or retrieval fails).
    const knowledge = await retrieveKnowledge(
      supabase,
      accountId,
      config,
      latestUserMessage(messages),
    )

    const modules = await getEnabledModules(supabase, accountId)
    const tools = getAvailableTools({
      accountHasDeliveryModule: hasModule({ enabled_modules: modules }, 'delivery'),
      toolsEnabled: config.toolsEnabled,
      // Drafts are reviewed by an agent before anything is sent — only
      // read-only menu lookups are safe here, never a cart mutation or
      // a real order (getAvailableTools enforces this).
      allowSideEffects: false,
    })

    // Read-only here (draft never mutates) — but still surfaced so the
    // agent's draft reflects what the customer already told the bot
    // (name, address, a prior fee quote) instead of the model having to
    // re-derive it from the transcript. See order-state.ts.
    const currency = tools.length > 0 ? await getAccountCurrency(supabase, accountId) : null
    const orderState =
      tools.length > 0 ? await buildOrderStateSummary(supabase, conversationId, currency!) : null

    const { text: systemPrompt, cacheableText: cacheableSystemPrompt } = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'draft',
      knowledge,
      toolsActive: tools.length > 0,
      orderState,
    })

    let text: string
    let usage: Awaited<ReturnType<typeof generateReply>>['usage']
    if (tools.length > 0) {
      const toolContext: ToolContext = {
        db: supabase,
        accountId,
        conversationId,
        contactId: (conversation as { contact_id: string | null }).contact_id,
        currency: currency!,
        allowSideEffects: false,
      }
      const result = await generateReplyWithTools({
        config,
        systemPrompt,
        cacheableSystemPrompt,
        messages,
        tools,
        toolContext,
        rateLimit: { key: `ai-draft-acct:${accountId}`, options: RATE_LIMITS.aiDraftAccount },
      })
      if (result.rateLimited) {
        return rateLimitResponse(accountLimit)
      }
      text = result.text
      usage = result.usage
    } else {
      const result = await generateReply({ config, systemPrompt, cacheableSystemPrompt, messages })
      text = result.text
      usage = result.usage
    }

    // Record spend on the account's BYO key. Best-effort + via the
    // service role (the log has no `authenticated` INSERT policy). This
    // must not fail or delay the draft the agent is waiting on, so:
    //  - the whole thing is wrapped (constructing the admin client throws
    //    if the service-role key is unset — that must not 500 the draft);
    //  - it's fire-and-forget (`void`), not awaited, so the response
    //    isn't held for a DB round-trip.
    try {
      void logAiUsage(supabaseAdmin(), {
        accountId,
        conversationId,
        mode: 'draft',
        provider: config.provider,
        model: config.model,
        usage,
      })
    } catch (logErr) {
      console.error('[ai/draft] usage log skipped:', logErr)
    }

    return NextResponse.json({ draft: text })
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      )
    }
    return toErrorResponse(err)
  }
}
