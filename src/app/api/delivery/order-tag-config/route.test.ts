import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getCurrentAccount: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  getCurrentAccount: mocks.getCurrentAccount,
  toErrorResponse: vi.fn((err: unknown) => Response.json({ error: String(err) }, { status: 500 })),
}))

import { GET, POST } from './route'

type Tag = { id: string; name: string; color: string }

function makeDb(opts: {
  orderPlacedTagId?: string | null
  tags?: Tag[]
  /** For POST's ownership check — set false to simulate a tag id that doesn't belong to this account. */
  tagBelongsToAccount?: boolean
} = {}) {
  const tags = opts.tags ?? []
  const updates: Record<string, unknown>[] = []

  const db = {
    from: (table: string) => {
      if (table === 'accounts') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: { order_placed_tag_id: opts.orderPlacedTagId ?? null }, error: null }),
            }),
          }),
          update: (payload: Record<string, unknown>) => {
            updates.push(payload)
            return { eq: () => Promise.resolve({ error: null }) }
          },
        }
      }
      if (table === 'tags') {
        return {
          select: () => ({
            eq: (col: string, val: string) => {
              // GET: .eq('account_id', accountId) then .order('name')
              if (col === 'account_id') {
                return { order: () => Promise.resolve({ data: tags, error: null }) }
              }
              // POST: .eq('id', tagId).eq('account_id', accountId).maybeSingle()
              return {
                eq: () => ({
                  maybeSingle: () =>
                    Promise.resolve({
                      data: opts.tagBelongsToAccount === false ? null : { id: val },
                      error: null,
                    }),
                }),
              }
            },
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  } as unknown as SupabaseClient

  return { db, getUpdates: () => updates }
}

beforeEach(() => {
  mocks.requireRole.mockReset()
  mocks.getCurrentAccount.mockReset()
})

describe('GET /api/delivery/order-tag-config', () => {
  it('returns the current tag id and the account\'s tag list', async () => {
    const tags: Tag[] = [
      { id: 'tag-1', name: 'Cliente Delivery', color: '#3b82f6' },
      { id: 'tag-2', name: 'VIP', color: '#ef4444' },
    ]
    const { db } = makeDb({ orderPlacedTagId: 'tag-1', tags })
    mocks.getCurrentAccount.mockResolvedValue({ supabase: db, accountId: 'acct-1' })

    const res = await GET()
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.tagId).toBe('tag-1')
    expect(data.tags).toEqual(tags)
  })

  it('returns tagId: null when the feature is off', async () => {
    const { db } = makeDb({ orderPlacedTagId: null, tags: [] })
    mocks.getCurrentAccount.mockResolvedValue({ supabase: db, accountId: 'acct-1' })

    const res = await GET()
    const data = await res.json()

    expect(data.tagId).toBeNull()
    expect(data.tags).toEqual([])
  })
})

describe('POST /api/delivery/order-tag-config', () => {
  it('sets the tag when it belongs to this account', async () => {
    const { db, getUpdates } = makeDb({ tagBelongsToAccount: true })
    mocks.requireRole.mockResolvedValue({ supabase: db, accountId: 'acct-1', userId: 'user-1' })

    const res = await POST(
      new Request('http://localhost/api/delivery/order-tag-config', {
        method: 'POST',
        body: JSON.stringify({ tag_id: 'tag-1' }),
      }),
    )
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.tagId).toBe('tag-1')
    expect(getUpdates()).toEqual([{ order_placed_tag_id: 'tag-1' }])
  })

  it('clears the tag when tag_id is null', async () => {
    const { db, getUpdates } = makeDb()
    mocks.requireRole.mockResolvedValue({ supabase: db, accountId: 'acct-1', userId: 'user-1' })

    const res = await POST(
      new Request('http://localhost/api/delivery/order-tag-config', {
        method: 'POST',
        body: JSON.stringify({ tag_id: null }),
      }),
    )

    expect(res.status).toBe(200)
    expect(getUpdates()).toEqual([{ order_placed_tag_id: null }])
  })

  it('rejects a tag id that does not belong to this account', async () => {
    const { db, getUpdates } = makeDb({ tagBelongsToAccount: false })
    mocks.requireRole.mockResolvedValue({ supabase: db, accountId: 'acct-1', userId: 'user-1' })

    const res = await POST(
      new Request('http://localhost/api/delivery/order-tag-config', {
        method: 'POST',
        body: JSON.stringify({ tag_id: 'someone-elses-tag' }),
      }),
    )

    expect(res.status).toBe(400)
    expect(getUpdates()).toHaveLength(0)
  })

  it('rejects a missing tag_id field', async () => {
    const { db } = makeDb()
    mocks.requireRole.mockResolvedValue({ supabase: db, accountId: 'acct-1', userId: 'user-1' })

    const res = await POST(
      new Request('http://localhost/api/delivery/order-tag-config', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    )

    expect(res.status).toBe(400)
  })
})
