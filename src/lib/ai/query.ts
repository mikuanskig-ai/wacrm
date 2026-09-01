import type { ChatMessage } from './types'

/**
 * The text to retrieve knowledge against: the most recent customer
 * (`user`) turn in the conversation context. Falls back to the last
 * message of any role, then empty string. Shared by the draft route and
 * the auto-reply bot so both query the knowledge base the same way.
 */
export function latestUserMessage(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content
  }
  return messages.length > 0 ? messages[messages.length - 1].content : ''
}

/**
 * The actual text to retrieve knowledge against — `latestUserMessage`
 * plus the assistant's own immediately preceding message, when there
 * is one. A bare confirmation ("sim", "pode ser", "ok") carries no
 * topical signal by itself, so retrieval against it alone finds
 * nothing relevant even when the knowledge base has the exact answer
 * — but the assistant's own prior message (the thing being confirmed,
 * e.g. "quer que eu te passe os horários?") does carry that signal.
 *
 * Confirmed live (2026-09-01, Churrascaria Concórdia, same
 * conversation, back to back): a customer replied "pode ser" to the
 * bot's own rodízio-price offer, then "sim" to its own hours offer —
 * retrieval against those two words alone matched nothing in the
 * knowledge base (which had the real rodízio prices AND the real
 * hours), so the model had zero grounding and fabricated both answers
 * from scratch (a wrong flat rodízio price, and invented evening
 * hours the business doesn't have) instead of admitting it didn't
 * have the information at hand.
 */
export function retrievalQueryText(messages: ChatMessage[]): string {
  const latest = latestUserMessage(messages)
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      return `${messages[i].content}\n${latest}`
    }
  }
  return latest
}
