import {
  AiError,
  type AiConfig,
  type AiUsage,
  type ChatMessage,
  type GenerateResult,
} from './types'
import { HANDOFF_SENTINEL, MAX_TOOL_ITERATIONS, aiRequestTimeoutMs } from './defaults'
import { generateOpenAi, seedOpenAiMessages, appendOpenAiToolResults, callOpenAiTurn } from './providers/openai'
import {
  generateAnthropic,
  seedAnthropicMessages,
  appendAnthropicToolResults,
  callAnthropicTurn,
} from './providers/anthropic'
import type { ProviderToolDef } from './providers/shared'
import type { ToolContext, ToolDefinition } from './tools/types'
import type { PlacedOrderPayload } from './tools/delivery'
import { checkRateLimit, type RateLimitOptions } from '@/lib/rate-limit'

export interface GenerateArgs {
  config: AiConfig
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. Throws `AiError` on any provider/network failure.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, messages } = args
  const timeoutMs = aiRequestTimeoutMs()
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs,
  }

  let result: { text: string; usage: AiUsage | null }
  switch (config.provider) {
    case 'openai':
      result = await generateOpenAi(providerArgs)
      break
    case 'anthropic':
      result = await generateAnthropic(providerArgs)
      break
    default:
      throw new AiError(`Unsupported AI provider: ${config.provider}`, {
        code: 'unsupported_provider',
        status: 400,
      })
  }

  return parseGeneration(result.text, result.usage)
}

/**
 * Split the raw model output into `{ text, handoff, usage }`. The
 * sentinel can appear alone or trailing a partial reply; either way we
 * treat the turn as a handoff and strip the marker from any remaining
 * text. `usage` is passed straight through (null when the provider
 * didn't report it).
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null,
): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL)
  const text = raw.split(HANDOFF_SENTINEL).join('').trim()
  return { text, handoff, usage }
}

function sumUsage(a: AiUsage | null, b: AiUsage | null): AiUsage | null {
  if (!a) return b
  if (!b) return a
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  }
}

export interface GenerateWithToolsArgs {
  config: AiConfig
  systemPrompt: string
  messages: ChatMessage[]
  tools: ToolDefinition[]
  toolContext: ToolContext
  /** Checked once per provider round-trip, not just once per dispatch —
   *  a tool loop can make several calls for one customer message, and
   *  the account's real provider load should be priced accordingly. */
  rateLimit: { key: string; options: RateLimitOptions }
}

export interface GenerateWithToolsResult extends GenerateResult {
  /** Set when a `place_order` tool call succeeded this turn — the loop
   *  stops immediately without a further provider round-trip. The
   *  caller (auto-reply.ts) builds a deterministic confirmation from
   *  this instead of trusting more model output for it: if that next
   *  round-trip failed or timed out, the order would already exist but
   *  the customer would never be told. */
  placedOrder?: PlacedOrderPayload
  /** Set when a round-trip was skipped because the account hit its
   *  provider rate limit mid-loop. Distinct from `handoff` — this is a
   *  transient "try again on the next message," not a signal that a
   *  human should take over the conversation. */
  rateLimited?: boolean
}

/**
 * Tool-calling variant of `generateReply`, used only when the account
 * has Delivery tools available for this turn (see
 * `src/lib/ai/tools/delivery.ts`'s `getAvailableTools`). Kept as a
 * separate function — not a branch inside `generateReply` — so every
 * existing call site that never passes `tools` is completely
 * unaffected by this addition.
 *
 * The tool-call/tool-result turns this loop generates locally are
 * ephemeral: they seed from the real conversation transcript but are
 * never written back to it (`buildConversationContext` / the
 * `messages` table). Only the final text — or the caller's own
 * deterministic order-confirmation message, when `placedOrder` is set
 * — is ever sent to the customer.
 */
export async function generateReplyWithTools(
  args: GenerateWithToolsArgs,
): Promise<GenerateWithToolsResult> {
  const { config, systemPrompt, messages, tools, toolContext, rateLimit } = args
  const timeoutMs = aiRequestTimeoutMs()
  const providerTools: ProviderToolDef[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }))
  const toolsByName = new Map(tools.map((t) => [t.name, t]))

  let usage: AiUsage | null = null

  async function runToolCalls(
    calls: { id: string; name: string; args: Record<string, unknown> }[],
  ): Promise<{ results: { id: string; content: string }[]; placedOrder?: PlacedOrderPayload }> {
    const results: { id: string; content: string }[] = []
    let placedOrder: PlacedOrderPayload | undefined
    for (const call of calls) {
      const tool = toolsByName.get(call.name)
      const result = tool
        ? await tool.execute(call.args, toolContext)
        : { content: `Unknown tool: ${call.name}` }
      results.push({ id: call.id, content: result.content })
      if (call.name === 'place_order' && result.data) {
        placedOrder = result.data as PlacedOrderPayload
      }
    }
    return { results, placedOrder }
  }

  if (config.provider === 'openai') {
    let native = seedOpenAiMessages(systemPrompt, messages)
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      if (!checkRateLimit(rateLimit.key, rateLimit.options).success) {
        return { text: '', handoff: false, usage, rateLimited: true }
      }
      const result = await callOpenAiTurn({
        apiKey: config.apiKey,
        model: config.model,
        nativeMessages: native,
        tools: providerTools,
        timeoutMs,
      })
      usage = sumUsage(usage, result.usage)
      if (result.kind === 'text') return parseGeneration(result.text, usage)

      const { results, placedOrder } = await runToolCalls(result.calls)
      if (placedOrder) return { text: '', handoff: false, usage, placedOrder }
      native = appendOpenAiToolResults(native, result.calls, results)
    }
    return { text: '', handoff: true, usage }
  }

  if (config.provider === 'anthropic') {
    let native = seedAnthropicMessages(messages)
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      if (!checkRateLimit(rateLimit.key, rateLimit.options).success) {
        return { text: '', handoff: false, usage, rateLimited: true }
      }
      const result = await callAnthropicTurn({
        apiKey: config.apiKey,
        model: config.model,
        systemPrompt,
        nativeMessages: native,
        tools: providerTools,
        timeoutMs,
      })
      usage = sumUsage(usage, result.usage)
      if (result.kind === 'text') return parseGeneration(result.text, usage)

      const { results, placedOrder } = await runToolCalls(result.calls)
      if (placedOrder) return { text: '', handoff: false, usage, placedOrder }
      native = appendAnthropicToolResults(native, result.calls, results)
    }
    return { text: '', handoff: true, usage }
  }

  throw new AiError(`Unsupported AI provider: ${config.provider}`, {
    code: 'unsupported_provider',
    status: 400,
  })
}
