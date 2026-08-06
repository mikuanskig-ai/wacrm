import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { callOpenRouterTurn, seedOpenRouterMessages, appendOpenRouterToolResults, generateOpenRouter } from './openrouter'
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

describe('OpenRouter — shares the OpenAI-compatible wire format at its own base URL', () => {
  it('calls OpenRouter\'s own endpoint, with the underlying model id passed straight through', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ choices: [{ message: { content: 'hi' } }] }))
    vi.stubGlobal('fetch', fetchMock)

    await generateOpenRouter({
      apiKey: 'sk-or-test',
      model: 'anthropic/claude-sonnet-5',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      timeoutMs: 1000,
    })

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(opts.headers.Authorization).toBe('Bearer sk-or-test')
    const body = JSON.parse(opts.body)
    expect(body.model).toBe('anthropic/claude-sonnet-5')
  })

  it('sends max_tokens, not max_completion_tokens', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ choices: [{ message: { content: 'hi' } }] }))
    vi.stubGlobal('fetch', fetchMock)

    await callOpenRouterTurn({
      apiKey: 'sk-or-test',
      model: 'openai/gpt-5.4-mini',
      nativeMessages: seedOpenRouterMessages('sys', []),
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

    const result = await callOpenRouterTurn({
      apiKey: 'sk-or-test',
      model: 'openai/gpt-5.4-mini',
      nativeMessages: seedOpenRouterMessages('sys', []),
      tools,
      timeoutMs: 1000,
    })

    expect(result).toMatchObject({
      kind: 'tool_calls',
      calls: [{ id: 'call_1', name: 'get_weather', args: { city: 'SP' } }],
    })
  })

  it('maps a 401 to an invalid_key AiError with OpenRouter named in the message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: { message: 'Invalid credentials' } }),
      } as unknown as Response),
    )

    await expect(
      generateOpenRouter({
        apiKey: 'bad-key',
        model: 'openai/gpt-5.4-mini',
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ code: 'invalid_key' })
  })

  it('appends the assistant tool_calls turn followed by one tool result per call', () => {
    const native = seedOpenRouterMessages('sys', [{ role: 'user', content: 'hi' }])
    const withResults = appendOpenRouterToolResults(
      native,
      [{ id: 'call_1', name: 'get_weather', args: { city: 'SP' } }],
      [{ id: 'call_1', content: 'sunny' }],
    )
    expect(withResults).toHaveLength(4)
    expect(withResults[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'sunny' })
  })

  it('throws empty_response only after retrying once still comes back empty', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: '' } }] }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      callOpenRouterTurn({
        apiKey: 'sk-or-test',
        model: 'openai/gpt-5.4-mini',
        nativeMessages: seedOpenRouterMessages('sys', []),
        tools: [],
        timeoutMs: 1000,
      }),
    ).rejects.toBeInstanceOf(AiError)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('recovers from a transient empty completion by retrying once — confirmed live, 2026-08-06', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ choices: [{ message: { content: '' } }] }))
      .mockResolvedValueOnce(okResponse({ choices: [{ message: { content: 'Sure, one moment.' } }] }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await callOpenRouterTurn({
      apiKey: 'sk-or-test',
      model: 'openai/gpt-5.6-luna',
      nativeMessages: seedOpenRouterMessages('sys', []),
      tools: [],
      timeoutMs: 1000,
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ kind: 'text', text: 'Sure, one moment.' })
  })
})
