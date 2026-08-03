import { createOpenAiCompatibleProvider, type OpenAiNativeMessage } from './openai-compatible'

// Groq — OpenAI-compatible endpoint, known for very fast open-weight
// model inference (Llama, etc.). See openai-compatible.ts.
const provider = createOpenAiCompatibleProvider({
  baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
  label: 'Groq',
  maxTokensParam: 'max_tokens',
})

export const generateGroq = provider.generate
export const seedGroqMessages = provider.seedMessages
export const appendGroqToolResults = provider.appendToolResults
export const callGroqTurn = provider.callTurn
export type { OpenAiNativeMessage as GroqNativeMessage }
