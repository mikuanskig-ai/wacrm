import type { ChatMessage } from './types'

/** Longest the quoted customer message runs before we ellipsize it —
 *  keeps the internal note to a glanceable one-liner. */
const MAX_QUOTE_LEN = 160

/**
 * Build the short internal note the auto-reply bot leaves on a
 * conversation when it hands off to a human. Deterministic — composed
 * from context we already have (no extra LLM call / token spend), so it
 * can't fail or add latency to the handoff.
 *
 * Reads as, e.g.:
 *   "🤖 AI agent handed off after 2 replies. Last customer message:
 *    “can I speak to a manager about my refund?”"
 *
 * `replyCount` is the bot's auto-reply tally for the thread (0 when it
 * bailed on the very first inbound without answering).
 */
export function buildHandoffSummary(args: {
  messages: ChatMessage[]
  replyCount: number
  /** Set when the handoff was forced by a provider-side failure (rate
   *  limit, invalid key, network/timeout) or by the hallucinated-summary
   *  safety check (see auto-reply.ts's ORDER_SUMMARY_WITH_PRICE_PATTERN)
   *  rather than the model itself asking for a human — distinguishes
   *  "AI chose to hand off" from "AI couldn't run at all" / "AI was about
   *  to tell the customer a made-up price" for whoever picks up the
   *  thread. */
  reason?: 'provider_error' | 'hallucinated_summary'
}): string {
  const { messages, replyCount, reason } = args

  const lastCustomer = [...messages]
    .reverse()
    .find((m) => m.role === 'user' && m.content.trim())

  const replies =
    replyCount === 0
      ? 'without replying'
      : `after ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`

  const base =
    reason === 'provider_error'
      ? `⚠️ AI agent handed off after a provider error (could not generate a reply), ${replyCount} earlier ${replyCount === 1 ? 'reply' : 'replies'} on this thread.`
      : reason === 'hallucinated_summary'
        ? `🚨 AI agent handed off ${replies} — it was about to send an order summary with a price, but the cart is empty (nothing was actually added). Check what the customer really wants before quoting anything.`
        : `🤖 AI agent handed off ${replies}.`

  if (!lastCustomer) return base

  const quote = truncate(lastCustomer.content.trim(), MAX_QUOTE_LEN)
  return `${base} Last customer message: “${quote}”`
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ')
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, max - 1).trimEnd()}…`
}
