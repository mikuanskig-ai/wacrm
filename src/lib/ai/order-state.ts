// ============================================================
// Persistent order state for the AI tool-calling delivery flow
// (migration 068) — the same fix `ai_cart` (migration 044) already
// applied to the cart, extended to the rest of what an order needs.
//
// Root cause this exists for: the model has NO memory of tool calls
// from earlier turns — only the human-readable transcript
// (`buildConversationContext`). Without a persisted, injected summary
// of what's already been established, the model has to re-derive (or
// guess, or invent) facts it already asked for and already got, which
// is what caused most of the AI-order bugs found 2026-08-06/07: cart
// duplication, re-asking the customer's name/address, and a
// hallucinated total in the order summary.
//
// `buildOrderStateSummary` is injected into the system prompt every
// turn as ground truth (see defaults.ts) — a fact block the model is
// told never to re-derive or contradict, not something it has to
// remember to go check with a tool call.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { computeCartTotal, type CartLineItem } from '@/lib/delivery/create-order'
import { formatCurrency } from '@/lib/currency'

/** Same defensive read/shape-check as the cart line inside
 *  `buildOrderStateSummary` below, split out standalone for
 *  `auto-reply.ts`'s post-generation sanity check (see its doc comment
 *  for why that exists) — reused rather than re-derived so the two
 *  never drift on what counts as "the cart has something in it". */
export async function hasCartItems(db: SupabaseClient, conversationId: string): Promise<boolean> {
  const { data } = await db.from('conversations').select('ai_cart').eq('id', conversationId).maybeSingle()
  const rawCart = (data as { ai_cart?: unknown } | null)?.ai_cart
  return Array.isArray(rawCart) && rawCart.length > 0
}

export interface OrderFeeQuote {
  subtotal: number
  fee: number
  total: number
  /** The free-text address or neighbourhood the quote was calculated
   *  for — lets a later turn tell whether the customer's address has
   *  changed since this quote (in which case it's stale and must be
   *  recalculated) or is still the same (safe to just relay). */
  address: string | null
  /** The provider-resolved label, when there was one — same value the
   *  customer was shown to confirm (see calculateDeliveryFeeTool). */
  resolvedAddress: string | null
  quotedAt: string
}

export interface OrderInfo {
  customerName: string | null
  isPickup: boolean | null
  deliveryAddress: string | null
  neighborhood: string | null
  /** Exact coordinates the last successful calculate_delivery_fee used
   *  (a WhatsApp location share), when there were any. `place_order`'s
   *  own mandatory fee recalculation (Regra 4 — never trust a stale
   *  number) reuses this instead of re-geocoding `deliveryAddress`
   *  from scratch: confirmed live (2026-08-07) that skipping it made
   *  place_order derive a DIFFERENT point than the one the customer
   *  actually confirmed a fee for — same free-text address, but the
   *  forward-geocoder's guess landed further away than the exact pin,
   *  so the customer was quoted R$9 and charged R$12 for the same
   *  order. Cleared (set to null, not left stale) whenever a fee quote
   *  is based on typed text instead — see calculateDeliveryFeeTool. */
  location: { lat: number; lng: number } | null
  paymentMethod: string | null
  paymentNotes: string | null
  lastFeeQuote: OrderFeeQuote | null
  /** Set by place_order right after it creates an order, cleared by
   *  cancel_order. Root-caused a real duplicate-order incident live
   *  (2026-08-13): a customer corrected their quantity AFTER the model
   *  had already called place_order for the original — with no way to
   *  know an order already existed this conversation, or to cancel it,
   *  the model's only move was placing a SECOND order for the
   *  corrected amount, so the kitchen got two separate tickets (R$95
   *  and R$55) for what should have been one. This is the fact that
   *  lets both the prompt (see defaults.ts) and the new cancel_order
   *  tool close that gap — see also lastPlacedOrderTotal below. */
  lastPlacedOrderId: string | null
  /** Shown alongside lastPlacedOrderId in the order-state summary so
   *  the model doesn't need a tool call just to remind itself what the
   *  order it might need to cancel actually totalled. */
  lastPlacedOrderTotal: number | null
}

const EMPTY_ORDER_INFO: OrderInfo = {
  customerName: null,
  isPickup: null,
  deliveryAddress: null,
  neighborhood: null,
  location: null,
  paymentMethod: null,
  paymentNotes: null,
  lastFeeQuote: null,
  lastPlacedOrderId: null,
  lastPlacedOrderTotal: null,
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads `conversations.ai_order_info`, defensively — same discipline
 *  as `readCart` (delivery.ts): a jsonb column can hold ANY JSON value,
 *  and a non-object here (corrupted write, manual DB edit) must never
 *  crash a tool call. Treats anything malformed as empty, which
 *  self-heals on the next write. */
export async function readOrderInfo(db: SupabaseClient, conversationId: string): Promise<OrderInfo> {
  const { data } = await db
    .from('conversations')
    .select('ai_order_info')
    .eq('id', conversationId)
    .maybeSingle()
  const raw = (data as { ai_order_info?: unknown } | null)?.ai_order_info
  if (!isPlainObject(raw)) return { ...EMPTY_ORDER_INFO }
  return { ...EMPTY_ORDER_INFO, ...raw } as OrderInfo
}

/** Merges `patch` into whatever's already stored and writes it back —
 *  a partial update, same semantics as `add_to_cart` merging into an
 *  existing line rather than requiring the caller to resend
 *  everything. `undefined` fields in `patch` leave the existing value
 *  untouched; an explicit `null` clears a field. Returns the merged
 *  result so a tool can report back what's now known. */
export async function writeOrderInfo(
  db: SupabaseClient,
  conversationId: string,
  patch: Partial<OrderInfo>,
): Promise<OrderInfo> {
  const current = await readOrderInfo(db, conversationId)
  const merged: OrderInfo = { ...current }
  for (const key of Object.keys(patch) as (keyof OrderInfo)[]) {
    if (patch[key] !== undefined) (merged as unknown as Record<string, unknown>)[key] = patch[key]
  }
  await db.from('conversations').update({ ai_order_info: merged }).eq('id', conversationId)
  return merged
}

/** Clears everything order-specific (used on handoff, mirroring the
 *  `ai_cart: []` reset already done there — see auto-reply.ts) EXCEPT
 *  durable customer facts (name, confirmed address/neighbourhood,
 *  payment method) that are still true regardless of who's handling
 *  the thread. Only `lastFeeQuote` is cleared: it's tied to a specific
 *  cart subtotal, and the cart itself is wiped on handoff — a stale
 *  total surviving that reset would actively mislead whoever resumes
 *  the order. */
export async function clearStaleFeeQuote(db: SupabaseClient, conversationId: string): Promise<void> {
  await writeOrderInfo(db, conversationId, { lastFeeQuote: null })
}

/** Builds the ground-truth fact block injected into the system prompt
 *  every turn (see defaults.ts's `toolsActive` block for the
 *  instruction that goes with it). Returns null when there's nothing
 *  to show yet — an empty cart and no order info means no section is
 *  worth adding to the prompt. */
export async function buildOrderStateSummary(
  db: SupabaseClient,
  conversationId: string,
  currency: string,
): Promise<string | null> {
  const [info, cartRow] = await Promise.all([
    readOrderInfo(db, conversationId),
    db.from('conversations').select('ai_cart').eq('id', conversationId).maybeSingle(),
  ])
  const rawCart = (cartRow.data as { ai_cart?: unknown } | null)?.ai_cart
  const cart = Array.isArray(rawCart) ? (rawCart as CartLineItem[]) : []

  const lines: string[] = []

  if (cart.length > 0) {
    const { subtotal } = computeCartTotal(cart)
    const items = cart.map((item) => {
      const addons = item.addons ?? []
      const addonsTxt = addons.length ? ` (${addons.map((a) => a.option_name).join(', ')})` : ''
      const notesTxt = item.notes?.trim() ? ` [${item.notes.trim()}]` : ''
      return `${item.quantity}x ${item.product_name}${addonsTxt}${notesTxt}`
    })
    lines.push(`Cart: ${items.join('; ')} — Subtotal ${formatCurrency(subtotal, currency)}`)
  } else {
    lines.push('Cart: empty')
  }

  if (info.customerName) lines.push(`Customer name: ${info.customerName}`)
  if (info.isPickup === true) lines.push('Delivery type: pickup (retirada) — no address needed')
  if (info.isPickup === false) lines.push('Delivery type: delivery')
  if (info.deliveryAddress) lines.push(`Address given: ${info.deliveryAddress}`)
  if (info.neighborhood) lines.push(`Neighbourhood: ${info.neighborhood}`)
  if (info.paymentMethod) {
    lines.push(`Payment method: ${info.paymentMethod}${info.paymentNotes ? ` (${info.paymentNotes})` : ''}`)
  }
  if (info.lastFeeQuote) {
    const q = info.lastFeeQuote
    const staleness = q.address && info.deliveryAddress && q.address !== info.deliveryAddress
    lines.push(
      `Last delivery fee quote${staleness ? ' (STALE — address changed since, recalculate)' : ''}: ` +
        `for "${q.address ?? '(pickup)'}" — fee ${formatCurrency(q.fee, currency)}, ` +
        `total ${formatCurrency(q.total, currency)}, quoted ${q.quotedAt}.`,
    )
  }

  // Root-caused a real duplicate-order incident (2026-08-13, see
  // lastPlacedOrderId's doc) — surfaced here as loudly as the STALE
  // fee-quote flag above so the model can't miss it.
  if (info.lastPlacedOrderId) {
    lines.push(
      `An order was ALREADY PLACED in this conversation: id ${info.lastPlacedOrderId}` +
        (info.lastPlacedOrderTotal != null ? `, total ${formatCurrency(info.lastPlacedOrderTotal, currency)}` : '') +
        '. If the customer is now correcting or changing that order (a different quantity, item, or address), you MUST call ' +
        'cancel_order first, THEN build the corrected cart and call place_order again — never place a second order without ' +
        'cancelling the first one, that sends the kitchen two separate tickets for what should be a single corrected order.',
    )
  }

  if (lines.length === 1 && lines[0] === 'Cart: empty') return null
  return lines.join('\n')
}
