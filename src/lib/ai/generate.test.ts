import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateReply, generateReplyWithTools, parseGeneration } from './generate'
import { AiError, type AiConfig } from './types'
import { __resetRateLimitForTests, checkRateLimit } from '@/lib/rate-limit'
import type { ToolDefinition, ToolContext } from './tools/types'

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    toolsEnabled: false,
    ...overrides,
  }
}

function okResponse(json: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => json,
  } as unknown as Response
}

function errResponse(status: number, json: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => json,
  } as unknown as Response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
  __resetRateLimitForTests()
})
afterEach(() => vi.unstubAllGlobals())

const generousRateLimit = { key: 'test', options: { limit: 1000, windowMs: 60_000 } }

const fakeToolContext = {} as ToolContext

function fakeTool(
  name: string,
  execute: ToolDefinition['execute'],
): ToolDefinition {
  return { name, description: 'test tool', parameters: { type: 'object', properties: {} }, execute }
}

function openAiToolCallResponse(calls: { id: string; name: string; args: unknown }[]): Response {
  return okResponse({
    choices: [
      {
        message: {
          content: null,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        },
      },
    ],
  })
}

describe('parseGeneration', () => {
  it('returns text with no handoff', () => {
    expect(parseGeneration('Hello there')).toEqual({
      text: 'Hello there',
      handoff: false,
      usage: null,
    })
  })

  it('detects + strips the handoff sentinel', () => {
    expect(parseGeneration('[[HANDOFF]]')).toEqual({
      text: '',
      handoff: true,
      usage: null,
    })
    expect(parseGeneration('Let me get a human [[HANDOFF]]')).toEqual({
      text: 'Let me get a human',
      handoff: true,
      usage: null,
    })
  })

  it('passes usage straight through', () => {
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
    expect(parseGeneration('Hi', usage)).toEqual({
      text: 'Hi',
      handoff: false,
      usage,
    })
  })
})

describe('generateReply — OpenAI', () => {
  it('calls the chat completions endpoint and returns the reply', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        choices: [{ message: { content: 'Sure — happy to help!' } }],
        usage: { prompt_tokens: 42, completion_tokens: 8, total_tokens: 50 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hi' }],
    })

    expect(res).toEqual({
      text: 'Sure — happy to help!',
      handoff: false,
      usage: { promptTokens: 42, completionTokens: 8, totalTokens: 50 },
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.openai.com')
    expect(opts.headers.Authorization).toBe('Bearer sk-test')
  })

  it('maps a 401 to an invalid_key AiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errResponse(401, { error: { message: 'Incorrect API key' } }),
      ),
    )

    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_key', status: 401 })
  })

  it('throws on an empty completion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: '' } }] })),
    )
    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toBeInstanceOf(AiError)
  })
})

describe('generateReply — Anthropic', () => {
  it('calls the messages endpoint with the version header and parses text blocks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        content: [{ type: 'text', text: 'Hi there!' }],
        usage: { input_tokens: 30, output_tokens: 6 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'anthropic', apiKey: 'sk-ant-x' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hello' }],
    })

    // Anthropic reports input/output only — total is summed by normalizeUsage.
    expect(res).toEqual({
      text: 'Hi there!',
      handoff: false,
      usage: { promptTokens: 30, completionTokens: 6, totalTokens: 36 },
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.anthropic.com')
    expect(opts.headers['x-api-key']).toBe('sk-ant-x')
    expect(opts.headers['anthropic-version']).toBeTruthy()
  })

  it('detects handoff in the model output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({ content: [{ type: 'text', text: '[[HANDOFF]]' }] }),
      ),
    )
    const res = await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'I want to speak to a person' }],
    })
    expect(res.handoff).toBe(true)
    expect(res.text).toBe('')
  })

  it('drops a leading assistant turn so the payload starts on the customer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ content: [{ type: 'text', text: 'ok' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [
        { role: 'assistant', content: 'Welcome!' },
        { role: 'user', content: 'Hi' },
      ],
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[0].role).toBe('user')
    expect(body.messages).toHaveLength(1)
  })
})

describe('generateReplyWithTools', () => {
  it('executes a requested tool call, then returns the final text on the next round-trip', async () => {
    const execute = vi.fn().mockResolvedValue({ content: 'It is sunny.' })
    const tool = fakeTool('get_weather', execute)

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(openAiToolCallResponse([{ id: 'call_1', name: 'get_weather', args: { city: 'SP' } }]))
      .mockResolvedValueOnce(
        okResponse({ choices: [{ message: { content: 'It is sunny in São Paulo!' } }] }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReplyWithTools({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: "What's the weather?" }],
      tools: [tool],
      toolContext: fakeToolContext,
      rateLimit: generousRateLimit,
    })

    expect(execute).toHaveBeenCalledWith({ city: 'SP' }, fakeToolContext)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(res.text).toBe('It is sunny in São Paulo!')
    expect(res.placedOrder).toBeUndefined()
  })

  it('stops after MAX_TOOL_ITERATIONS round-trips and hands off rather than looping forever', async () => {
    const tool = fakeTool('noop', vi.fn().mockResolvedValue({ content: 'ok' }))
    const fetchMock = vi
      .fn()
      .mockResolvedValue(openAiToolCallResponse([{ id: 'call_x', name: 'noop', args: {} }]))
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReplyWithTools({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'loop forever' }],
      tools: [tool],
      toolContext: fakeToolContext,
      rateLimit: generousRateLimit,
    })

    expect(fetchMock).toHaveBeenCalledTimes(6) // MAX_TOOL_ITERATIONS
    expect(res.text).toBe('')
    expect(res.handoff).toBe(true)
  })

  it('short-circuits on a successful place_order without a further provider round-trip', async () => {
    const placedOrder = {
      id: 'order-1',
      total: 42,
      currency: 'BRL',
      items: [{ product_name: 'Pizza', quantity: 1, line_total: 42 }],
    }
    const execute = vi.fn().mockResolvedValue({ content: 'Order placed.', data: placedOrder })
    const tool = fakeTool('place_order', execute)

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(openAiToolCallResponse([{ id: 'call_po', name: 'place_order', args: {} }]))
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReplyWithTools({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'yes, confirm' }],
      tools: [tool],
      toolContext: fakeToolContext,
      rateLimit: generousRateLimit,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(res.placedOrder).toEqual(placedOrder)
  })

  it('reports rateLimited (not handoff) when the account throttle trips mid-loop', async () => {
    const tool = fakeTool('noop', vi.fn().mockResolvedValue({ content: 'ok' }))
    const fetchMock = vi.fn() // should never be called — throttled before the first call
    vi.stubGlobal('fetch', fetchMock)

    const rateLimit = { key: 'throttled-test', options: { limit: 1, windowMs: 60_000 } }
    // Exhaust the single slot before the loop ever runs, so its very
    // first internal check is the one that trips.
    checkRateLimit(rateLimit.key, rateLimit.options)

    const res = await generateReplyWithTools({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [tool],
      toolContext: fakeToolContext,
      rateLimit,
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(res.rateLimited).toBe(true)
    expect(res.handoff).toBe(false)
  })
})
