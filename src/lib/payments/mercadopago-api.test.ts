import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPreference, getPayment, verifyAccessToken } from './mercadopago-api'

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function errorResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('createPreference', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts items + external_reference and returns the preference id/init_point', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ id: 'pref-123', init_point: 'https://mp.example/checkout/pref-123' }),
    )

    const result = await createPreference({
      accessToken: 'test-token',
      orderId: 'order-1',
      items: [{ title: 'Pizza', quantity: 2, unit_price: 30 }],
      currency: 'BRL',
      notificationUrl: 'https://wacrm.example/api/payments/mercadopago/webhook/acct-1',
    })

    expect(result).toEqual({
      preferenceId: 'pref-123',
      initPoint: 'https://mp.example/checkout/pref-123',
    })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.mercadopago.com/checkout/preferences')
    expect(init.headers.Authorization).toBe('Bearer test-token')
    const body = JSON.parse(init.body)
    expect(body.external_reference).toBe('order-1')
    expect(body.items[0]).toEqual({
      title: 'Pizza',
      quantity: 2,
      unit_price: 30,
      currency_id: 'BRL',
    })
  })

  it('throws with the API message on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(401, { message: 'invalid access token' }))

    await expect(
      createPreference({
        accessToken: 'bad-token',
        orderId: 'order-1',
        items: [{ title: 'Pizza', quantity: 1, unit_price: 10 }],
        currency: 'BRL',
        notificationUrl: 'https://wacrm.example/webhook',
      }),
    ).rejects.toThrow('invalid access token')
  })
})

describe('getPayment', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetches the payment and normalizes the response shape', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({
        id: 987654321,
        status: 'approved',
        external_reference: 'order-1',
        transaction_amount: 59.9,
      }),
    )

    const result = await getPayment({ accessToken: 'test-token', paymentId: '987654321' })

    expect(result).toEqual({
      id: '987654321',
      status: 'approved',
      externalReference: 'order-1',
      transactionAmount: 59.9,
    })
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.mercadopago.com/v1/payments/987654321')
  })

  it('throws on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(404, { message: 'payment not found' }))

    await expect(
      getPayment({ accessToken: 'test-token', paymentId: 'missing' }),
    ).rejects.toThrow('payment not found')
  })
})

describe('verifyAccessToken', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves when the token is valid', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ id: 1 }))
    await expect(verifyAccessToken('good-token')).resolves.toBeUndefined()
  })

  it('throws when the token is rejected', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(401, { message: 'invalid access token' }))
    await expect(verifyAccessToken('bad-token')).rejects.toThrow('invalid access token')
  })
})
