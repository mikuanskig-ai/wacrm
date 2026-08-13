import { AiError, type ChatMessage, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  guardAgainstLeakedToolCall,
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
  type ProviderCallResult,
  type ProviderToolCall,
  type ProviderToolDef,
} from './shared'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
// Was required to opt into `cache_control` support back when prompt
// caching first launched (2024) — sent defensively in case whatever
// API version this account is actually pinned to still gates on it;
// an extra/stale beta flag on a header is the kind of thing providers
// ignore rather than reject, so there's no real downside to including
// it even once this is long since general-availability-by-default.
const ANTHROPIC_BETA_HEADER = 'prompt-caching-2024-07-31'

interface AnthropicResponse {
  content?: { type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[]
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
}

type AnthropicSystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }

/**
 * Splits `systemPrompt` into a cacheable block (`cacheableSystemPrompt`,
 * marked with `cache_control`) plus an uncached tail with whatever's
 * left — instead of the flat string every other provider gets. Only
 * worth doing when the cacheable prefix is both a genuine prefix of
 * the full prompt AND large enough to matter: Anthropic requires 1024+
 * tokens (roughly 4+ characters/token, so ~4000 chars is a safe floor)
 * for a cache write to be accepted at all; below that, the API
 * silently writes zero cache tokens and this would just add an unused
 * extra content block for nothing. Falls back to a single uncached
 * block whenever the split isn't usable (no cacheableSystemPrompt
 * given, or it doesn't actually match the start of systemPrompt —
 * e.g. a future caller changes the format without updating this).
 */
function buildSystemBlocks(systemPrompt: string, cacheableSystemPrompt?: string): AnthropicSystemBlock[] {
  const MIN_CACHEABLE_CHARS = 4000
  if (
    !cacheableSystemPrompt ||
    cacheableSystemPrompt.length < MIN_CACHEABLE_CHARS ||
    !systemPrompt.startsWith(cacheableSystemPrompt)
  ) {
    return [{ type: 'text', text: systemPrompt }]
  }
  const rest = systemPrompt.slice(cacheableSystemPrompt.length)
  const blocks: AnthropicSystemBlock[] = [
    { type: 'text', text: cacheableSystemPrompt, cache_control: { type: 'ephemeral' } },
  ]
  if (rest.trim()) blocks.push({ type: 'text', text: rest })
  return blocks
}

/**
 * Anthropic's Messages API requires strictly alternating roles that
 * begin with `user`. Merge consecutive turns, then drop any leading
 * assistant turns (an agent greeting before the customer said anything)
 * so the transcript always starts on the customer. Guarantees a valid,
 * non-empty payload.
 */
function normalizeForAnthropic(messages: ChatMessage[]): ChatMessage[] {
  const merged = mergeConsecutive(messages)
  while (merged.length > 0 && merged[0].role === 'assistant') {
    merged.shift()
  }
  if (merged.length === 0) {
    return [{ role: 'user', content: '(The customer has not sent a message yet.)' }]
  }
  return merged
}

/**
 * Call Anthropic's Messages endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`).
 */
export async function generateAnthropic(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, cacheableSystemPrompt, messages, timeoutMs } = args

  let res: Response
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': ANTHROPIC_BETA_HEADER,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        system: buildSystemBlocks(systemPrompt, cacheableSystemPrompt),
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: normalizeForAnthropic(messages),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('Anthropic', res)
  }

  const data = (await res.json().catch(() => null)) as AnthropicResponse | null
  const text = data?.content
    ?.filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim()
  if (!text) {
    throw new AiError('Anthropic returned an empty response.', {
      code: 'empty_response',
    })
  }
  // Anthropic reports input/output but no total — normalizeUsage sums.
  const usage = normalizeUsage({
    prompt: data?.usage?.input_tokens,
    completion: data?.usage?.output_tokens,
  })
  return { text, usage }
}

// ============================================================
// Tool-calling turn — used only by the tool loop in generate.ts
// (`generateReplyWithTools`). Kept separate from `generateAnthropic`
// above so the plain single-shot path (`generateReply`, every existing
// call site) is completely unaffected by this addition.
// ============================================================

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }

export interface AnthropicNativeMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

/** Seed the working message list for a fresh tool-loop turn. System
 *  prompt is NOT part of this list — Anthropic takes it as a separate
 *  top-level `system` field (see `callAnthropicTurn`). */
export function seedAnthropicMessages(messages: ChatMessage[]): AnthropicNativeMessage[] {
  return normalizeForAnthropic(messages).map((m) => ({ role: m.role, content: m.content }))
}

/** Append one tool round to the working message list: an assistant
 *  turn carrying the requested tool_use blocks, followed by a user
 *  turn carrying the matching tool_result blocks — Anthropic's
 *  required shape for continuing after a tool call. */
export function appendAnthropicToolResults(
  native: AnthropicNativeMessage[],
  calls: ProviderToolCall[],
  results: { id: string; content: string }[],
): AnthropicNativeMessage[] {
  return [
    ...native,
    {
      role: 'assistant',
      content: calls.map((c) => ({ type: 'tool_use' as const, id: c.id, name: c.name, input: c.args })),
    },
    {
      role: 'user',
      content: results.map((r) => ({ type: 'tool_result' as const, tool_use_id: r.id, content: r.content })),
    },
  ]
}

/** One provider round-trip with `tools` in the payload. Returns either
 *  a final text reply or the model's requested tool calls — never
 *  throws `empty_response` for a pure tool_use turn (which has no
 *  `text` block), unlike `generateAnthropic`. */
export async function callAnthropicTurn(args: {
  apiKey: string
  model: string
  systemPrompt: string
  cacheableSystemPrompt?: string
  nativeMessages: AnthropicNativeMessage[]
  tools: ProviderToolDef[]
  timeoutMs: number
}): Promise<ProviderCallResult> {
  const { apiKey, model, systemPrompt, cacheableSystemPrompt, nativeMessages, tools, timeoutMs } = args

  // Every one of the (up to maxToolIterations) round-trips this one
  // reply makes resends the exact same `tools` array — it's static
  // for the whole loop, and identical across every turn of every
  // conversation this account has while tools are enabled at all. The
  // real payoff is here, not just on the system prompt: a
  // Delivery-enabled account's tool loop is the majority of its
  // volume (search_menu -> get_product_details -> add_to_cart ->
  // view_cart -> calculate_delivery_fee -> place_order is 5-6 calls
  // for one clean order), so caching the ~1-2k tokens of tool schemas
  // once and reading them back cheap on every subsequent round-trip
  // compounds fast. Marking the LAST tool caches everything up to and
  // including it, same rule as the system blocks above.
  const toolDefs = tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
    ...(i === tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
  }))

  let res: Response
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': ANTHROPIC_BETA_HEADER,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        system: buildSystemBlocks(systemPrompt, cacheableSystemPrompt),
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: nativeMessages,
        ...(tools.length > 0 ? { tools: toolDefs } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('Anthropic', res)
  }

  const data = (await res.json().catch(() => null)) as AnthropicResponse | null
  const usage = normalizeUsage({
    prompt: data?.usage?.input_tokens,
    completion: data?.usage?.output_tokens,
  })

  const blocks = data?.content ?? []
  const toolUseBlocks = blocks.filter(
    (b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } =>
      b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string',
  )
  if (toolUseBlocks.length > 0) {
    return {
      kind: 'tool_calls',
      calls: toolUseBlocks.map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} })),
      usage,
    }
  }

  const text = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim()
  if (!text) {
    throw new AiError('Anthropic returned an empty response.', { code: 'empty_response' })
  }
  guardAgainstLeakedToolCall('Anthropic', text)
  return { kind: 'text', text, usage }
}
