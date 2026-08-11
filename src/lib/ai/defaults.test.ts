import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from './defaults'

describe('buildSystemPrompt — today line', () => {
  // Confirmed live 2026-08-11: the model had no way to know what day
  // "today" is when answering from the knowledge base (as opposed to a
  // tool call, which resolves day-of-week pricing server-side) — see
  // defaults.ts's doc comment. These lock in the injected date line.

  it('states the correct weekday and ISO date for the given timezone', () => {
    // 2026-08-16 is a Sunday.
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'draft',
      timezone: 'America/Sao_Paulo',
      now: new Date('2026-08-16T15:00:00Z'), // 12:00 in São Paulo (UTC-3), still Sunday there
    })
    expect(prompt).toContain('Today is Sunday, 2026-08-16')
  })

  it('uses the given timezone, not UTC, when they disagree on the date', () => {
    // 2026-08-16T01:00:00Z is Aug 15 22:00 in São Paulo (UTC-3) — still Saturday there.
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'draft',
      timezone: 'America/Sao_Paulo',
      now: new Date('2026-08-16T01:00:00Z'),
    })
    expect(prompt).toContain('Today is Saturday, 2026-08-15')
  })

  it('defaults to America/Sao_Paulo when no timezone is given', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'draft',
      now: new Date('2026-08-16T15:00:00Z'),
    })
    expect(prompt).toContain('Today is Sunday, 2026-08-16')
  })
})
