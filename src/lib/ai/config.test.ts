import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// decrypt is identity in tests so we don't depend on real ciphertext.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `plain:${v}`,
}))

import { loadAiConfig, loadTranscriptionConfig } from './config'

function dbReturning(row: Record<string, unknown> | null): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve({ data: row, error: null }),
  }
  return chain as unknown as SupabaseClient
}

const ROW = {
  provider: 'openai',
  model: 'gpt-x',
  api_key: 'enc-key',
  system_prompt: null,
  is_active: false,
  auto_reply_enabled: false,
  auto_reply_max_per_conversation: 3,
  embeddings_api_key: null,
}

describe('loadAiConfig requireActive', () => {
  it('returns null for an inactive config by default', async () => {
    expect(await loadAiConfig(dbReturning(ROW), 'acct')).toBeNull()
  })

  it('returns the config when requireActive is false (Playground path)', async () => {
    const config = await loadAiConfig(dbReturning(ROW), 'acct', {
      requireActive: false,
    })
    expect(config).not.toBeNull()
    expect(config!.provider).toBe('openai')
    expect(config!.apiKey).toBe('plain:enc-key')
  })

  it('returns null when there is no row', async () => {
    expect(
      await loadAiConfig(dbReturning(null), 'acct', { requireActive: false }),
    ).toBeNull()
  })
})

describe('loadTranscriptionConfig', () => {
  it('returns null when no transcription provider is configured', async () => {
    expect(await loadTranscriptionConfig(dbReturning(null), 'acct')).toBeNull()
    expect(
      await loadTranscriptionConfig(
        dbReturning({ transcription_provider: null, transcription_api_key: null }),
        'acct',
      ),
    ).toBeNull()
  })

  it('returns the decrypted key + provider when configured, independent of is_active', async () => {
    const config = await loadTranscriptionConfig(
      dbReturning({ transcription_provider: 'groq', transcription_api_key: 'enc-groq-key' }),
      'acct',
    )
    expect(config).toEqual({ provider: 'groq', apiKey: 'plain:enc-groq-key' })
  })

  it('falls back to the main chat key when transcription is OpenRouter with no dedicated key, and the chat provider is also OpenRouter', async () => {
    const config = await loadTranscriptionConfig(
      dbReturning({
        transcription_provider: 'openrouter',
        transcription_api_key: null,
        provider: 'openrouter',
        api_key: 'enc-main-key',
      }),
      'acct',
    )
    expect(config).toEqual({ provider: 'openrouter', apiKey: 'plain:enc-main-key' })
  })

  it('prefers a dedicated OpenRouter transcription key over the main chat key when both are set', async () => {
    const config = await loadTranscriptionConfig(
      dbReturning({
        transcription_provider: 'openrouter',
        transcription_api_key: 'enc-dedicated-key',
        provider: 'openrouter',
        api_key: 'enc-main-key',
      }),
      'acct',
    )
    expect(config).toEqual({ provider: 'openrouter', apiKey: 'plain:enc-dedicated-key' })
  })

  it('does NOT fall back to the main key when the chat provider is not OpenRouter, even if transcription_provider is openrouter', async () => {
    const config = await loadTranscriptionConfig(
      dbReturning({
        transcription_provider: 'openrouter',
        transcription_api_key: null,
        provider: 'anthropic',
        api_key: 'enc-main-key',
      }),
      'acct',
    )
    expect(config).toBeNull()
  })
})
