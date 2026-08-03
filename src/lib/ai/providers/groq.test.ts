import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { callGroqTurn, seedGroqMessages, appendGroqToolResults, generateGroq } from './groq'
import { AiError } from '../types'
import type { ProviderToolDef } from './shared'

function okResponse(json: unknown): Response {
  return { ok: true, status: 200, json: async () => json } as unknown as Response
}

beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
afterEach(() => vi.unstubAllGlobals())

const tools: ProviderToolDef[] = [
  { name: 'get_weather', description: 'test', parameters: { type: 'object', properties: {} } },
]

describe('Groq — shares the OpenAI-compatible wire format at its own base URL', () => {
  it('calls Groq\'s own endpoint, not OpenAI\'s', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ choices: [{ message: { content: 'hi' } }] }))
    vi.stubGlobal('fetch', fetchMock)

    await generateGroq({
      apiKey: 'gsk-test',
      model: 'llama-3.3-70b-versatile',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      timeoutMs: 1000,
    })

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect(opts.headers.Authorization).toBe('Bearer gsk-test')
  })

  it('sends max_tokens, not max_completion_tokens (Groq\'s compat layer expects the older name)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ choices: [{ message: { content: 'hi' } }] }))
    vi.stubGlobal('fetch', fetchMock)

    await callGroqTurn({
      apiKey: 'gsk-test',
      model: 'llama-3.3-70b-versatile',
      nativeMessages: seedGroqMessages('sys', []),
      tools: [],
      timeoutMs: 1000,
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.max_tokens).toBeDefined()
    expect(body.max_completion_tokens).toBeUndefined()
  })

  it('parses a tool_calls response into the discriminated tool_calls result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SP"}' } },
                ],
              },
            },
          ],
        }),
      ),
    )

    const result = await callGroqTurn({
      apiKey: 'gsk-test',
      model: 'llama-3.3-70b-versatile',
      nativeMessages: seedGroqMessages('sys', []),
      tools,
      timeoutMs: 1000,
    })

    expect(result).toMatchObject({
      kind: 'tool_calls',
      calls: [{ id: 'call_1', name: 'get_weather', args: { city: 'SP' } }],
    })
  })

  it('maps a 429 to a rate_limited AiError with Groq named in the message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({ error: { message: 'quota exceeded' } }),
      } as unknown as Response),
    )

    await expect(
      generateGroq({
        apiKey: 'gsk-test',
        model: 'llama-3.3-70b-versatile',
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ code: 'rate_limited' })
  })

  it('appends the assistant tool_calls turn followed by one tool result per call', () => {
    const native = seedGroqMessages('sys', [{ role: 'user', content: 'hi' }])
    const withResults = appendGroqToolResults(
      native,
      [{ id: 'call_1', name: 'get_weather', args: { city: 'SP' } }],
      [{ id: 'call_1', content: 'sunny' }],
    )
    expect(withResults).toHaveLength(4)
    expect(withResults[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'sunny' })
  })

  it('throws empty_response for a genuinely empty final-text turn', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: '' } }] })))
    await expect(
      callGroqTurn({
        apiKey: 'gsk-test',
        model: 'llama-3.3-70b-versatile',
        nativeMessages: seedGroqMessages('sys', []),
        tools: [],
        timeoutMs: 1000,
      }),
    ).rejects.toBeInstanceOf(AiError)
  })
})
