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

/**
 * Fetch the last N text (+ location, + transcribed audio) messages of
 * a conversation and map them to the provider-neutral chat shape.
 * Customer messages become `user`; agent and bot messages become
 * `assistant`. Other non-text message types (images, documents,
 * templates, interactive) are still excluded — they carry no text to
 * the model.
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
    .map((m) => ({
      role: m.sender_type === 'customer' ? 'user' : 'assistant',
      content:
        m.content_type === 'location' ? formatLocationMessage(m.content_text!.trim()) : m.content_text!.trim(),
    }))
}
