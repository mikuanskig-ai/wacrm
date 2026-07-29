import { AiError, type ChatMessage, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
  type ProviderCallResult,
  type ProviderToolCall,
  type ProviderToolDef,
} from './shared'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

interface OpenAiResponse {
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

/**
 * Call OpenAI's Chat Completions endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`).
 */
export async function generateOpenAi(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args

  let res: Response
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...mergeConsecutive(messages),
        ],
        max_completion_tokens: MAX_OUTPUT_TOKENS,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('OpenAI', res)
  }

  const data = (await res.json().catch(() => null)) as OpenAiResponse | null
  const text = data?.choices?.[0]?.message?.content
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new AiError('OpenAI returned an empty response.', {
      code: 'empty_response',
    })
  }
  const usage = normalizeUsage({
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
  })
  return { text, usage }
}

// ============================================================
// Tool-calling turn — used only by the tool loop in generate.ts
// (`generateReplyWithTools`). Kept separate from `generateOpenAi`
// above so the plain single-shot path (`generateReply`, every existing
// call site) is completely unaffected by this addition.
// ============================================================

interface OpenAiToolCallWire {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type OpenAiNativeMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAiToolCallWire[] }
  | { role: 'tool'; tool_call_id: string; content: string }

/** Seed the working message list for a fresh tool-loop turn. */
export function seedOpenAiMessages(
  systemPrompt: string,
  messages: ChatMessage[],
): OpenAiNativeMessage[] {
  return [
    { role: 'system', content: systemPrompt },
    ...mergeConsecutive(messages).map((m) => ({ role: m.role, content: m.content })),
  ]
}

/** Append one tool round (the assistant's tool_calls turn + each
 *  tool's result) to the working message list, ready for the next
 *  provider call. */
export function appendOpenAiToolResults(
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

function safeParseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** One provider round-trip with `tools` in the payload. Returns either
 *  a final text reply or the model's requested tool calls — never
 *  throws `empty_response` for a pure tool_calls turn (which has no
 *  `content`), unlike `generateOpenAi`. */
export async function callOpenAiTurn(args: {
  apiKey: string
  model: string
  nativeMessages: OpenAiNativeMessage[]
  tools: ProviderToolDef[]
  timeoutMs: number
}): Promise<ProviderCallResult> {
  const { apiKey, model, nativeMessages, tools, timeoutMs } = args

  let res: Response
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: nativeMessages,
        max_completion_tokens: MAX_OUTPUT_TOKENS,
        ...(tools.length > 0
          ? {
              tools: tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.parameters },
              })),
            }
          : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('OpenAI', res)
  }

  const data = (await res.json().catch(() => null)) as OpenAiResponse | null
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
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new AiError('OpenAI returned an empty response.', { code: 'empty_response' })
  }
  return { kind: 'text', text, usage }
}
