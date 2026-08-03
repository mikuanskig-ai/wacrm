import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  callGeminiTurn,
  seedGeminiMessages,
  appendGeminiToolResults,
} from './gemini'
import { AiError } from '../types'
import type { ProviderToolDef } from './shared'

function okResponse(json: unknown): Response {
  return { ok: true, status: 200, json: async () => json } as unknown as Response
}

beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
afterEach(() => vi.unstubAllGlobals())

const tools: ProviderToolDef[] = [
  {
    name: 'get_weather',
    description: 'test',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
]

describe('seedGeminiMessages / appendGeminiToolResults', () => {
  it('seeds from the plain transcript, mapping assistant to model (no system turn)', () => {
    const native = seedGeminiMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])
    expect(native).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello' }] },
    ])
  })

  it('appends a functionCall model turn followed by a functionResponse user turn', () => {
    const native = seedGeminiMessages([{ role: 'user', content: 'hi' }])
    const withResults = appendGeminiToolResults(
      native,
      [{ id: 'call-0', name: 'get_weather', args: { city: 'SP' } }],
      [{ id: 'call-0', content: 'sunny' }],
    )
    expect(withResults).toHaveLength(3)
    expect(withResults[1]).toEqual({
      role: 'model',
      parts: [{ functionCall: { name: 'get_weather', args: { city: 'SP' } } }],
    })
    expect(withResults[2]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { name: 'get_weather', response: { content: 'sunny' } } }],
    })
  })
})

describe('callGeminiTurn', () => {
  it('includes tools as functionDeclarations in the request body when provided', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }))
    vi.stubGlobal('fetch', fetchMock)

    await callGeminiTurn({
      apiKey: 'gem-test',
      model: 'gemini-test',
      systemPrompt: 'sys',
      nativeMessages: seedGeminiMessages([{ role: 'user', content: 'hi' }]),
      tools,
      timeoutMs: 1000,
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          { name: 'get_weather', description: 'test', parameters: { type: 'object', properties: {} } },
        ],
      },
    ])
  })

  // Regression: Gemini's function-calling schema is a restricted OpenAPI
  // subset that 400s on any JSON-Schema keyword it doesn't recognize —
  // observed live as "Unknown name \"additionalProperties\" ... Cannot
  // find field" once tool-calling shipped for real accounts.
  it('strips additionalProperties from tool parameters before sending to Gemini', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }))
    vi.stubGlobal('fetch', fetchMock)

    await callGeminiTurn({
      apiKey: 'gem-test',
      model: 'gemini-test',
      systemPrompt: 'sys',
      nativeMessages: seedGeminiMessages([{ role: 'user', content: 'hi' }]),
      tools,
      timeoutMs: 1000,
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.tools[0].functionDeclarations[0].parameters).not.toHaveProperty('additionalProperties')
  })

  it('parses a functionCall response into the discriminated tool_calls result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          candidates: [
            { content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'SP' } } }] } },
          ],
        }),
      ),
    )

    const result = await callGeminiTurn({
      apiKey: 'gem-test',
      model: 'gemini-test',
      systemPrompt: 'sys',
      nativeMessages: seedGeminiMessages([{ role: 'user', content: 'hi' }]),
      tools,
      timeoutMs: 1000,
    })

    expect(result).toEqual({
      kind: 'tool_calls',
      calls: [{ id: 'call-0', name: 'get_weather', args: { city: 'SP' } }],
      usage: null,
    })
  })

  it('does NOT throw empty_response for a pure functionCall turn with no text part', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          candidates: [{ content: { parts: [{ functionCall: { name: 'x', args: {} } }] } }],
        }),
      ),
    )
    await expect(
      callGeminiTurn({
        apiKey: 'gem-test',
        model: 'gemini-test',
        systemPrompt: 'sys',
        nativeMessages: [],
        tools,
        timeoutMs: 1000,
      }),
    ).resolves.toMatchObject({ kind: 'tool_calls' })
  })

  it('still throws empty_response when there is neither text nor a functionCall part', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ candidates: [{ content: { parts: [] } }] })),
    )
    await expect(
      callGeminiTurn({
        apiKey: 'gem-test',
        model: 'gemini-test',
        systemPrompt: 'sys',
        nativeMessages: [],
        tools: [],
        timeoutMs: 1000,
      }),
    ).rejects.toBeInstanceOf(AiError)
  })

  it('throws malformed_tool_call instead of returning a tool call the model wrote as plain text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          candidates: [
            { content: { parts: [{ text: '{"name": "add_to_cart", "parameters": {"product_id": "abc"}}' }] } },
          ],
        }),
      ),
    )
    await expect(
      callGeminiTurn({
        apiKey: 'gem-test',
        model: 'gemini-test',
        systemPrompt: 'sys',
        nativeMessages: [],
        tools,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ code: 'malformed_tool_call' })
  })
})
