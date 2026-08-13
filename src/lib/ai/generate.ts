import {
  AiError,
  type AiConfig,
  type AiUsage,
  type ChatMessage,
  type GenerateResult,
} from './types'
import { HANDOFF_SENTINEL, aiRequestTimeoutMs } from './defaults'
import { generateOpenAi, seedOpenAiMessages, appendOpenAiToolResults, callOpenAiTurn } from './providers/openai'
import {
  generateAnthropic,
  seedAnthropicMessages,
  appendAnthropicToolResults,
  callAnthropicTurn,
} from './providers/anthropic'
import {
  generateGemini,
  seedGeminiMessages,
  appendGeminiToolResults,
  callGeminiTurn,
} from './providers/gemini'
import { generateGroq, seedGroqMessages, appendGroqToolResults, callGroqTurn } from './providers/groq'
import {
  generateOpenRouter,
  seedOpenRouterMessages,
  appendOpenRouterToolResults,
  callOpenRouterTurn,
} from './providers/openrouter'
import type { ProviderToolDef } from './providers/shared'
import type { ToolContext, ToolDefinition } from './tools/types'
import type { PlacedOrderPayload } from './tools/delivery'
import { checkRateLimit, type RateLimitOptions } from '@/lib/rate-limit'

export interface GenerateArgs {
  config: AiConfig
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string
  /** `buildSystemPrompt`'s `cacheableText` — only consumed by
   *  providers with explicit prompt caching (Anthropic today); every
   *  other provider ignores it. Optional so every existing call site
   *  that predates caching support keeps compiling unchanged. */
  cacheableSystemPrompt?: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. Throws `AiError` on any provider/network failure.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, cacheableSystemPrompt, messages } = args
  const timeoutMs = aiRequestTimeoutMs()
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    cacheableSystemPrompt,
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
    case 'gemini':
      result = await generateGemini(providerArgs)
      break
    case 'groq':
      result = await generateGroq(providerArgs)
      break
    case 'openrouter':
      result = await generateOpenRouter(providerArgs)
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
  /** See GenerateArgs's field of the same name. */
  cacheableSystemPrompt?: string
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
  const { config, systemPrompt, cacheableSystemPrompt, messages, tools, toolContext, rateLimit } = args
  const timeoutMs = aiRequestTimeoutMs()
  const providerTools: ProviderToolDef[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }))
  const toolsByName = new Map(tools.map((t) => [t.name, t]))

  let usage: AiUsage | null = null

  // Tool-call/tool-result turns are otherwise completely invisible —
  // never logged, never persisted (see the file header doc: they're
  // "ephemeral"). When the model gives up and hands off with no crash
  // and no provider error, there was previously no way to tell WHY —
  // this trail gets dumped to the log in that one case (see
  // finishWithText below) so a silent handoff is diagnosable from
  // journalctl instead of DB archaeology.
  const toolTrail: string[] = []

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
      toolTrail.push(
        `${call.name}(${JSON.stringify(call.args).slice(0, 150)}) -> ${result.content.slice(0, 150)}`,
      )
      if (call.name === 'place_order' && result.data) {
        placedOrder = result.data as PlacedOrderPayload
      }
    }
    return { results, placedOrder }
  }

  /** Wraps `parseGeneration` for the loop's normal "model produced
   *  final text" exit — logs the tool trail iff that text turned out
   *  to be just the handoff sentinel, so the reasoning that led there
   *  is visible without having to reproduce it live. */
  function finishWithText(text: string, usage: AiUsage | null): GenerateWithToolsResult {
    const parsed = parseGeneration(text, usage)
    if (parsed.handoff) {
      console.warn(
        `[ai generate] model handed off after tool calls — trail:\n${
          toolTrail.length > 0 ? toolTrail.join('\n') : '(no tool calls this turn)'
        }`,
      )
    }
    return parsed
  }

  if (config.provider === 'openai') {
    let native = seedOpenAiMessages(systemPrompt, messages)
    for (let i = 0; i < config.maxToolIterations; i++) {
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
      if (result.kind === 'text') return finishWithText(result.text, usage)

      const { results, placedOrder } = await runToolCalls(result.calls)
      if (placedOrder) return { text: '', handoff: false, usage, placedOrder }
      native = appendOpenAiToolResults(native, result.calls, results)
    }
    console.warn(`[ai generate] tool loop hit max_tool_iterations (${config.maxToolIterations}) without a final reply — handing off (provider: openai). trail:\n${toolTrail.join('\n')}`)
    return { text: '', handoff: true, usage }
  }

  if (config.provider === 'anthropic') {
    let native = seedAnthropicMessages(messages)
    for (let i = 0; i < config.maxToolIterations; i++) {
      if (!checkRateLimit(rateLimit.key, rateLimit.options).success) {
        return { text: '', handoff: false, usage, rateLimited: true }
      }
      const result = await callAnthropicTurn({
        apiKey: config.apiKey,
        model: config.model,
        systemPrompt,
        cacheableSystemPrompt,
        nativeMessages: native,
        tools: providerTools,
        timeoutMs,
      })
      usage = sumUsage(usage, result.usage)
      if (result.kind === 'text') return finishWithText(result.text, usage)

      const { results, placedOrder } = await runToolCalls(result.calls)
      if (placedOrder) return { text: '', handoff: false, usage, placedOrder }
      native = appendAnthropicToolResults(native, result.calls, results)
    }
    console.warn(`[ai generate] tool loop hit max_tool_iterations (${config.maxToolIterations}) without a final reply — handing off (provider: anthropic). trail:\n${toolTrail.join('\n')}`)
    return { text: '', handoff: true, usage }
  }

  if (config.provider === 'groq') {
    let native = seedGroqMessages(systemPrompt, messages)
    for (let i = 0; i < config.maxToolIterations; i++) {
      if (!checkRateLimit(rateLimit.key, rateLimit.options).success) {
        return { text: '', handoff: false, usage, rateLimited: true }
      }
      const result = await callGroqTurn({
        apiKey: config.apiKey,
        model: config.model,
        nativeMessages: native,
        tools: providerTools,
        timeoutMs,
      })
      usage = sumUsage(usage, result.usage)
      if (result.kind === 'text') return finishWithText(result.text, usage)

      const { results, placedOrder } = await runToolCalls(result.calls)
      if (placedOrder) return { text: '', handoff: false, usage, placedOrder }
      native = appendGroqToolResults(native, result.calls, results)
    }
    console.warn(`[ai generate] tool loop hit max_tool_iterations (${config.maxToolIterations}) without a final reply — handing off (provider: groq). trail:\n${toolTrail.join('\n')}`)
    return { text: '', handoff: true, usage }
  }

  if (config.provider === 'openrouter') {
    let native = seedOpenRouterMessages(systemPrompt, messages)
    for (let i = 0; i < config.maxToolIterations; i++) {
      if (!checkRateLimit(rateLimit.key, rateLimit.options).success) {
        return { text: '', handoff: false, usage, rateLimited: true }
      }
      const result = await callOpenRouterTurn({
        apiKey: config.apiKey,
        model: config.model,
        nativeMessages: native,
        tools: providerTools,
        timeoutMs,
      })
      usage = sumUsage(usage, result.usage)
      if (result.kind === 'text') return finishWithText(result.text, usage)

      const { results, placedOrder } = await runToolCalls(result.calls)
      if (placedOrder) return { text: '', handoff: false, usage, placedOrder }
      native = appendOpenRouterToolResults(native, result.calls, results)
    }
    console.warn(`[ai generate] tool loop hit max_tool_iterations (${config.maxToolIterations}) without a final reply — handing off (provider: openrouter). trail:\n${toolTrail.join('\n')}`)
    return { text: '', handoff: true, usage }
  }

  if (config.provider === 'gemini') {
    let native = seedGeminiMessages(messages)
    for (let i = 0; i < config.maxToolIterations; i++) {
      if (!checkRateLimit(rateLimit.key, rateLimit.options).success) {
        return { text: '', handoff: false, usage, rateLimited: true }
      }
      const result = await callGeminiTurn({
        apiKey: config.apiKey,
        model: config.model,
        systemPrompt,
        nativeMessages: native,
        tools: providerTools,
        timeoutMs,
      })
      usage = sumUsage(usage, result.usage)
      if (result.kind === 'text') return finishWithText(result.text, usage)

      const { results, placedOrder } = await runToolCalls(result.calls)
      if (placedOrder) return { text: '', handoff: false, usage, placedOrder }
      native = appendGeminiToolResults(native, result.calls, results)
    }
    console.warn(`[ai generate] tool loop hit max_tool_iterations (${config.maxToolIterations}) without a final reply — handing off (provider: gemini). trail:\n${toolTrail.join('\n')}`)
    return { text: '', handoff: true, usage }
  }

  throw new AiError(`Unsupported AI provider: ${config.provider}`, {
    code: 'unsupported_provider',
    status: 400,
  })
}
