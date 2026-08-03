import { AiError, type ChatMessage, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import type { JsonSchema } from '../tools/types'
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

/**
 * Gemini's function-calling schema is a restricted OpenAPI subset — it
 * rejects any JSON-Schema keyword it doesn't recognize with a hard 400
 * (observed live: "Unknown name \"additionalProperties\" ... Cannot
 * find field"), unlike OpenAI/Anthropic which both accept plain JSON
 * Schema. Strip the keywords our shared `JsonSchema` sets that Gemini
 * doesn't support, rather than adding a third parallel schema shape to
 * `ToolDefinition`.
 */
function toGeminiParameters(schema: JsonSchema): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...schema }
  delete rest.additionalProperties
  return rest
}

const GEMINI_URL = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`

interface GeminiPart {
  text?: string
  functionCall?: { name: string; args?: Record<string, unknown> }
  functionResponse?: { name: string; response: Record<string, unknown> }
}

interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] } }[]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
}

/**
 * Gemini has no `system` role in `contents` — it takes a separate
 * `systemInstruction` field (like Anthropic's `system`) — and prefers
 * (though doesn't as strictly enforce as Anthropic) alternating
 * user/model turns, so the same `mergeConsecutive` + role-map applies.
 */
function toGeminiContents(messages: ChatMessage[]): GeminiContent[] {
  return mergeConsecutive(messages).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))
}

function textFromParts(parts: GeminiPart[] | undefined): string {
  return (parts ?? [])
    .filter((p): p is { text: string } => typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
    .trim()
}

/**
 * Call Gemini's generateContent endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`).
 */
export async function generateGemini(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args

  let res: Response
  try {
    res = await fetch(GEMINI_URL(model), {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: toGeminiContents(messages),
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('Gemini', res)
  }

  const data = (await res.json().catch(() => null)) as GeminiResponse | null
  const text = textFromParts(data?.candidates?.[0]?.content?.parts)
  if (!text) {
    throw new AiError('Gemini returned an empty response.', {
      code: 'empty_response',
    })
  }
  const usage = normalizeUsage({
    prompt: data?.usageMetadata?.promptTokenCount,
    completion: data?.usageMetadata?.candidatesTokenCount,
    total: data?.usageMetadata?.totalTokenCount,
  })
  return { text, usage }
}

// ============================================================
// Tool-calling turn — used only by the tool loop in generate.ts
// (`generateReplyWithTools`). Mirrors openai.ts/anthropic.ts's shape.
// ============================================================

/** Seed the working message list for a fresh tool-loop turn. System
 *  prompt is NOT part of this list — Gemini takes it as a separate
 *  top-level `systemInstruction` field (see `callGeminiTurn`). */
export function seedGeminiMessages(messages: ChatMessage[]): GeminiContent[] {
  return toGeminiContents(messages)
}

/**
 * Append one tool round to the working message list: a `model` turn
 * carrying the requested functionCall parts, followed by a `user` turn
 * carrying the matching functionResponse parts — Gemini's required
 * shape for continuing after a tool call. Unlike OpenAI/Anthropic,
 * Gemini has no provider-issued call id to echo back — pairing is by
 * name/position only, so `results` (keyed by our own synthesized id)
 * is re-matched against `calls` here to recover the name.
 */
export function appendGeminiToolResults(
  native: GeminiContent[],
  calls: ProviderToolCall[],
  results: { id: string; content: string }[],
): GeminiContent[] {
  const nameById = new Map(calls.map((c) => [c.id, c.name]))
  return [
    ...native,
    {
      role: 'model',
      parts: calls.map((c) => ({ functionCall: { name: c.name, args: c.args } })),
    },
    {
      role: 'user',
      parts: results.map((r) => ({
        functionResponse: {
          name: nameById.get(r.id) ?? '',
          response: { content: r.content },
        },
      })),
    },
  ]
}

/** One provider round-trip with `tools` in the payload. Returns either
 *  a final text reply or the model's requested tool calls — never
 *  throws `empty_response` for a pure function-call turn (which has no
 *  text part), unlike `generateGemini`. */
export async function callGeminiTurn(args: {
  apiKey: string
  model: string
  systemPrompt: string
  nativeMessages: GeminiContent[]
  tools: ProviderToolDef[]
  timeoutMs: number
}): Promise<ProviderCallResult> {
  const { apiKey, model, systemPrompt, nativeMessages, tools, timeoutMs } = args

  let res: Response
  try {
    res = await fetch(GEMINI_URL(model), {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: nativeMessages,
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
        ...(tools.length > 0
          ? {
              tools: [
                {
                  functionDeclarations: tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    parameters: toGeminiParameters(t.parameters),
                  })),
                },
              ],
            }
          : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('Gemini', res)
  }

  const data = (await res.json().catch(() => null)) as GeminiResponse | null
  const usage = normalizeUsage({
    prompt: data?.usageMetadata?.promptTokenCount,
    completion: data?.usageMetadata?.candidatesTokenCount,
    total: data?.usageMetadata?.totalTokenCount,
  })

  const parts = data?.candidates?.[0]?.content?.parts ?? []
  const functionCalls = parts.filter(
    (p): p is { functionCall: { name: string; args?: Record<string, unknown> } } =>
      !!p.functionCall && typeof p.functionCall.name === 'string',
  )
  if (functionCalls.length > 0) {
    return {
      kind: 'tool_calls',
      calls: functionCalls.map((p, i) => ({
        id: `call-${i}`,
        name: p.functionCall.name,
        args: p.functionCall.args ?? {},
      })),
      usage,
    }
  }

  const text = textFromParts(parts)
  if (!text) {
    throw new AiError('Gemini returned an empty response.', { code: 'empty_response' })
  }
  guardAgainstLeakedToolCall('Gemini', text)
  return { kind: 'text', text, usage }
}
