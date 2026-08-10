import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { transcribeAudio } from './transcription'
import { AiError } from './types'

beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
afterEach(() => vi.unstubAllGlobals())

describe('transcribeAudio', () => {
  it('posts multipart form data to the Groq endpoint with the whisper-large-v3-turbo model', async () => {
    const fetchMock = vi.fn(async (_url: string, opts: { body: FormData; headers: Record<string, string> }) => {
      expect(opts.body.get('model')).toBe('whisper-large-v3-turbo')
      expect(opts.headers.Authorization).toBe('Bearer gsk_x')
      return { ok: true, status: 200, json: async () => ({ text: 'quero uma marmita grande' }) } as unknown as Response
    })
    vi.stubGlobal('fetch', fetchMock)

    const text = await transcribeAudio('groq', 'gsk_x', Buffer.from('fake-audio'), 'audio/ogg')
    expect(text).toBe('quero uma marmita grande')
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions')
  })

  it('posts to the OpenAI endpoint with the whisper-1 model', async () => {
    const fetchMock = vi.fn(async (_url: string, opts: { body: FormData }) => {
      expect(opts.body.get('model')).toBe('whisper-1')
      return { ok: true, status: 200, json: async () => ({ text: 'oi' }) } as unknown as Response
    })
    vi.stubGlobal('fetch', fetchMock)

    await transcribeAudio('openai', 'sk-x', Buffer.from('fake-audio'), 'audio/ogg')
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions')
  })

  it('posts to the OpenRouter endpoint with the openai/whisper-1 model', async () => {
    const fetchMock = vi.fn(async (_url: string, opts: { body: FormData; headers: Record<string, string> }) => {
      expect(opts.body.get('model')).toBe('openai/whisper-1')
      expect(opts.headers.Authorization).toBe('Bearer sk-or-x')
      return { ok: true, status: 200, json: async () => ({ text: 'oi' }) } as unknown as Response
    })
    vi.stubGlobal('fetch', fetchMock)

    await transcribeAudio('openrouter', 'sk-or-x', Buffer.from('fake-audio'), 'audio/ogg')
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('https://openrouter.ai/api/v1/audio/transcriptions')
  })

  it('returns null for empty/near-silent audio rather than throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ text: '   ' }) } as unknown as Response),
    )
    expect(await transcribeAudio('groq', 'gsk_x', Buffer.from('x'), 'audio/ogg')).toBeNull()
  })

  it('maps a 401 to an invalid_key AiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: { message: 'bad key' } }),
      } as unknown as Response),
    )
    await expect(transcribeAudio('groq', 'bad-key', Buffer.from('x'), 'audio/ogg')).rejects.toMatchObject({
      code: 'invalid_key',
    })
  })

  it('wraps a network failure as an AiError instead of throwing raw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('fetch failed')),
    )
    await expect(transcribeAudio('groq', 'gsk_x', Buffer.from('x'), 'audio/ogg')).rejects.toBeInstanceOf(AiError)
  })
})
