import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildConversationContext } from './context'

/** Minimal fake matching the query chain in buildConversationContext:
 *  from().select().eq().in().order().limit() → { data, error }. */
function fakeDb(rows: unknown[]): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: rows, error: null }),
  }
  return chain as unknown as SupabaseClient
}

describe('buildConversationContext', () => {
  it('maps sender_type to role and returns chronological order', async () => {
    // DB returns newest-first (created_at DESC); the fn reverses it.
    const rows = [
      { sender_type: 'customer', content_text: 'third', content_type: 'text' },
      { sender_type: 'agent', content_text: 'second', content_type: 'text' },
      { sender_type: 'customer', content_text: 'first', content_type: 'text' },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(out).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ])
  })

  it('treats bot messages as assistant', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'bot', content_text: 'auto reply', content_type: 'text' }]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'assistant', content: 'auto reply' }])
  })

  it('drops empty / whitespace-only messages', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_text: '   ', content_type: 'text' },
        { sender_type: 'customer', content_text: null, content_type: 'text' },
        { sender_type: 'customer', content_text: 'real', content_type: 'text' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'real' }])
  })

  it('includes a location share, reformatted so the model recognizes it as coordinates to act on — regression, 2026-08-07', async () => {
    // Live incident: a customer dropped a WhatsApp location pin, but
    // location messages were excluded from context entirely — the
    // model had no idea one had been sent and just asked for a typed
    // address instead.
    const out = await buildConversationContext(
      fakeDb([
        {
          sender_type: 'customer',
          content_text: '-24.9532935,-53.4699534',
          content_type: 'location',
        },
      ]),
      'conv-1',
    )
    expect(out).toEqual([
      { role: 'user', content: '[Customer shared their location] latitude=-24.9532935, longitude=-53.4699534' },
    ])
  })

  it('falls back to the raw text when a location message does not parse as coordinates', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'customer', content_text: 'Minha Padaria', content_type: 'location' }]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: '[Customer shared their location] Minha Padaria' }])
  })

  it('includes a transcribed voice note (content_text filled in by the webhook) as a normal user message', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'customer', content_text: 'quero uma marmita grande', content_type: 'audio' }]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'quero uma marmita grande' }])
  })

  it('drops an untranscribed voice note (content_text still null) same as any other media', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_text: null, content_type: 'audio' },
        { sender_type: 'customer', content_text: 'depois disso', content_type: 'text' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'depois disso' }])
  })
})
