import { describe, expect, it } from 'vitest'
import { isValidStatusTransition, shouldDispatchAiReply } from './inbound-message'

describe('isValidStatusTransition', () => {
  it('allows forward moves along the ladder', () => {
    expect(isValidStatusTransition('pending', 'sent')).toBe(true)
    expect(isValidStatusTransition('sent', 'delivered')).toBe(true)
    expect(isValidStatusTransition('delivered', 'read')).toBe(true)
  })

  it('refuses a backward move', () => {
    expect(isValidStatusTransition('read', 'delivered')).toBe(false)
  })

  it('accepts failed only from pending/sent, and treats it as terminal', () => {
    expect(isValidStatusTransition('pending', 'failed')).toBe(true)
    expect(isValidStatusTransition('sent', 'failed')).toBe(true)
    expect(isValidStatusTransition('delivered', 'failed')).toBe(false)
    expect(isValidStatusTransition('failed', 'sent')).toBe(false)
  })
})

describe('shouldDispatchAiReply', () => {
  const base = { flowConsumed: false, interactiveReplyId: null, inboundText: 'oi', contentType: 'text' }

  it('dispatches for an ordinary text message', () => {
    expect(shouldDispatchAiReply(base)).toBe(true)
  })

  it('dispatches for location and (transcribed) audio — the model can see both', () => {
    expect(shouldDispatchAiReply({ ...base, contentType: 'location' })).toBe(true)
    expect(shouldDispatchAiReply({ ...base, contentType: 'audio' })).toBe(true)
  })

  it('refuses a document even though its filename gives it non-blank text — regression, 2026-09-04 (Concórdia, Alzira Y. de Oliveira: a payment-receipt PDF triggered a dispatch the model could not actually see, and it cancelled + recreated a valid order)', () => {
    expect(
      shouldDispatchAiReply({ ...base, contentType: 'document', inboundText: 'comprovante.pdf' }),
    ).toBe(false)
  })

  it('refuses image/video/template/interactive the same way', () => {
    for (const contentType of ['image', 'video', 'template', 'interactive']) {
      expect(shouldDispatchAiReply({ ...base, contentType })).toBe(false)
    }
  })

  it('refuses when a flow already consumed the message', () => {
    expect(shouldDispatchAiReply({ ...base, flowConsumed: true })).toBe(false)
  })

  it('refuses an interactive button/list reply', () => {
    expect(shouldDispatchAiReply({ ...base, interactiveReplyId: 'reply-1' })).toBe(false)
  })

  it('refuses blank/whitespace-only text', () => {
    expect(shouldDispatchAiReply({ ...base, inboundText: '   ' })).toBe(false)
  })
})
