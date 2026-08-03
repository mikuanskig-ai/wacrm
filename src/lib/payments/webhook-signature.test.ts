import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyMercadoPagoWebhookSignature } from './webhook-signature'

const SECRET = 'test-webhook-secret'

function signedHeader(args: {
  dataId: string
  requestId: string
  ts?: string
  secret?: string
}): string {
  const ts = args.ts ?? '1704908010'
  const secret = args.secret ?? SECRET
  const manifest = `id:${args.dataId};request-id:${args.requestId};ts:${ts};`
  const v1 = crypto.createHmac('sha256', secret).update(manifest).digest('hex')
  return `ts=${ts},v1=${v1}`
}

describe('verifyMercadoPagoWebhookSignature', () => {
  it('accepts a request signed with the correct secret', () => {
    const xSignature = signedHeader({ dataId: '123456', requestId: 'req-1' })
    expect(
      verifyMercadoPagoWebhookSignature({
        xSignature,
        xRequestId: 'req-1',
        dataId: '123456',
        secret: SECRET,
      }),
    ).toBe(true)
  })

  it('rejects a signature computed with a different secret', () => {
    const xSignature = signedHeader({ dataId: '123456', requestId: 'req-1', secret: 'wrong' })
    expect(
      verifyMercadoPagoWebhookSignature({
        xSignature,
        xRequestId: 'req-1',
        dataId: '123456',
        secret: SECRET,
      }),
    ).toBe(false)
  })

  it('rejects when the data id has been swapped after signing', () => {
    const xSignature = signedHeader({ dataId: '123456', requestId: 'req-1' })
    expect(
      verifyMercadoPagoWebhookSignature({
        xSignature,
        xRequestId: 'req-1',
        dataId: '999999',
        secret: SECRET,
      }),
    ).toBe(false)
  })

  it('rejects when the request id has been swapped after signing', () => {
    const xSignature = signedHeader({ dataId: '123456', requestId: 'req-1' })
    expect(
      verifyMercadoPagoWebhookSignature({
        xSignature,
        xRequestId: 'req-2',
        dataId: '123456',
        secret: SECRET,
      }),
    ).toBe(false)
  })

  it('rejects a missing x-signature header', () => {
    expect(
      verifyMercadoPagoWebhookSignature({
        xSignature: null,
        xRequestId: 'req-1',
        dataId: '123456',
        secret: SECRET,
      }),
    ).toBe(false)
  })

  it('rejects a missing x-request-id header', () => {
    const xSignature = signedHeader({ dataId: '123456', requestId: 'req-1' })
    expect(
      verifyMercadoPagoWebhookSignature({
        xSignature,
        xRequestId: null,
        dataId: '123456',
        secret: SECRET,
      }),
    ).toBe(false)
  })

  it('rejects a missing data id', () => {
    const xSignature = signedHeader({ dataId: '123456', requestId: 'req-1' })
    expect(
      verifyMercadoPagoWebhookSignature({
        xSignature,
        xRequestId: 'req-1',
        dataId: null,
        secret: SECRET,
      }),
    ).toBe(false)
  })

  it('rejects a malformed x-signature header (missing ts or v1)', () => {
    expect(
      verifyMercadoPagoWebhookSignature({
        xSignature: 'v1=deadbeef',
        xRequestId: 'req-1',
        dataId: '123456',
        secret: SECRET,
      }),
    ).toBe(false)
    expect(
      verifyMercadoPagoWebhookSignature({
        xSignature: 'ts=1704908010',
        xRequestId: 'req-1',
        dataId: '123456',
        secret: SECRET,
      }),
    ).toBe(false)
  })

  it('rejects a v1 of the wrong length without throwing', () => {
    // timingSafeEqual would throw on length mismatch — the guard inside
    // the verifier should catch this and return false instead.
    expect(
      verifyMercadoPagoWebhookSignature({
        xSignature: 'ts=1704908010,v1=tooshort',
        xRequestId: 'req-1',
        dataId: '123456',
        secret: SECRET,
      }),
    ).toBe(false)
  })

  it('fails closed when no secret is configured for the account', () => {
    const xSignature = signedHeader({ dataId: '123456', requestId: 'req-1' })
    expect(
      verifyMercadoPagoWebhookSignature({
        xSignature,
        xRequestId: 'req-1',
        dataId: '123456',
        secret: null,
      }),
    ).toBe(false)
  })
})
