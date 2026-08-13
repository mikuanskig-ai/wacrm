import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  callAnthropicTurn,
  seedAnthropicMessages,
  appendAnthropicToolResults,
} from './anthropic'
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

describe('seedAnthropicMessages / appendAnthropicToolResults', () => {
  it('seeds from the plain transcript (no system turn — that is a separate field)', () => {
    const native = seedAnthropicMessages([{ role: 'user', content: 'hi' }])
    expect(native).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('appends a tool_use assistant turn followed by a tool_result user turn', () => {
    const native = seedAnthropicMessages([{ role: 'user', content: 'hi' }])
    const withResults = appendAnthropicToolResults(
      native,
      [{ id: 'call_1', name: 'get_weather', args: { city: 'SP' } }],
      [{ id: 'call_1', content: 'sunny' }],
    )
    expect(withResults).toHaveLength(3)
    expect(withResults[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'SP' } }],
    })
    expect(withResults[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'sunny' }],
    })
  })
})

describe('callAnthropicTurn', () => {
  it('includes tools in the request body when provided, with a cache_control breakpoint on the last one', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ content: [{ type: 'text', text: 'hi' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await callAnthropicTurn({
      apiKey: 'sk-ant-test',
      model: 'claude-test',
      systemPrompt: 'sys',
      nativeMessages: seedAnthropicMessages([{ role: 'user', content: 'hi' }]),
      tools,
      timeoutMs: 1000,
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.tools).toEqual([
      {
        name: 'get_weather',
        description: 'test',
        input_schema: { type: 'object', properties: {} },
        cache_control: { type: 'ephemeral' },
      },
    ])
  })

  it('marks only the LAST tool definition with cache_control, not every one', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ content: [{ type: 'text', text: 'hi' }] }))
    vi.stubGlobal('fetch', fetchMock)
    const twoTools: ProviderToolDef[] = [
      ...tools,
      { name: 'add_to_cart', description: 'test2', parameters: { type: 'object', properties: {} } },
    ]

    await callAnthropicTurn({
      apiKey: 'sk-ant-test',
      model: 'claude-test',
      systemPrompt: 'sys',
      nativeMessages: [],
      tools: twoTools,
      timeoutMs: 1000,
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.tools[0].cache_control).toBeUndefined()
    expect(body.tools[1].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('sends system as a cache_control-marked block when cacheableSystemPrompt is a genuine, long-enough prefix', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ content: [{ type: 'text', text: 'hi' }] }))
    vi.stubGlobal('fetch', fetchMock)
    const stable = 'x'.repeat(5000)
    const dynamic = 'Order so far: Nome Ederson'

    await callAnthropicTurn({
      apiKey: 'sk-ant-test',
      model: 'claude-test',
      systemPrompt: `${stable}\n\n${dynamic}`,
      cacheableSystemPrompt: stable,
      nativeMessages: [],
      tools: [],
      timeoutMs: 1000,
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.system).toEqual([
      { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: `\n\n${dynamic}` },
    ])
  })

  it('falls back to a single uncached system block when cacheableSystemPrompt is too short to be worth caching', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ content: [{ type: 'text', text: 'hi' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await callAnthropicTurn({
      apiKey: 'sk-ant-test',
      model: 'claude-test',
      systemPrompt: 'short system prompt',
      cacheableSystemPrompt: 'short',
      nativeMessages: [],
      tools: [],
      timeoutMs: 1000,
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.system).toEqual([{ type: 'text', text: 'short system prompt' }])
  })

  it('falls back to a single uncached system block when no cacheableSystemPrompt is given at all', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ content: [{ type: 'text', text: 'hi' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await callAnthropicTurn({
      apiKey: 'sk-ant-test',
      model: 'claude-test',
      systemPrompt: 'x'.repeat(5000),
      nativeMessages: [],
      tools: [],
      timeoutMs: 1000,
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.system).toEqual([{ type: 'text', text: 'x'.repeat(5000) }])
  })

  it('parses a tool_use response into the discriminated tool_calls result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'SP' } }],
        }),
      ),
    )

    const result = await callAnthropicTurn({
      apiKey: 'sk-ant-test',
      model: 'claude-test',
      systemPrompt: 'sys',
      nativeMessages: seedAnthropicMessages([{ role: 'user', content: 'hi' }]),
      tools,
      timeoutMs: 1000,
    })

    expect(result).toEqual({
      kind: 'tool_calls',
      calls: [{ id: 'call_1', name: 'get_weather', args: { city: 'SP' } }],
      usage: null,
    })
  })

  it('does NOT throw empty_response for a pure tool_use turn with no text block', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({ content: [{ type: 'tool_use', id: 'call_1', name: 'x', input: {} }] }),
      ),
    )
    await expect(
      callAnthropicTurn({
        apiKey: 'sk-ant-test',
        model: 'claude-test',
        systemPrompt: 'sys',
        nativeMessages: [],
        tools,
        timeoutMs: 1000,
      }),
    ).resolves.toMatchObject({ kind: 'tool_calls' })
  })

  it('still throws empty_response when there is neither text nor a tool_use block', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ content: [] })))
    await expect(
      callAnthropicTurn({
        apiKey: 'sk-ant-test',
        model: 'claude-test',
        systemPrompt: 'sys',
        nativeMessages: [],
        tools: [],
        timeoutMs: 1000,
      }),
    ).rejects.toBeInstanceOf(AiError)
  })

  it('throws malformed_tool_call instead of returning a tool call the model wrote as a text block', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          content: [{ type: 'text', text: '{"name": "add_to_cart", "parameters": {"product_id": "abc"}}' }],
        }),
      ),
    )
    await expect(
      callAnthropicTurn({
        apiKey: 'sk-ant-test',
        model: 'claude-test',
        systemPrompt: 'sys',
        nativeMessages: [],
        tools,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ code: 'malformed_tool_call' })
  })
})
