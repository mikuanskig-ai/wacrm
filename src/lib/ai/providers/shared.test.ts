import { describe, it, expect } from 'vitest'
import { looksLikeLeakedToolCall, guardAgainstLeakedToolCall } from './shared'
import { AiError } from '../types'

describe('looksLikeLeakedToolCall', () => {
  it('flags a tool call written as content instead of a real reply, prose included (observed live)', () => {
    expect(
      looksLikeLeakedToolCall(
        'Ok, então você quer uma pizza e uma coca. Vou adicionar ao carrinho. {"name": "add_to_cart", "parameters": {"product_id": "abc", "quantity": "1"}}',
      ),
    ).toBe(true)
  })

  it('flags a bare tool-call JSON object (name + parameters)', () => {
    expect(
      looksLikeLeakedToolCall('{"name": "add_to_cart", "parameters": {"product_id": "abc", "quantity": "1"}}'),
    ).toBe(true)
  })

  it('flags the "arguments" spelling too', () => {
    expect(looksLikeLeakedToolCall('{"name": "search_menu", "arguments": {"query": "pizza"}}')).toBe(true)
  })

  it('tolerates surrounding whitespace', () => {
    expect(looksLikeLeakedToolCall('  \n{"name": "view_cart", "parameters": {}}\n  ')).toBe(true)
  })

  it('does not flag ordinary customer-facing text', () => {
    expect(looksLikeLeakedToolCall('Claro! Temos pizza, pizza 2 e coca 350ml. Qual você quer?')).toBe(false)
  })

  it('does not flag text that merely contains braces', () => {
    expect(looksLikeLeakedToolCall('O preço é R$42 {promoção válida hoje}')).toBe(false)
  })

  it('does not flag a JSON object missing "name"', () => {
    expect(looksLikeLeakedToolCall('{"parameters": {"product_id": "abc"}}')).toBe(false)
  })

  it('does not flag a JSON object missing parameters/arguments', () => {
    expect(looksLikeLeakedToolCall('{"name": "add_to_cart"}')).toBe(false)
  })

  it('flags the "function=name {args}" shape (observed live, a smaller Llama model via Groq)', () => {
    expect(looksLikeLeakedToolCall('function=search_menu {"query": "marmitas"}')).toBe(true)
  })

  it('flags "function=name {args}" with prose around it too', () => {
    expect(
      looksLikeLeakedToolCall('Deixa eu ver isso pra você. function=search_menu {"query": "marmitas"} Um instante!'),
    ).toBe(true)
  })

  it('does not flag ordinary text that happens to contain the word "function"', () => {
    expect(looksLikeLeakedToolCall('Essa função de busca do site está ótima, obrigado pela pergunta!')).toBe(false)
  })

  it('does not flag invalid JSON', () => {
    expect(looksLikeLeakedToolCall('{"name": "add_to_cart", "parameters": {')).toBe(false)
  })
})

describe('guardAgainstLeakedToolCall', () => {
  it('throws a malformed_tool_call AiError for a leaked tool call', () => {
    expect(() =>
      guardAgainstLeakedToolCall('Groq', '{"name": "place_order", "parameters": {}}'),
    ).toThrow(AiError)
    try {
      guardAgainstLeakedToolCall('Groq', '{"name": "place_order", "parameters": {}}')
    } catch (err) {
      expect(err).toBeInstanceOf(AiError)
      expect((err as AiError).code).toBe('malformed_tool_call')
      expect((err as AiError).message).toContain('Groq')
    }
  })

  it('does nothing for a normal reply', () => {
    expect(() => guardAgainstLeakedToolCall('Groq', 'Claro, já te ajudo!')).not.toThrow()
  })
})
