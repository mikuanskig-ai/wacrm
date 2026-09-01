import { describe, it, expect } from 'vitest'
import { latestUserMessage, retrievalQueryText } from './query'

describe('latestUserMessage', () => {
  it('returns the most recent user turn', () => {
    expect(
      latestUserMessage([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'latest' },
      ]),
    ).toBe('latest')
  })

  it('falls back to the last message when none are user', () => {
    expect(
      latestUserMessage([{ role: 'assistant', content: 'only assistant' }]),
    ).toBe('only assistant')
  })

  it('returns empty string for no messages', () => {
    expect(latestUserMessage([])).toBe('')
  })
})

describe('retrievalQueryText', () => {
  it('prepends the assistant\'s prior message to a bare confirmation — regression, 2026-09-01 (Churrascaria Concórdia)', () => {
    // Live incident: a customer replied "sim" to the bot's own "quer
    // que eu te passe os horários?" offer. Retrieval against "sim"
    // alone matched nothing in the knowledge base (which had the real
    // hours), so the model fabricated a schedule from scratch instead
    // of admitting it had nothing to go on.
    const query = retrievalQueryText([
      { role: 'user', content: 'Olá! No sábado e domingo abre pra rodízio?' },
      { role: 'assistant', content: 'Sim 😊 Se quiser, também te passo os horários.' },
      { role: 'user', content: 'sim' },
    ])
    expect(query).toContain('horários')
    expect(query).toContain('sim')
  })

  it('falls back to just the latest user message when there is no assistant turn yet', () => {
    expect(
      retrievalQueryText([{ role: 'user', content: 'Qual o horário de funcionamento?' }]),
    ).toBe('Qual o horário de funcionamento?')
  })

  it('returns empty string for no messages', () => {
    expect(retrievalQueryText([])).toBe('')
  })
})
