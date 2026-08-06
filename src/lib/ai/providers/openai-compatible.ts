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

// ============================================================
// Shared implementation for every provider that speaks the OpenAI
// Chat Completions wire format verbatim — OpenAI itself, plus Groq and
// OpenRouter, both of which expose an OpenAI-compatible endpoint at a
// different base URL. One real implementation instead of three near-
// identical ~200-line files that would drift out of sync on the next
// bugfix.
// ============================================================

interface OpenAiCompatResponse {
  choices?: {
    message?: {
      content?: string | null
      tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
    }
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

interface OpenAiToolCallWire {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type OpenAiNativeMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAiToolCallWire[] }
  | { role: 'tool'; tool_call_id: string; content: string }

function safeParseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export interface OpenAiCompatibleOptions {
  /** Full chat-completions endpoint URL. */
  baseUrl: string
  /** Used in error messages ("OpenAI rejected the API key", "Groq..."). */
  label: string
  /** OpenAI's current API wants `max_completion_tokens`; Groq and
   *  OpenRouter's compatibility layers want the older `max_tokens`
   *  name instead — sending the wrong one is silently ignored by some
   *  providers and rejected by others, so this must match per provider. */
  maxTokensParam: 'max_tokens' | 'max_completion_tokens'
}

/** Builds the four provider-adapter functions `generate.ts` needs,
 *  wired to one OpenAI-compatible endpoint. See `openai.ts`, `groq.ts`,
 *  `openrouter.ts` for the concrete instantiations. */
export function createOpenAiCompatibleProvider(opts: OpenAiCompatibleOptions) {
  const { baseUrl, label, maxTokensParam } = opts

  async function generate(args: ProviderArgs): Promise<ProviderResult> {
    const { apiKey, model, systemPrompt, messages, timeoutMs } = args
    const body = JSON.stringify({
      model,
      messages: [{ role: 'system', content: systemPrompt }, ...mergeConsecutive(messages)],
      [maxTokensParam]: MAX_OUTPUT_TOKENS,
    })

    // Retry once on a genuinely empty completion (ok HTTP status, no
    // tool_calls, blank content) before giving up — confirmed live
    // (2026-08-06, OpenRouter/openai/gpt-5.6-luna): this happens as a
    // transient upstream blip, not a real failure, and previously
    // handed a real customer's conversation off to a human every time
    // it fired even though a second identical request usually just
    // works. Network/HTTP errors still throw immediately below — only
    // the "responded fine but said nothing" case gets a second try.
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response
      try {
        res = await fetch(baseUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (err) {
        throw toNetworkError(err)
      }

      if (!res.ok) {
        throw await providerHttpError(label, res)
      }

      const data = (await res.json().catch(() => null)) as OpenAiCompatResponse | null
      const text = data?.choices?.[0]?.message?.content
      const usage = normalizeUsage({
        prompt: data?.usage?.prompt_tokens,
        completion: data?.usage?.completion_tokens,
        total: data?.usage?.total_tokens,
      })
      if (text && typeof text === 'string' && text.trim()) {
        return { text, usage }
      }
      if (attempt === 0) {
        console.warn(`[ai ${label}] empty response, retrying once before handing off`)
      }
    }
    throw new AiError(`${label} returned an empty response.`, { code: 'empty_response' })
  }

  function seedMessages(systemPrompt: string, messages: ChatMessage[]): OpenAiNativeMessage[] {
    return [
      { role: 'system', content: systemPrompt },
      ...mergeConsecutive(messages).map((m) => ({ role: m.role, content: m.content })),
    ]
  }

  function appendToolResults(
    native: OpenAiNativeMessage[],
    calls: ProviderToolCall[],
    results: { id: string; content: string }[],
  ): OpenAiNativeMessage[] {
    return [
      ...native,
      {
        role: 'assistant',
        content: null,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      },
      ...results.map((r) => ({ role: 'tool' as const, tool_call_id: r.id, content: r.content })),
    ]
  }

  async function callTurn(args: {
    apiKey: string
    model: string
    nativeMessages: OpenAiNativeMessage[]
    tools: ProviderToolDef[]
    timeoutMs: number
  }): Promise<ProviderCallResult> {
    const { apiKey, model, nativeMessages, tools, timeoutMs } = args
    const body = JSON.stringify({
      model,
      messages: nativeMessages,
      [maxTokensParam]: MAX_OUTPUT_TOKENS,
      ...(tools.length > 0
        ? {
            tools: tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
    })

    // Same one-retry-on-empty-completion as `generate` above — a
    // mid-order tool turn is exactly where this was observed to strand
    // a real customer (fee already quoted, order never placed).
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response
      try {
        res = await fetch(baseUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (err) {
        throw toNetworkError(err)
      }

      if (!res.ok) {
        throw await providerHttpError(label, res)
      }

      const data = (await res.json().catch(() => null)) as OpenAiCompatResponse | null
      const usage = normalizeUsage({
        prompt: data?.usage?.prompt_tokens,
        completion: data?.usage?.completion_tokens,
        total: data?.usage?.total_tokens,
      })

      const message = data?.choices?.[0]?.message
      const toolCalls = message?.tool_calls
      if (toolCalls && toolCalls.length > 0) {
        return {
          kind: 'tool_calls',
          calls: toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            args: safeParseToolArgs(tc.function.arguments),
          })),
          usage,
        }
      }

      const text = message?.content
      if (text && typeof text === 'string' && text.trim()) {
        guardAgainstLeakedToolCall(label, text)
        return { kind: 'text', text, usage }
      }
      if (attempt === 0) {
        console.warn(`[ai ${label}] empty response mid tool-loop, retrying once before handing off`)
      }
    }
    throw new AiError(`${label} returned an empty response.`, { code: 'empty_response' })
  }

  return { generate, seedMessages, appendToolResults, callTurn }
}
