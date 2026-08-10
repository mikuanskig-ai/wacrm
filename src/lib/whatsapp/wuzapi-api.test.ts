import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listSessions } from './wuzapi-api'

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('listSessions', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('calls GET /admin/users with the Authorization header and returns the session list', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({
        code: 200,
        success: true,
        data: [
          { id: 'a', name: 'zontalk-Loja A', connected: true, loggedIn: true },
          { id: 'b', name: 'zontalk-Loja B', connected: false, loggedIn: false },
        ],
      }),
    )

    const sessions = await listSessions({ baseUrl: 'https://wuzapi.example.com', adminToken: 'admin-token' })

    expect(sessions).toEqual([
      { id: 'a', name: 'zontalk-Loja A', connected: true, loggedIn: true },
      { id: 'b', name: 'zontalk-Loja B', connected: false, loggedIn: false },
    ])
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://wuzapi.example.com/admin/users')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'admin-token' })
  })

  it('throws when the server responds with a non-2xx status', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }))
    await expect(
      listSessions({ baseUrl: 'https://wuzapi.example.com', adminToken: 'bad-token' }),
    ).rejects.toThrow()
  })

  it('strips a trailing slash from baseUrl before building the path', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ code: 200, success: true, data: [] }))
    await listSessions({ baseUrl: 'https://wuzapi.example.com/', adminToken: 'admin-token' })
    const [url] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://wuzapi.example.com/admin/users')
  })
})
