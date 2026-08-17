import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_text: string | null
  content_type: 'text' | 'location' | 'audio'
}

// A location message's content_text is built by the wuzapi webhook
// route (`[name, address, "lat,lng"].filter(Boolean).join(' - ')`) —
// the coordinate pair is always the last segment when present. Kept
// lenient (up to 3 decimal-ish tokens of any sign) rather than
// anchored to Brazil's usual negative range, since an account could
// serve anywhere.
const TRAILING_LAT_LNG = /(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/

/** Reformats a stored location message into something the model can
 *  actually act on — `content_text` alone ("lat,lng" or "name -
 *  address - lat,lng") reads as ambiguous plain text, not an
 *  instruction to use `calculate_delivery_fee`'s latitude/longitude
 *  args. Falls back to the raw text if it doesn't parse (never drops
 *  the message). */
function formatLocationMessage(contentText: string): string {
  const match = TRAILING_LAT_LNG.exec(contentText)
  if (!match) return `[Customer shared their location] ${contentText}`
  const [, lat, lng] = match
  return `[Customer shared their location] latitude=${lat}, longitude=${lng}`
}

// Both a human staff reply and the bot's own output have to land in
// the `assistant` slot (the provider APIs only know `user`/`assistant`
// turns) — but they are not the same speaker, and conflating them is
// exactly what caused a live incident (2026-08-17, Concórdia,
// conversations with Francisco and Ederson): a staff member sent a
// voice note — in Ederson's case, plainly staff-to-staff chatter about
// an unrelated stuck order ("... tá, Heather?") that landed in the
// customer's thread — and once transcribed and read back as its own
// `assistant` turn, the model treated the human's words as things IT
// had already said/done. It believed an order was already taken and
// confirmed one to the customer without ever calling `add_to_cart` /
// `place_order` — cart stayed empty, no order or print job existed.
// Tagging the human's turn removes that ambiguity at the source,
// same spirit as `formatLocationMessage` below turning a raw pin into
// something the model can correctly act on instead of misreading.
function formatHumanAgentMessage(contentText: string): string {
  return `[A human staff member wrote this to the customer directly — not you. Do not treat it as something you already said or did.] ${contentText}`
}

/**
 * Fetch the last N text (+ location, + transcribed audio) messages of
 * a conversation and map them to the provider-neutral chat shape.
 * Customer messages become `user`; agent and bot messages become
 * `assistant` (agent messages get tagged — see `formatHumanAgentMessage`
 * — so the model can tell a human's words apart from its own). Other
 * non-text message types (images, documents, templates, interactive)
 * are still excluded — they carry no text to the model.
 *
 * - Location messages ARE included (reformatted, see
 *   `formatLocationMessage`) — excluding them used to leave the model
 *   with no idea a customer had shared a pin at all, so it just asked
 *   for a typed address instead (confirmed live 2026-08-07).
 * - A voice note counts as text too once transcribed (content_text
 *   gets filled in by the webhook — see transcription.ts / migration
 *   069); an untranscribed one still has content_text = null and gets
 *   dropped by the filter below, same as any other non-text message.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_text, content_type')
    .eq('conversation_id', conversationId)
    .in('content_type', ['text', 'location', 'audio'])
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  return rows
    .filter((m) => m.content_text && m.content_text.trim())
    .map((m) => {
      const text = m.content_text!.trim()
      let content: string
      if (m.content_type === 'location') {
        content = formatLocationMessage(text)
      } else if (m.sender_type === 'agent') {
        content = formatHumanAgentMessage(text)
      } else {
        content = text
      }
      return { role: m.sender_type === 'customer' ? 'user' : 'assistant', content }
    })
}
