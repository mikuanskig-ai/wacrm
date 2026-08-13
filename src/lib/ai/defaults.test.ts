import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from './defaults'

describe('buildSystemPrompt — today line', () => {
  // Confirmed live 2026-08-11: the model had no way to know what day
  // "today" is when answering from the knowledge base (as opposed to a
  // tool call, which resolves day-of-week pricing server-side) — see
  // defaults.ts's doc comment. These lock in the injected date line.

  it('states the correct weekday and ISO date for the given timezone', () => {
    // 2026-08-16 is a Sunday.
    const { text } = buildSystemPrompt({
      userPrompt: null,
      mode: 'draft',
      timezone: 'America/Sao_Paulo',
      now: new Date('2026-08-16T15:00:00Z'), // 12:00 in São Paulo (UTC-3), still Sunday there
    })
    expect(text).toContain('Today is Sunday, 2026-08-16')
  })

  it('uses the given timezone, not UTC, when they disagree on the date', () => {
    // 2026-08-16T01:00:00Z is Aug 15 22:00 in São Paulo (UTC-3) — still Saturday there.
    const { text } = buildSystemPrompt({
      userPrompt: null,
      mode: 'draft',
      timezone: 'America/Sao_Paulo',
      now: new Date('2026-08-16T01:00:00Z'),
    })
    expect(text).toContain('Today is Saturday, 2026-08-15')
  })

  it('defaults to America/Sao_Paulo when no timezone is given', () => {
    const { text } = buildSystemPrompt({
      userPrompt: null,
      mode: 'draft',
      now: new Date('2026-08-16T15:00:00Z'),
    })
    expect(text).toContain('Today is Sunday, 2026-08-16')
  })
})

describe('buildSystemPrompt — daily menu', () => {
  it("includes today's menu text when given", () => {
    const { text } = buildSystemPrompt({
      userPrompt: null,
      mode: 'draft',
      dailyMenu: 'Feijoada, arroz, farofa e couve',
    })
    expect(text).toContain('Feijoada, arroz, farofa e couve')
  })

  it('omits the menu section entirely when not given', () => {
    const { text } = buildSystemPrompt({ userPrompt: null, mode: 'draft' })
    expect(text).not.toContain("today's menu")
  })

  it('omits the menu section for an empty/whitespace-only string', () => {
    const { text } = buildSystemPrompt({ userPrompt: null, mode: 'draft', dailyMenu: '   ' })
    expect(text).not.toContain("today's menu")
  })
})

describe('buildSystemPrompt — cacheableText (prompt-caching split)', () => {
  // Confirmed live 2026-08-12: 98%+ of this account's daily AI spend
  // was input tokens, not output — the system prompt + tools get
  // resent in full on every single call. cacheableText exists so a
  // provider with explicit prompt caching (Anthropic — see
  // providers/anthropic.ts) can mark it once and pay full price on
  // only the per-turn tail (order state, knowledge) from then on.

  it('is a strict, non-empty prefix of the full text', () => {
    const { text, cacheableText } = buildSystemPrompt({
      userPrompt: 'Somos uma churrascaria.',
      mode: 'auto_reply',
      toolsActive: true,
      orderState: 'Nome: Ederson',
      knowledge: ['Horário: 11h às 22h'],
    })
    expect(cacheableText.length).toBeGreaterThan(0)
    expect(text.startsWith(cacheableText)).toBe(true)
    expect(text.length).toBeGreaterThan(cacheableText.length)
  })

  it('includes the business\'s own custom prompt (stable per account, safe to cache)', () => {
    const { cacheableText } = buildSystemPrompt({
      userPrompt: 'Somos uma churrascaria em Concórdia.',
      mode: 'auto_reply',
      toolsActive: true,
      orderState: 'Nome: Ederson',
    })
    expect(cacheableText).toContain('Somos uma churrascaria em Concórdia.')
  })

  it('excludes order state and knowledge-base excerpts — both change every turn/question', () => {
    const { cacheableText } = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      toolsActive: true,
      orderState: 'Nome: Ederson, Endereco: Rua X',
      knowledge: ['Preço do rodízio: R$ 45'],
    })
    expect(cacheableText).not.toContain('Nome: Ederson')
    expect(cacheableText).not.toContain('Preço do rodízio')
  })

  it('equals the full text when there is nothing dynamic to append', () => {
    const { text, cacheableText } = buildSystemPrompt({ userPrompt: null, mode: 'draft' })
    expect(cacheableText).toBe(text)
  })
})
