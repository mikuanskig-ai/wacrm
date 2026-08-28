import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/delivery/admin-client'
import { isCartAbandoned, type CartLineItem } from '@/lib/delivery/create-order'

/**
 * Sweep abandoned `ai_cart`s across every account.
 *
 * Confirmed live (2026-08-28, Churrascaria Concórdia — Edemar and
 * Ezequiel, same day): when a conversation's cart never turns into a
 * real order (the AI stalls, hands off, or the customer just goes
 * quiet), `ai_cart` sits there forever — nothing ever clears it on its
 * own. The next time that same contact orders, sometimes days or
 * weeks later, whatever was left over is still sitting in the same
 * cart: an old line silently doubles a new one via the exact-match
 * merge guard (Ezequiel — see isStaleCartLine/create-order.ts), or
 * unrelated leftover items just ride along into the next order's
 * summary as if the customer asked for them (Fernanda — 3 items
 * confirmed for a single "uma marmita P sem macarrão" request).
 *
 * This sweep is the general fix behind those two point patches: any
 * cart where NOTHING has been touched inside the staleness window
 * (isCartAbandoned — same 6h threshold add_to_cart's own merge guard
 * uses, so "stale" means one consistent thing everywhere) gets reset
 * to `[]` outright, account-wide. A cart with any recent activity is
 * left completely alone — this only ever clears sessions that are
 * genuinely abandoned, never an order actively in progress.
 *
 * `ai_order_info` (customer name, address, payment method) is
 * deliberately NOT touched here — unlike cart lines, stale contact
 * details are still usually correct on the next order and saving the
 * AI from re-asking is a real convenience, not a bug.
 *
 * Auth: re-uses AUTOMATION_CRON_SECRET, same reasoning as
 * flows/cron/route.ts — one shared secret for every low-frequency
 * background sweep in this codebase, each still on its own URL so one
 * failing doesn't block the others.
 *
 * Hosting: hit on a schedule (Vercel Cron / GitHub Actions / external
 * pinger). Every 5 minutes matches the other sweeps here — comfortably
 * inside the 6h staleness window, so an abandoned cart gets cleared
 * long before anyone's next visit, without ever racing a cart that's
 * still actively being built.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const nowIso = new Date().toISOString()

  // '[]' as a string, not [] — PostgREST parses a jsonb filter value as
  // JSON, so this asks Postgres "ai_cart <> '[]'::jsonb" instead of
  // (accidentally) filtering on an empty list of values. Every
  // conversation row has a non-null ai_cart (DEFAULT '[]'::jsonb, see
  // migration 044) — without this filter the sweep would pull every
  // conversation this account has ever had, not just the handful with
  // something actually sitting in the cart.
  const { data: rows, error } = await admin
    .from('conversations')
    .select('id, account_id, ai_cart')
    .neq('ai_cart', '[]')

  if (error) {
    console.error('[delivery-cart-sweep] scan failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!rows?.length) return NextResponse.json({ swept: 0 })

  type Row = { id: string; account_id: string; ai_cart: unknown }

  let swept = 0
  for (const row of rows as Row[]) {
    const cart = Array.isArray(row.ai_cart) ? (row.ai_cart as CartLineItem[]) : []
    if (!isCartAbandoned(cart, nowIso)) continue

    const { error: updateError } = await admin
      .from('conversations')
      .update({ ai_cart: [] })
      .eq('id', row.id)
    if (updateError) {
      console.error(`[delivery-cart-sweep] failed to clear conversation ${row.id}:`, updateError.message)
      continue
    }
    console.warn(
      `[delivery-cart-sweep] cleared an abandoned cart — conversation ${row.id}, account ${row.account_id}, ${cart.length} line(s)`,
    )
    swept += 1
  }

  return NextResponse.json({ swept })
}
