import { createOpenAiCompatibleProvider, type OpenAiNativeMessage } from './openai-compatible'

// OpenAI itself, on the shared OpenAI-compatible implementation (see
// openai-compatible.ts — Groq and OpenRouter are the same wire format
// at a different base URL, hence the shared factory rather than three
// near-duplicate files).
const provider = createOpenAiCompatibleProvider({
  baseUrl: 'https://api.openai.com/v1/chat/completions',
  label: 'OpenAI',
  maxTokensParam: 'max_completion_tokens',
})

export const generateOpenAi = provider.generate
export const seedOpenAiMessages = provider.seedMessages
export const appendOpenAiToolResults = provider.appendToolResults
export const callOpenAiTurn = provider.callTurn
export type { OpenAiNativeMessage }
