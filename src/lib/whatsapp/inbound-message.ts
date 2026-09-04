// ============================================================
// Shared inbound-message processing — contact/conversation
// find-or-create, message persistence, flow + automation + AI
// auto-reply dispatch, broadcast-reply flagging, reactions.
//
// `WhatsAppMessage` stays the shape originally modeled on Meta's wire
// format — the WuzAPI webhook route maps wuzapi's event payload INTO
// this same shape, plus a `precomputedContent` (WuzAPI delivers media
// as inline base64, already uploaded to storage by the time this is
// called — there's no Meta-style media-id-verify step to run here).
// ============================================================

import { createClient } from '@supabase/supabase-js'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { AI_VISIBLE_CONTENT_TYPES } from '@/lib/ai/context'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { autoAddContactsToPipelines } from '@/lib/pipelines/auto-add'

// Lazy-initialized to avoid build-time crash when env vars are missing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
export function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

export interface WhatsAppMessage {
  id: string
  from: string
  timestamp: string
  type: string
  text?: { body: string }
  image?: { id: string; mime_type: string; caption?: string }
  video?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string; filename?: string; caption?: string }
  audio?: { id: string; mime_type: string }
  sticker?: { id: string; mime_type: string }
  location?: { latitude: number; longitude: number; name?: string; address?: string }
  reaction?: { message_id: string; emoji: string }
  interactive?: {
    type: 'button_reply' | 'list_reply'
    button_reply?: { id: string; title: string }
    list_reply?: { id: string; title: string; description?: string }
  }
  context?: { id: string }
}

// The happy-path status ladder — pending → sent → delivered → read →
// replied. Webhook replays must never regress a recipient back down
// this ladder.
const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s)
  return idx < 0 ? -1 : idx
}

/**
 * Can a recipient transition from `current` to `incoming`?
 *   - Along the ladder, only forward moves are allowed.
 *   - `failed` is accepted only from `pending` or `sent`; refused once
 *     the recipient has reached any success state.
 */
export function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent'
  }
  if (current === 'failed') {
    return false // failed is terminal
  }
  const ci = ladderLevel(current)
  const ii = ladderLevel(incoming)
  if (ii < 0) return false
  if (ci < 0) return true
  return ii > ci
}

/**
 * Should this inbound message trigger the AI auto-reply pipeline at
 * all? Pulled out as its own pure function — regression, 2026-09-04
 * (Concórdia, Alzira Y. de Oliveira): a payment-receipt PDF has real,
 * non-blank `inboundText` (a document's `contentText` falls back to
 * its filename), so this used to fire a full AI dispatch anyway — but
 * `buildConversationContext` silently drops any `document`/`image`/
 * `video`/etc. message, so the model got invoked seeing nothing new at
 * all and improvised: it cancelled and recreated a perfectly good,
 * already-paid order, generating a spurious cancellation ticket for
 * the kitchen. Two independently-reasonable checks — "does this
 * message have text" (here) and "can the model see this message"
 * (`AI_VISIBLE_CONTENT_TYPES`, context.ts) — silently disagreed on the
 * one case that matters. Gating on the same set here closes that gap
 * for good, for every currently-excluded content type, not just
 * documents.
 */
export function shouldDispatchAiReply(args: {
  flowConsumed: boolean
  interactiveReplyId: string | null
  inboundText: string
  contentType: string
}): boolean {
  return (
    !args.flowConsumed &&
    !args.interactiveReplyId &&
    args.inboundText.trim().length > 0 &&
    AI_VISIBLE_CONTENT_TYPES.has(args.contentType)
  )
}

export async function handleStatusUpdate(status: {
  id: string
  status: string
  timestamp: string
  recipient_id: string
}) {
  const { error: msgErr } = await supabaseAdmin()
    .from('messages')
    .update({ status: status.status })
    .eq('message_id', status.id)

  if (msgErr) {
    console.error('Error updating message status:', msgErr)
  }

  const tsIso = new Date(parseInt(status.timestamp) * 1000).toISOString()

  const { data: recipient, error: recFetchErr } = await supabaseAdmin()
    .from('broadcast_recipients')
    .select('id, status')
    .eq('whatsapp_message_id', status.id)
    .maybeSingle()

  if (recFetchErr) {
    console.error('Error fetching broadcast recipient:', recFetchErr)
  } else if (
    recipient &&
    isValidStatusTransition(recipient.status, status.status)
  ) {
    const update: Record<string, unknown> = { status: status.status }
    if (status.status === 'sent' && !('sent_at' in update)) update.sent_at = tsIso
    if (status.status === 'delivered') update.delivered_at = tsIso
    if (status.status === 'read') update.read_at = tsIso

    const { error: recUpdateErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update(update)
      .eq('id', recipient.id)

    if (recUpdateErr) {
      console.error('Error updating broadcast recipient status:', recUpdateErr)
    }
  }

  const { data: msgRow } = await supabaseAdmin()
    .from('messages')
    .select('conversation_id, conversations(account_id)')
    .eq('message_id', status.id)
    .limit(1)
    .maybeSingle()

  if (msgRow) {
    const conv = msgRow.conversations as { account_id: string } | null
    const accountId = conv?.account_id
    if (accountId) {
      await dispatchWebhookEvent(
        supabaseAdmin(),
        accountId,
        'message.status_updated',
        {
          whatsapp_message_id: status.id,
          conversation_id: msgRow.conversation_id,
          status: status.status,
        }
      )
    }
  }
}

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast. Best-effort — failures here must
 * not break the main inbound-message flow.
 */
async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    const { data: recs, error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const row = recs[0]
    const { error: updErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id)

    if (updErr) {
      console.error('Error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err)
  }
}

/**
 * Resolve a provider-side message_id into the matching internal UUID,
 * scoped to one conversation. Returns null when we never received the
 * parent (e.g. a swipe-reply to a message older than this CRM install).
 */
async function lookupInternalIdByMetaId(
  metaId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', metaId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[inbound-message] lookupInternalIdByMetaId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

/**
 * Persist an inbound reaction. WhatsApp reactions are not new messages
 * — they're per-(target, actor) state, upserted/deleted on
 * `message_reactions`, never written into `messages`.
 */
async function handleReaction(
  message: WhatsAppMessage,
  conversationId: string,
  contactId: string
) {
  const reaction = message.reaction
  if (!reaction?.message_id) return

  const targetInternalId = await lookupInternalIdByMetaId(
    reaction.message_id,
    conversationId
  )
  if (!targetInternalId) {
    console.warn(
      '[inbound-message] reaction target message not found; skipping',
      reaction.message_id
    )
    return
  }

  if (!reaction.emoji) {
    const { error: delError } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)
    if (delError) {
      console.error('[inbound-message] reaction delete failed:', delError.message)
    }
    return
  }

  const { error: upsertError } = await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji: reaction.emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    )
  if (upsertError) {
    console.error('[inbound-message] reaction upsert failed:', upsertError.message)
  }
}

export interface ParsedContent {
  contentText: string | null
  mediaUrl: string | null
  mediaType: string | null
  interactiveReplyId: string | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  wasCreated: boolean
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  /**
   * `null` when no genuine display name is known (e.g. an IsFromMe
   * echo, or a WhatsApp event with no PushName) — callers must NOT
   * pass a phone-number placeholder here. The existing-contact branch
   * below treats any truthy `name` as "we really learned this," so a
   * placeholder would overwrite an already-known real name on the
   * next such event (confirmed live 2026-07-31). The phone-as-name
   * fallback still applies, but only once, on brand-new contact
   * INSERT, further down in this function.
   */
  name: string | null,
  /**
   * Lazy — only invoked when actually creating a new contact, so
   * existing contacts never pay for an extra WuzAPI round trip on
   * every inbound message. Meta callers simply don't pass this (Meta
   * Cloud API doesn't expose contact avatars the same way).
   */
  fetchAvatarUrl?: () => Promise<string | null>,
): Promise<ContactOutcome | null> {
  const existingContact = await findExistingContact(
    supabaseAdmin(),
    accountId,
    phone,
  )

  if (existingContact) {
    const updates: Record<string, unknown> = {}
    if (name && name !== existingContact.name) {
      updates.name = name
    }
    // Contacts created before avatar sync existed (this feature is
    // recent — see migration history), or whose fetch failed/was
    // hidden at the time, are stuck at avatar_url=null forever
    // otherwise. Opportunistically retry once per inbound message
    // from them until it succeeds — best-effort, since a WhatsApp
    // privacy setting can legitimately keep this null indefinitely,
    // which isn't an error worth logging.
    let avatarUrl = existingContact.avatar_url as string | null
    if (!avatarUrl && fetchAvatarUrl) {
      avatarUrl = await fetchAvatarUrl().catch(() => null)
      if (avatarUrl) updates.avatar_url = avatarUrl
    }
    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date().toISOString()
      await supabaseAdmin().from('contacts').update(updates).eq('id', existingContact.id)
    }
    return {
      contact: avatarUrl ? { ...existingContact, avatar_url: avatarUrl } : existingContact,
      wasCreated: false,
    }
  }

  const avatarUrl = fetchAvatarUrl ? await fetchAvatarUrl().catch(() => null) : null

  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
      avatar_url: avatarUrl,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  const { data: existingRows, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('Error finding conversation:', findError)
    return null
  }

  if (existingRows && existingRows.length > 0) {
    const existing = existingRows[0]

    // Mandatory rule: a closed ticket that gets a new message from the
    // same contact MUST always resurface in PENDENTES — never stay
    // closed (the agent would never see it) and never auto-open
    // (nobody actually started attending it yet). This is the same
    // "every new/reopened conversation starts unattended" invariant as
    // the CREATE branch below, just applied to the reuse path.
    if (existing.status === 'closed') {
      const { data: reopened, error: reopenError } = await supabaseAdmin()
        .from('conversations')
        .update({
          status: 'pending',
          closed_at: null,
          closed_by: null,
          close_reason: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select()
        .single()

      if (reopenError || !reopened) {
        // Must never silently leave the ticket closed — log loudly and
        // fall back to a locally-patched row so the rest of
        // processMessage (unread bump, bucket placement) still treats
        // it as pending even if the UPDATE round-trip failed.
        console.error(
          '[inbound-message] failed to reopen closed conversation to pending:',
          reopenError
        )
        return {
          conversation: { ...existing, status: 'pending', closed_at: null, closed_by: null, close_reason: null },
          created: false,
        }
      }

      return { conversation: reopened, created: false }
    }

    return { conversation: existing, created: false }
  }

  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
      // Belt-and-suspenders with the column DEFAULT (039_ticket_flow.sql):
      // every new ticket starts unattended until a human or the bot
      // explicitly "starts attendance" — never auto-open.
      status: 'pending',
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const { data: raced } = await supabaseAdmin()
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error('Error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}

export async function processMessage(
  message: WhatsAppMessage,
  contact: { profile: { name: string | null }; wa_id: string },
  accountId: string,
  configOwnerUserId: string,
  /**
   * Content already resolved by the caller — WuzAPI delivers media as
   * inline base64 (already uploaded to storage by the time this is
   * called), so there's no Meta-style media-id-verify step to run
   * here anymore.
   */
  precomputedContent: ParsedContent,
  /** WuzAPI-only — see `findOrCreateContact`'s matching parameter. */
  fetchAvatarUrl?: () => Promise<string | null>,
) {
  const senderPhone = normalizePhone(message.from)
  const contactName = contact.profile.name

  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    senderPhone,
    contactName,
    fetchAvatarUrl,
  )
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  if (contactOutcome.wasCreated) {
    await autoAddContactsToPipelines(supabaseAdmin(), accountId, configOwnerUserId, [
      { id: contactRecord.id, name: contactRecord.name, phone: contactRecord.phone },
    ])
  }

  const convResult = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id
  )
  if (!convResult) return
  const conversation = convResult.conversation

  if (convResult.created) {
    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    })
  }

  if (message.type === 'reaction') {
    await handleReaction(message, conversation.id, contactRecord.id)
    return
  }

  const { contentText, mediaUrl, mediaType, interactiveReplyId } = precomputedContent

  let replyToInternalId: string | null = null
  if (message.context?.id) {
    replyToInternalId = await lookupInternalIdByMetaId(
      message.context.id,
      conversation.id
    )
    if (!replyToInternalId) {
      console.warn(
        '[inbound-message] reply context parent not found:',
        message.context.id
      )
    }
  }

  void mediaType

  const ALLOWED_CONTENT_TYPES = new Set([
    'text', 'image', 'document', 'audio', 'video',
    'location', 'template', 'interactive',
  ])
  const contentType = ALLOWED_CONTENT_TYPES.has(message.type)
    ? message.type
    : message.type === 'sticker'
      ? 'image'
      : 'text'

  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: contentType,
    content_text: contentText,
    media_url: mediaUrl,
    message_id: message.id,
    status: 'delivered',
    created_at: new Date(parseInt(message.timestamp) * 1000).toISOString(),
    reply_to_message_id: replyToInternalId,
    interactive_reply_id: interactiveReplyId,
  })

  if (msgError) {
    console.error('Error inserting message:', msgError)
    return
  }

  const { error: convError } = await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: contentText || `[${message.type}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  if (convError) {
    console.error('Error updating conversation:', convError)
  }

  await flagBroadcastReplyIfAny(accountId, contactRecord.id)

  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message:
      interactiveReplyId
        ? {
            kind: 'interactive_reply',
            reply_id: interactiveReplyId,
            reply_title: contentText ?? '',
            meta_message_id: message.id,
          }
        : {
            kind: 'text',
            text: contentText ?? message.text?.body ?? '',
            meta_message_id: message.id,
          },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  const inboundText = contentText ?? message.text?.body ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
  )[] = []
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
  }
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  if (shouldDispatchAiReply({ flowConsumed, interactiveReplyId, inboundText, contentType })) {
    // Assigns this inbound message a monotonic per-conversation
    // sequence number — dispatchInboundToAiReply uses it to detect a
    // newer message arriving during its debounce/generation window and
    // stand down, so a rapid burst of customer messages gets ONE reply
    // instead of one duplicate-ish reply per message (see auto-reply.ts).
    const { data: inboundSeq, error: seqError } = await supabaseAdmin().rpc(
      'bump_ai_inbound_seq',
      { conversation_id: conversation.id },
    )
    if (seqError) {
      console.error('[inbound-message] bump_ai_inbound_seq failed:', seqError.message)
    } else {
      await dispatchInboundToAiReply({
        accountId,
        conversationId: conversation.id,
        contactId: contactRecord.id,
        configOwnerUserId,
        inboundMessageId: message.id,
        inboundSeq: inboundSeq as number,
      })
    }
  }

  await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: message.id,
    content_type: contentType,
    text: contentText,
  })
}

/**
 * Threads a message the agent sent directly from their own paired
 * phone (a WuzAPI `IsFromMe` echo) into the same conversation history
 * as a normal agent-sent message, instead of the previous behaviour
 * of silently dropping it. `message.from` must already be the
 * COUNTERPARTY's phone — the wuzapi webhook route resolves that from
 * `Info.RecipientAlt`/`Info.Chat` before calling this, since
 * Sender/SenderAlt point at our own account on these events.
 *
 * Unlike `processMessage`, this never dispatches to flows/automations/
 * AI auto-reply (there's no customer trigger here) — it only pauses
 * an active flow run, mirroring the "agent stepped in" behaviour of a
 * dashboard send in `send-message.ts`.
 */
export async function processOutboundEchoMessage(
  message: WhatsAppMessage,
  contact: { profile: { name: string | null }; wa_id: string },
  accountId: string,
  configOwnerUserId: string,
  precomputedContent: ParsedContent,
  fetchAvatarUrl?: () => Promise<string | null>,
) {
  const contactPhone = normalizePhone(message.from)
  const contactName = contact.profile.name

  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    contactPhone,
    contactName,
    fetchAvatarUrl,
  )
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  if (contactOutcome.wasCreated) {
    await autoAddContactsToPipelines(supabaseAdmin(), accountId, configOwnerUserId, [
      { id: contactRecord.id, name: contactRecord.name, phone: contactRecord.phone },
    ])
  }

  const convResult = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id
  )
  if (!convResult) return
  const conversation = convResult.conversation

  if (convResult.created) {
    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    })
  }

  const { contentText, mediaUrl } = precomputedContent

  const ALLOWED_CONTENT_TYPES = new Set([
    'text', 'image', 'document', 'audio', 'video', 'location',
  ])
  const contentType = ALLOWED_CONTENT_TYPES.has(message.type) ? message.type : 'text'

  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'agent',
    content_type: contentType,
    content_text: contentText,
    media_url: mediaUrl,
    message_id: message.id,
    status: 'sent',
    created_at: new Date(parseInt(message.timestamp) * 1000).toISOString(),
  })

  if (msgError) {
    console.error('[inbound-message] error inserting outbound-echo message:', msgError)
    return
  }

  const { error: convError } = await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: contentText || `[${message.type}]`,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  if (convError) {
    console.error('[inbound-message] error updating conversation (outbound echo):', convError)
  }

  // Same "human stepped in" signal as a dashboard send — yield any
  // active bot flow so it doesn't talk over the agent.
  const { error: pauseErr } = await supabaseAdmin()
    .from('flow_runs')
    .update({
      status: 'paused_by_agent',
      ended_at: new Date().toISOString(),
      end_reason: 'agent_replied',
    })
    .eq('account_id', accountId)
    .eq('contact_id', contactRecord.id)
    .eq('status', 'active')

  if (pauseErr) {
    console.error('[flows] pause-on-agent-send (outbound echo) failed:', pauseErr.message)
  }
}
