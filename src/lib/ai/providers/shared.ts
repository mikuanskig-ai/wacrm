import { AiError, type AiUsage, type ChatMessage } from '../types'
import type { JsonSchema } from '../tools/types'

// ============================================================
// Bits shared by the OpenAI + Anthropic adapters.
// ============================================================

export interface ProviderArgs {
  apiKey: string
  model: string
  systemPrompt: string
  messages: ChatMessage[]
  timeoutMs: number
}

// ============================================================
// Tool-calling wire types, shared by the *Turn adapters in openai.ts /
// anthropic.ts (used only by the tool loop in generate.ts —
// `generateReply`'s plain single-shot path never touches these).
// ============================================================

export interface ProviderToolDef {
  name: string
  description: string
  parameters: JsonSchema
}

export interface ProviderToolCall {
  /** Provider-issued call id — must be echoed back on the matching
   *  tool_result so the provider can pair them up. */
  id: string
  name: string
  args: Record<string, unknown>
}

export type ProviderCallResult =
  | { kind: 'text'; text: string; usage: AiUsage | null }
  | { kind: 'tool_calls'; calls: ProviderToolCall[]; usage: AiUsage | null }

/**
 * Coerce a provider's usage block into our normalized `AiUsage`, tolerant
 * of missing/partial fields (providers differ and older API versions may
 * omit counts). Returns null when there's nothing usable, so logging can
 * distinguish "no usage reported" from "zero tokens". `total` falls back
 * to prompt + completion when the provider doesn't send it (Anthropic).
 */
export function normalizeUsage(raw: {
  prompt?: unknown
  completion?: unknown
  total?: unknown
}): AiUsage | null {
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
  const promptTokens = num(raw.prompt)
  const completionTokens = num(raw.completion)
  const total = num(raw.total)
  const totalTokens = total > 0 ? total : promptTokens + completionTokens
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
    return null
  }
  return { promptTokens, completionTokens, totalTokens }
}

/** Map a fetch rejection (timeout / DNS / offline) to a typed AiError. */
export function toNetworkError(err: unknown): AiError {
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return new AiError('The AI provider took too long to respond.', {
      code: 'timeout',
      status: 504,
    })
  }
  const msg = err instanceof Error ? err.message : String(err)
  return new AiError(`Could not reach the AI provider: ${msg}`, {
    code: 'network_error',
    status: 502,
  })
}

/** Build a typed AiError from a non-2xx provider response, pulling the
 *  provider's own error message out of the JSON body when present. */
export async function providerHttpError(
  provider: string,
  res: Response,
): Promise<AiError> {
  let detail = ''
  try {
    const body = (await res.json()) as { error?: { message?: string } | string }
    detail =
      typeof body?.error === 'string'
        ? body.error
        : (body?.error?.message ?? '')
  } catch {
    // Non-JSON error body — fall back to the status line.
  }

  const { status } = res
  const code =
    status === 401 || status === 403
      ? 'invalid_key'
      : status === 429
        ? 'rate_limited'
        : 'provider_error'
  const base =
    code === 'invalid_key'
      ? `${provider} rejected the API key`
      : code === 'rate_limited'
        ? `${provider} rate limit reached`
        : `${provider} API error (${status})`

  return new AiError(detail ? `${base}: ${detail}` : base, {
    code,
    // Surface an auth failure as 401 so the settings "Test key" button
    // can show "invalid key"; everything else is an upstream 502.
    status: code === 'invalid_key' ? 401 : 502,
  })
}

/** Matches `function=tool_name {...}` — a second leaked-tool-call shape
 *  observed live (a smaller Llama model via Groq), distinct from the
 *  `{"name":...}` shape below. */
const FUNCTION_EQUALS_PATTERN = /function\s*=\s*[A-Za-z_][\w.]*\s*\{/

function outermostJsonObject(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
}

/**
 * Detects a model that wrote a tool call out as plain text instead of
 * using the provider's real structured tool-calling — a smaller/weaker
 * model narrating a call it should have made structurally, in one of
 * two shapes observed live so far:
 *   1. `{"name": "add_to_cart", "parameters": {...}}` — a full OpenAI-
 *      style call object as the message content.
 *   2. `function=search_menu {"query": "marmitas"}` — a "function="
 *      prefix followed by the raw args object.
 * Neither is caught by the normal tool_calls/tool_use parsing (that
 * field is simply absent on these turns), so without this check the
 * text would be sent to the customer verbatim. Deliberately narrow —
 * both require an actual embedded JSON object — so genuine customer-
 * facing text is never misdetected.
 */
export function looksLikeLeakedToolCall(text: string): boolean {
  const trimmed = text.trim()

  if (FUNCTION_EQUALS_PATTERN.test(trimmed)) {
    const args = outermostJsonObject(trimmed)
    if (args && typeof args === 'object') return true
  }

  // A leaked call can be the whole message, or (as observed live) prose
  // followed by the JSON blob — pull out the outermost {...} span rather
  // than requiring the entire string to be JSON.
  const parsed = outermostJsonObject(trimmed)
  if (!parsed || typeof parsed !== 'object') return false
  const obj = parsed as Record<string, unknown>
  const hasName = typeof obj.name === 'string' && obj.name.trim().length > 0
  const hasArgs =
    (typeof obj.parameters === 'object' && obj.parameters !== null) ||
    (typeof obj.arguments === 'object' && obj.arguments !== null)
  return hasName && hasArgs
}

/**
 * Throws when `text` looks like a leaked tool call rather than a real
 * reply. Routes into the exact same provider-error handoff path as any
 * other AiError (see auto-reply.ts's try/catch around the tool loop) —
 * a human takes over instead of the customer seeing raw JSON.
 */
export function guardAgainstLeakedToolCall(label: string, text: string): void {
  if (looksLikeLeakedToolCall(text)) {
    throw new AiError(`${label} emitted a malformed tool call instead of a reply.`, {
      code: 'malformed_tool_call',
    })
  }
}

/**
 * Collapse consecutive same-role turns into one (joined with blank
 * lines). Anthropic requires strictly alternating roles; merging is
 * also harmless for OpenAI and keeps the transcript compact.
 */
export function mergeConsecutive(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of messages) {
    const last = out[out.length - 1]
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`
    } else {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}
