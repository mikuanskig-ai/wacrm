import { createOpenAiCompatibleProvider, type OpenAiNativeMessage } from './openai-compatible'

// OpenRouter — OpenAI-compatible gateway that proxies many providers
// under one key (`model` picks the underlying model, e.g.
// "anthropic/claude-sonnet-5"). See openai-compatible.ts.
const provider = createOpenAiCompatibleProvider({
  baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
  label: 'OpenRouter',
  maxTokensParam: 'max_tokens',
})

export const generateOpenRouter = provider.generate
export const seedOpenRouterMessages = provider.seedMessages
export const appendOpenRouterToolResults = provider.appendToolResults
export const callOpenRouterTurn = provider.callTurn
export type { OpenAiNativeMessage as OpenRouterNativeMessage }
