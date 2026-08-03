import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  callOpenAiTurn,
  seedOpenAiMessages,
  appendOpenAiToolResults,
} from './openai'
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

describe('seedOpenAiMessages / appendOpenAiToolResults', () => {
  it('seeds with a system turn followed by the merged transcript', () => {
    const native = seedOpenAiMessages('sys', [{ role: 'user', content: 'hi' }])
    expect(native).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ])
  })

  it('appends the assistant tool_calls turn followed by one tool result per call', () => {
    const native = seedOpenAiMessages('sys', [{ role: 'user', content: 'hi' }])
    const withResults = appendOpenAiToolResults(
      native,
      [{ id: 'call_1', name: 'get_weather', args: { city: 'SP' } }],
      [{ id: 'call_1', content: 'sunny' }],
    )
    expect(withResults).toHaveLength(4)
    expect(withResults[2]).toMatchObject({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', function: { name: 'get_weather' } }],
    })
    expect(withResults[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'sunny' })
  })
})

describe('callOpenAiTurn', () => {
  it('includes tools in the request body when provided', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ choices: [{ message: { content: 'hi' } }] }))
    vi.stubGlobal('fetch', fetchMock)

    await callOpenAiTurn({
      apiKey: 'sk-test',
      model: 'gpt-test',
      nativeMessages: seedOpenAiMessages('sys', []),
      tools,
      timeoutMs: 1000,
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'get_weather', description: 'test', parameters: { type: 'object', properties: {} } } },
    ])
  })

  it('omits tools from the payload when none are passed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ choices: [{ message: { content: 'hi' } }] }))
    vi.stubGlobal('fetch', fetchMock)

    await callOpenAiTurn({
      apiKey: 'sk-test',
      model: 'gpt-test',
      nativeMessages: seedOpenAiMessages('sys', []),
      tools: [],
      timeoutMs: 1000,
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.tools).toBeUndefined()
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

    const result = await callOpenAiTurn({
      apiKey: 'sk-test',
      model: 'gpt-test',
      nativeMessages: seedOpenAiMessages('sys', []),
      tools,
      timeoutMs: 1000,
    })

    expect(result).toMatchObject({
      kind: 'tool_calls',
      calls: [{ id: 'call_1', name: 'get_weather', args: { city: 'SP' } }],
    })
  })

  it('does NOT throw empty_response for a pure tool_calls turn with no content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'x', arguments: '{}' } }],
              },
            },
          ],
        }),
      ),
    )
    await expect(
      callOpenAiTurn({
        apiKey: 'sk-test',
        model: 'gpt-test',
        nativeMessages: seedOpenAiMessages('sys', []),
        tools,
        timeoutMs: 1000,
      }),
    ).resolves.toMatchObject({ kind: 'tool_calls' })
  })

  it('still throws empty_response for a genuinely empty final-text turn', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: '' } }] })))
    await expect(
      callOpenAiTurn({
        apiKey: 'sk-test',
        model: 'gpt-test',
        nativeMessages: seedOpenAiMessages('sys', []),
        tools: [],
        timeoutMs: 1000,
      }),
    ).rejects.toBeInstanceOf(AiError)
  })

  it('throws malformed_tool_call instead of returning a tool call the model wrote as plain content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          choices: [{ message: { content: '{"name": "add_to_cart", "parameters": {"product_id": "abc"}}' } }],
        }),
      ),
    )
    await expect(
      callOpenAiTurn({
        apiKey: 'sk-test',
        model: 'gpt-test',
        nativeMessages: seedOpenAiMessages('sys', []),
        tools,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ code: 'malformed_tool_call' })
  })
})
