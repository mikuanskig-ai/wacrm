import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { AiConfig } from './types'

interface AiConfigRow {
  provider: 'openai' | 'anthropic'
  model: string
  api_key: string
  system_prompt: string | null
  is_active: boolean
  auto_reply_enabled: boolean
  auto_reply_max_per_conversation: number
  handoff_agent_id: string | null
  embeddings_api_key: string | null
  tools_enabled: boolean
  max_tool_iterations: number
}

const CONFIG_COLUMNS =
  'provider, model, api_key, system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation, handoff_agent_id, embeddings_api_key, tools_enabled, max_tool_iterations'

/**
 * Load and decrypt the account's AI config for *use* (draft or
 * auto-reply). Returns `null` when there's no row or the master switch
 * (`is_active`) is off — both mean "AI is not available", which callers
 * treat identically. Throws only if the stored key can't be decrypted
 * (mismatched `ENCRYPTION_KEY`), so that distinct failure surfaces
 * rather than looking like "not configured".
 *
 * Works with any client: pass the RLS-scoped SSR client from a
 * dashboard route, or the service-role admin client from the webhook.
 */
export async function loadAiConfig(
  db: SupabaseClient,
  accountId: string,
  opts: { requireActive?: boolean } = {},
): Promise<AiConfig | null> {
  const { requireActive = true } = opts
  const { data, error } = await db
    .from('ai_configs')
    .select(CONFIG_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const row = data as AiConfigRow
  // The Playground passes requireActive:false so an admin can test the
  // agent before flipping the master switch on.
  if (requireActive && !row.is_active) return null
  // Defensive: the column is NOT NULL, but a partial write / manual DB
  // edit could leave it empty. Treat a missing key as "not configured"
  // rather than letting decrypt() throw on null.
  if (!row.api_key) return null

  // The embeddings key is optional and independent of the chat key —
  // a corrupt/undecryptable one should downgrade to lexical KB, not
  // take down draft/auto-reply, so decrypt failures are swallowed here.
  let embeddingsApiKey: string | null = null
  if (row.embeddings_api_key) {
    try {
      embeddingsApiKey = decrypt(row.embeddings_api_key)
    } catch {
      // Not silent — a rotated/mismatched ENCRYPTION_KEY here means
      // semantic search quietly stops working, so leave a breadcrumb.
      console.error(
        `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY; semantic search is disabled until it is re-entered.`,
      )
      embeddingsApiKey = null
    }
  }

  return {
    provider: row.provider,
    model: row.model,
    apiKey: decrypt(row.api_key),
    systemPrompt: row.system_prompt,
    isActive: row.is_active,
    autoReplyEnabled: row.auto_reply_enabled,
    autoReplyMaxPerConversation: row.auto_reply_max_per_conversation,
    handoffAgentId: row.handoff_agent_id,
    embeddingsApiKey,
    toolsEnabled: row.tools_enabled,
    maxToolIterations: row.max_tool_iterations,
  }
}

/**
 * Load + decrypt the account's transcription config, independent of
 * `is_active` — a business may want voice notes transcribed for human
 * agents to read even with the AI assistant's master switch off.
 * Returns `null` when no transcription provider is configured, or the
 * stored key can't be decrypted (same "corrupt key -> treat as unset"
 * choice as `loadEmbeddingsKey`, logged rather than thrown so a single
 * account's bad key can never block message ingestion for anyone).
 * Used by the WhatsApp webhook right after an inbound audio message is
 * downloaded — see wuzapi/route.ts.
 *
 * OpenRouter (migration 072) is the one transcription provider that
 * can share the account's main chat key instead of needing its own —
 * same OpenRouter account either way. So when `transcription_provider
 * = 'openrouter'` and no dedicated `transcription_api_key` was ever
 * saved, this falls back to the row's own `api_key`, but ONLY when the
 * main chat `provider` is *also* 'openrouter' — an account on
 * Anthropic/Gemini/etc still needs its own dedicated transcription
 * key, same as Groq/OpenAI always have.
 */
export async function loadTranscriptionConfig(
  db: SupabaseClient,
  accountId: string,
): Promise<{ provider: 'groq' | 'openai' | 'openrouter'; apiKey: string } | null> {
  const { data, error } = await db
    .from('ai_configs')
    .select('transcription_provider, transcription_api_key, provider, api_key')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error || !data?.transcription_provider) return null

  const encryptedKey =
    data.transcription_api_key ??
    (data.transcription_provider === 'openrouter' && data.provider === 'openrouter' ? data.api_key : null)
  if (!encryptedKey) return null

  try {
    return {
      provider: data.transcription_provider as 'groq' | 'openai' | 'openrouter',
      apiKey: decrypt(encryptedKey),
    }
  } catch {
    console.error(
      `[ai config] transcription key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY.`,
    )
    return null
  }
}

/**
 * Load + decrypt just the embeddings key, independent of `is_active`.
 * Used by the knowledge-base ingest routes so the KB gets embedded (and
 * semantic search works) whenever an embeddings key is present, even if
 * the assistant's master switch is currently off.
 *
 * Returns `{ key, corrupt }`: `key` is null when there's no key OR it
 * can't be decrypted; `corrupt` distinguishes those cases so callers can
 * warn ("a key is set but unusable") rather than silently indexing
 * lexical-only and reporting success.
 */
export async function loadEmbeddingsKey(
  db: SupabaseClient,
  accountId: string,
): Promise<{ key: string | null; corrupt: boolean }> {
  const { data, error } = await db
    .from('ai_configs')
    .select('embeddings_api_key')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error || !data?.embeddings_api_key) return { key: null, corrupt: false }
  try {
    return { key: decrypt(data.embeddings_api_key), corrupt: false }
  } catch {
    console.error(
      `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY.`,
    )
    return { key: null, corrupt: true }
  }
}
