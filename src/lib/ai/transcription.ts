import { aiRequestTimeoutMs } from './defaults'
import { providerHttpError, toNetworkError } from './providers/shared'

// ============================================================
// Audio transcription (Whisper-compatible). Optional, independent BYO
// key — see ai_configs.transcription_provider/transcription_api_key
// (migration 069) and config.ts's loadTranscriptionConfig. Groq's
// whisper-large-v3-turbo is the recommended default (far cheaper and
// faster than OpenAI, strong Portuguese support); OpenAI's whisper-1
// works under the identical multipart request shape.
// ============================================================

export type TranscriptionProvider = 'groq' | 'openai'

const ENDPOINTS: Record<TranscriptionProvider, string> = {
  groq: 'https://api.groq.com/openai/v1/audio/transcriptions',
  openai: 'https://api.openai.com/v1/audio/transcriptions',
}

const MODELS: Record<TranscriptionProvider, string> = {
  groq: 'whisper-large-v3-turbo',
  openai: 'whisper-1',
}

const PROVIDER_LABELS: Record<TranscriptionProvider, string> = {
  groq: 'Groq',
  openai: 'OpenAI',
}

interface TranscriptionResponse {
  text?: string
}

/**
 * Transcribes one audio file. Returns the transcript text, or null
 * when the provider returned nothing usable (empty/near-silent audio
 * — not an error, just nothing said). Throws on a real provider/
 * network failure — the caller (the WhatsApp webhook) is expected to
 * catch and log rather than let this block the inbound message from
 * being stored, same "never blocks the main flow" contract as the
 * rest of the media-download path around it.
 */
export async function transcribeAudio(
  provider: TranscriptionProvider,
  apiKey: string,
  audio: Buffer,
  mimetype: string,
): Promise<string | null> {
  const timeoutMs = aiRequestTimeoutMs()
  const ext = mimetype.split('/')[1]?.split(';')[0] || 'ogg'
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(audio)], { type: mimetype }), `audio.${ext}`)
  form.append('model', MODELS[provider])

  let res: Response
  try {
    res = await fetch(ENDPOINTS[provider], {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError(PROVIDER_LABELS[provider], res)
  }

  const data = (await res.json().catch(() => null)) as TranscriptionResponse | null
  const text = data?.text?.trim()
  return text ? text : null
}
