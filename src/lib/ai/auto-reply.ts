import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply, generateReplyWithTools } from './generate'
import { buildSystemPrompt } from './defaults'
import { buildHandoffSummary } from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { engineSendText } from '@/lib/flows/meta-send'
import { getAccountCurrency } from '@/lib/flows/engine'
import { getEnabledModules, hasModule } from '@/lib/accounts/modules'
import { getAvailableTools, type PlacedOrderPayload } from './tools/delivery'
import type { ToolContext } from './tools/types'
import { formatCurrency } from '@/lib/currency'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { sleep } from './debounce'
import type { AiUsage } from './types'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
  /** The inbound WhatsApp message's own id (`wamid`). Only used to
   *  de-duplicate tool-calling turns (`claim_ai_tool_turn`) — a
   *  redelivered webhook must not be able to place a second real order.
   *  The plain-text-only path doesn't need it. */
  inboundMessageId: string
  /** `conversations.ai_inbound_seq` value assigned to THIS inbound
   *  message (see `bump_ai_inbound_seq`, migration 066). Used by the
   *  debounce below to detect a newer customer message landing while
   *  this dispatch is waiting/generating, so only the last message in
   *  a rapid burst actually replies. */
  inboundSeq: number
}

/** How long a dispatch waits for the conversation to "settle" before
 *  generating a reply. Long enough to coalesce a customer's rapid
 *  back-to-back bubbles into one turn; short enough not to be a
 *  noticeable delay on a normal single message (this only delays the
 *  bot's own reply — it runs in the webhook's `after()`, off the
 *  critical path of the 200 ack). */
const AI_REPLY_DEBOUNCE_MS = 2000

/** Builds the deterministic (non-LLM) order-confirmation message. Kept
 *  as plain string formatting — not another provider round-trip — so a
 *  successful `place_order` can never leave a real order created with
 *  the customer never told (see generate.ts's `generateReplyWithTools`
 *  doc for why the loop itself refuses to phrase this one). Hardcoded
 *  PT-BR, same reasoning as `closedMessage()`/`deliveryFeeFailureMessage()`
 *  (business-hours.ts / flows/engine.ts) — a deterministic message sent
 *  straight to the end customer, not panel UI, so it isn't run through
 *  next-intl. */
function formatOrderConfirmation(order: PlacedOrderPayload): string {
  const lines = order.items.map(
    (item) => `${item.quantity}x ${item.product_name} — ${formatCurrency(item.line_total, order.currency)}`,
  )
  return [
    'Pedido recebido! 🎉',
    ...lines,
    ...(order.deliveryFee > 0 ? [`Taxa de entrega: ${formatCurrency(order.deliveryFee, order.currency)}`] : []),
    `Total: ${formatCurrency(order.total, order.currency)}`,
    'Em breve confirmamos o seu pedido.',
  ].join('\n')
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - the ticket is in the ABERTO bucket (status='open') — an agent is
 *     actively handling it and the AI must never talk over them. Every
 *     current write path that sets status='open' also stamps
 *     assigned_agent_id (see /api/conversations/[id]/attendance's
 *     'start' action, resolve-conversation.ts, /api/whatsapp/send), so
 *     the assigned-agent check below already covers this in practice —
 *     this is a second, explicit gate on the bucket rule itself so it
 *     holds even if a future write path ever set status='open' without
 *     an assignment.
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId, inboundMessageId, inboundSeq } = args

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return

    // Re-run on both sides of the debounce sleep below — state (a human
    // grabbing the ticket, the cap filling up, another dispatch handing
    // off) can change while this call is waiting or mid-generation.
    // `maxReplies` is hoisted out of the closure since TS can't retain
    // the `config` null-narrowing across a nested function boundary.
    const maxReplies = config.autoReplyMaxPerConversation
    async function loadEligibleConversation() {
      const { data: c, error } = await db
        .from('conversations')
        .select('status, assigned_agent_id, ai_autoreply_disabled, ai_reply_count, ai_inbound_seq')
        .eq('id', conversationId)
        .maybeSingle()
      if (error || !c) return null
      if (c.status === 'open') return null // ABERTO — an agent owns this thread
      if (c.assigned_agent_id) return null // a human owns this thread
      if (c.ai_autoreply_disabled) return null // handed off / turned off here
      // Cheap early-out; the authoritative cap check is the atomic claim
      // further down (this read can race a concurrent inbound).
      if (c.ai_reply_count >= maxReplies) return null
      return c
    }

    if (!(await loadEligibleConversation())) return

    // Let a burst of rapid customer messages settle into ONE reply
    // instead of one per message. Without this, two dispatches racing
    // the same conversation both read the same not-yet-answered
    // context and each independently generate an LLM reply — near-
    // duplicate texts, AND each send burns a reply-cap slot, so a
    // 2-message burst silently exhausts the cap (default 3) twice as
    // fast and the bot goes quiet on the customer's next real message
    // (confirmed live 2026-08-06). Re-check below: if a newer inbound
    // bumped `ai_inbound_seq` while we slept, that message's own
    // dispatch will see this one in its context — stand down here.
    await sleep(AI_REPLY_DEBOUNCE_MS)

    const conv = await loadEligibleConversation()
    if (!conv) return
    if (conv.ai_inbound_seq !== inboundSeq) return // superseded by a newer inbound

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(messages),
    )

    const modules = await getEnabledModules(db, accountId)
    const tools = getAvailableTools({
      accountHasDeliveryModule: hasModule({ enabled_modules: modules }, 'delivery'),
      toolsEnabled: config.toolsEnabled,
      allowSideEffects: true,
    })

    let text: string
    let handoff: boolean
    let usage: AiUsage | null
    let placedOrder: PlacedOrderPayload | undefined
    // Set when the provider call itself threw (rate limit, invalid key,
    // network/timeout) rather than the model producing a handoff/empty
    // reply — see the try/catch below. Distinct from `result.rateLimited`
    // (our own soft internal cap, which retries on the next inbound):
    // a thrown error means the account's key/provider is actually broken
    // right now, so silently retrying forever would leave the customer
    // with no reply and no human ever notified.
    let providerErrored = false

    if (tools.length > 0) {
      // Tools can create a real order — a redelivered webhook running
      // this dispatch twice for the same inbound message must not be
      // able to place it twice. Claim before doing any provider work;
      // an already-claimed message id means this is a retry, stand
      // down silently (same contract as every other gate above).
      const { data: claimedTurn, error: claimTurnErr } = await db.rpc('claim_ai_tool_turn', {
        conversation_id: conversationId,
        message_id: inboundMessageId,
      })
      if (claimTurnErr) {
        console.error('[ai auto-reply] claim_ai_tool_turn failed:', claimTurnErr)
        return
      }
      if (claimedTurn !== true) return

      const currency = await getAccountCurrency(db, accountId)
      const toolContext: ToolContext = {
        db,
        accountId,
        conversationId,
        contactId,
        currency,
        allowSideEffects: true,
      }
      const systemPrompt = buildSystemPrompt({
        userPrompt: config.systemPrompt,
        mode: 'auto_reply',
        knowledge,
        toolsActive: true,
      })
      try {
        const result = await generateReplyWithTools({
          config,
          systemPrompt,
          messages,
          tools,
          toolContext,
          rateLimit: { key: `ai-autoreply:${accountId}`, options: RATE_LIMITS.aiAutoReplyAccount },
        })
        if (result.rateLimited) {
          // Transient — try again on the next inbound message. Not a
          // handoff: the conversation shouldn't be sticky-disabled over a
          // rate-limit blip.
          console.warn(
            `[ai auto-reply] account ${accountId} hit the per-account rate limit mid tool-loop — skipping this inbound.`,
          )
          return
        }
        text = result.placedOrder ? formatOrderConfirmation(result.placedOrder) : result.text
        handoff = result.handoff
        usage = result.usage
        placedOrder = result.placedOrder
      } catch (err) {
        console.error('[ai auto-reply] provider call failed mid tool-loop, handing off to a human:', err)
        providerErrored = true
        text = ''
        handoff = true
        usage = null
      }
    } else {
      // Account-wide throttle on the shared BYO key. The per-conversation
      // cap bounds one thread; this bounds a burst across many threads (a
      // marketing blast landing 200 replies at once) so we never run the
      // owner's key past the provider's rate limit. Over the limit → skip
      // the auto-reply; the inbound still sits in the inbox for a human.
      const acctLimit = checkRateLimit(
        `ai-autoreply:${accountId}`,
        RATE_LIMITS.aiAutoReplyAccount,
      )
      if (!acctLimit.success) {
        console.warn(
          `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
        )
        return
      }

      const systemPrompt = buildSystemPrompt({
        userPrompt: config.systemPrompt,
        mode: 'auto_reply',
        knowledge,
      })
      try {
        const result = await generateReply({ config, systemPrompt, messages })
        text = result.text
        handoff = result.handoff
        usage = result.usage
      } catch (err) {
        console.error('[ai auto-reply] provider call failed, handing off to a human:', err)
        providerErrored = true
        text = ''
        handoff = true
        usage = null
      }
    }

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    // Final debounce check: generation itself can take a few seconds —
    // if a newer customer message landed on this conversation mid-call,
    // stand down instead of sending a now-stale reply (that later
    // message's own dispatch will build context that already includes
    // this one). Never skipped when a real order was just placed —
    // the customer must always be told, even if this reply is "late".
    if (!placedOrder) {
      const stillEligible = await loadEligibleConversation()
      if (!stillEligible || stillEligible.ai_inbound_seq !== inboundSeq) return
    }

    if (!placedOrder && (handoff || !text)) {
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and hand it to a human. We (a) pause the bot here
      // (sticky until re-enabled), (b) route the conversation to the
      // configured handoff agent — null leaves it in the shared queue —
      // and (c) leave a short internal note so whoever picks it up has
      // context. Assigning fires the `on_conversation_assigned` trigger,
      // which notifies the agent.
      const summary = buildHandoffSummary({
        messages,
        replyCount: conv.ai_reply_count ?? 0,
        reason: providerErrored ? 'provider_error' : undefined,
      })
      const update: Record<string, unknown> = {
        ai_autoreply_disabled: true,
        ai_handoff_summary: summary,
        // Don't resume a stale cart if this conversation gets
        // re-enabled for AI later — prices/availability may have
        // changed by then.
        ai_cart: '[]',
      }
      // Only set the assignee when a target is configured AND the thread
      // isn't already owned — never stomp an existing human assignment.
      if (config.handoffAgentId && !conv.assigned_agent_id) {
        update.assigned_agent_id = config.handoffAgentId
      }
      await db.from('conversations').update(update).eq('id', conversationId)
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) return // lost the per-conversation cap race

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
      aiGenerated: true,
    })
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}
