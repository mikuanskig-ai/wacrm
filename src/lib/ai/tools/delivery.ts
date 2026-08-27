// ============================================================
// Delivery tool-calling for the AI chat path (Fase 2). Five tools,
// deliberately minimal: search the menu, inspect one product's
// customization options, add to cart, view the cart, place the order.
// No edit/remove-from-cart tool — the model can just add again, or the
// customer restates what they want; a full cart CRUD surface is not
// needed for a first version.
//
// Every tool re-validates any id the model hands it against
// `ctx.accountId` before touching the database (never trust an id or a
// price coming from the model — same "defense in depth" principle
// already used by `automations/engine.ts`'s `create_deal`), and reuses
// the exact query shapes the Flow-based `add_order_item`/`order_summary`
// nodes already use (`loadProductWithAddonGroups`, `getAccountCurrency`
// in src/lib/flows/engine.ts) rather than re-deriving them.
//
// Addon groups (delivery_addon_groups) are account-defined and product-
// type-agnostic — "Size" for a pizzeria, "Ponto da carne" for a burger
// joint, "Cobertura" for an açaí shop, whatever a given business set
// up. get_product_details surfaces whatever groups/options that
// PARTICULAR account configured for that PARTICULAR product; nothing
// here assumes any specific business vertical. add_to_cart enforces
// `is_required` server-side (same rule the button-driven Flow engine
// already enforces — see engine.ts's addon-group step) rather than
// only hinting at it in a tool description, so a required choice can't
// be silently skipped just because the model forgot to ask.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadProductWithAddonGroups, type ProductWithAddonGroups } from '@/lib/flows/engine'
import {
  computeCartTotal,
  finalizeDeliveryOrder,
  type CartLineItem,
  type CartLineItemAddon,
} from '@/lib/delivery/create-order'
import { formatCurrency } from '@/lib/currency'
import { getBusinessHours, isWithinBusinessHours, closedMessage } from '@/lib/delivery/business-hours'
import { effectivePrice, type DayPriceOverrides } from '@/lib/delivery/day-price'
import { calculateDeliveryFeeForAccount, type DeliveryFeeFailureReason } from '@/lib/delivery/fee-engine'
import { readOrderInfo, writeOrderInfo, clearStaleFeeQuote, type OrderInfo } from '@/lib/ai/order-state'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import type { ToolDefinition } from './types'

/** Model-facing explanation for a failed fee calculation — tells the
 *  assistant what to ask the customer for next, never a raw code. */
function describeFeeFailure(reason: DeliveryFeeFailureReason, suggestions?: string[]): string {
  switch (reason) {
    case 'address_required':
      return 'A delivery address is required to calculate the fee. Ask the customer for their full delivery address.'
    case 'origin_not_configured':
      return "This account hasn't configured a delivery origin address yet — a staff member needs to set this up in Settings before delivery orders can be placed."
    case 'geocode_failed':
      // Real, observed failure: our map provider sometimes can't pinpoint a
      // genuinely correct, complete address (street + number + neighbourhood
      // + city) — asking the customer to repeat the exact same details they
      // already gave reads as broken/ignoring them. WhatsApp's shared
      // location pin skips this failure mode entirely (exact GPS, no
      // geocoding needed — see calculate_delivery_fee/place_order), so lead
      // with that instead of re-asking for text.
      return "Could not automatically locate that address (this can happen even with a correct, complete address — it's a limitation on our side, not necessarily a mistake in what the customer typed). Do NOT just ask them to repeat the same street/number/neighbourhood/city again. Instead, ask them to share their exact location in WhatsApp (attachment icon → Location) — that lets us calculate the fee precisely with no further back-and-forth. Only fall back to asking for a rewritten address if they say they can't share their location."
    case 'out_of_range':
      return "Sorry, we currently don't deliver to that address — it's outside our service area."
    case 'neighborhood_not_found':
      // Confirmed live (2026-08-19): a customer stated their real,
      // registered bairro three times running, worded slightly
      // differently each time, and got the exact same "which
      // neighbourhood?" question back all three times — no new
      // information for her to react to. The order was cancelled.
      // When the engine found anything plausibly close, hand it over so
      // the next message can be a pick-list ("Você quis dizer X?")
      // instead of a verbatim repeat.
      return suggestions && suggestions.length > 0
        ? `That exact neighborhood name isn't in our delivery list, but these registered ones are close: ${suggestions.join(', ')}. Ask the customer to confirm which one they meant — do NOT just repeat "what's your neighbourhood?" verbatim, they already answered that.`
        : "That neighborhood isn't in our delivery list. Ask the customer which neighborhood they're in, or provide a more complete address."
    case 'no_matching_distance_range':
      return "That address falls outside our configured delivery distance ranges — we can't calculate a fee for it."
  }
}

async function readCart(db: SupabaseClient, conversationId: string): Promise<CartLineItem[]> {
  const { data } = await db
    .from('conversations')
    .select('ai_cart')
    .eq('id', conversationId)
    .maybeSingle()
  const raw = (data as { ai_cart?: unknown } | null)?.ai_cart
  // Array.isArray, not just `?? []` — a jsonb column can hold ANY JSON
  // value, and `?? []` only rescues null/undefined. Confirmed live
  // (2026-08-06): a past write bug stored the literal JSON string
  // "[]" here instead of an array; every read blindly cast it back to
  // CartLineItem[] and crashed the moment a tool called .reduce on it.
  // Treating anything non-array as an empty cart makes this self-heal
  // on the very next write, for both future bugs and rows already
  // corrupted by that one.
  return Array.isArray(raw) ? (raw as CartLineItem[]) : []
}

async function writeCart(db: SupabaseClient, conversationId: string, cart: CartLineItem[]): Promise<void> {
  await db.from('conversations').update({ ai_cart: cart }).eq('id', conversationId)
}

// A shared WhatsApp location pin's stored content_text is built by the
// wuzapi webhook route as `[name, address, "lat,lng"].filter(Boolean).
// join(' - ')` — the coordinate pair is always the last segment when
// present. Same pattern context.ts's formatLocationMessage reformats
// for the model's transcript; duplicated here (rather than imported)
// so this stays a self-contained, deterministic check — see
// mostRecentSharedLocation for why.
const TRAILING_LAT_LNG = /(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/

function parseSharedLocation(contentText: string | null): { lat: number; lng: number } | null {
  if (!contentText) return null
  const match = TRAILING_LAT_LNG.exec(contentText.trim())
  if (!match) return null
  const lat = Number(match[1])
  const lng = Number(match[2])
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null
}

/** The customer's most recent message, when it was a shared WhatsApp
 *  location pin — GPS is strictly more accurate than any address text
 *  could be, so calculate_delivery_fee/place_order fall back to it
 *  automatically instead of depending on the model having noticed and
 *  correctly parsed the "[Customer shared their location]" transcript
 *  line itself (confirmed live: it didn't always, and the model just
 *  asked for a typed address instead — same result as no pin at all).
 *  Only the LATEST customer message counts — not "any location ever
 *  shared in this conversation" — so a text address given afterward
 *  correctly takes over instead of a stale pin winning forever. (A
 *  bounded lookback over several recent messages, for when a customer
 *  follows up a pin with a separate "apto 302" text, is a deliberate
 *  follow-up improvement, not done here.) */
async function mostRecentSharedLocation(
  db: SupabaseClient,
  conversationId: string,
): Promise<{ lat: number; lng: number } | null> {
  const { data } = await db
    .from('messages')
    .select('content_type, content_text')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const row = data as { content_type: string; content_text: string | null } | null
  if (!row || row.content_type !== 'location') return null
  return parseSharedLocation(row.content_text)
}

/** Accent/case-insensitive, split on words — matches fee-engine.ts's
 *  neighbourhood-matching reasoning for the exact same reason.
 *  Confirmed live (2026-08-11): a customer asked about "rodízio" and
 *  the model correctly called search_menu with query "rodízio" —
 *  which came back "No active menu items matched that search" against
 *  a real, active product named "Rodizio de Carne" (no accent in the
 *  stored name), a plain ILIKE being accent-sensitive. The model tried
 *  again with a broader "rodízio quilo almoço" and got the same empty
 *  result, because a literal ILIKE also requires the WHOLE query as
 *  one contiguous substring — no product name contains all three
 *  words together, even though two of them (rodízio, quilo) are real
 *  items. Both attempts failing back to back is what triggered a
 *  handoff over a completely answerable question. */
function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
}

/** Words under 3 letters ("de", "o", "a"...) are skipped so they don't
 *  match every product; a match on ANY remaining word counts — broader
 *  than requiring the whole phrase as one substring, on purpose. */
function matchesSearch(name: string, search: string): boolean {
  const normalizedName = normalizeSearchText(name)
  const words = normalizeSearchText(search)
    .split(/\s+/)
    .filter((w) => w.length >= 3)
  if (words.length === 0) return normalizedName.includes(normalizeSearchText(search))
  return words.some((w) => normalizedName.includes(w))
}

export const searchMenuTool: ToolDefinition = {
  name: 'search_menu',
  description:
    "Search the account's active delivery menu. Always call this before mentioning any product, price, or availability to the customer — never invent a menu item or price.",
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Optional free-text filter against product names, e.g. "pizza". Omit to list everything.',
      },
    },
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const search = typeof args.query === 'string' ? args.query.trim() : ''
    // Filtering happens in JS below (matchesSearch), not in the query —
    // an ILIKE at the DB level can't be made accent-insensitive without
    // an extension this schema doesn't have, and per-word matching
    // needs the full name string anyway. Wider cap when there's a
    // search term since it's no longer the DB doing the narrowing;
    // still capped when listing everything so a huge catalog doesn't
    // blow up the model's context for a query with no filter at all.
    const { data } = await ctx.db
      .from('delivery_products')
      .select('id, name, description, price, day_price_overrides')
      .eq('account_id', ctx.accountId)
      .eq('is_active', true)
      .order('position')
      .limit(search ? 200 : 20)
    const rows = (data ?? []) as {
      id: string
      name: string
      description: string | null
      price: number
      day_price_overrides: DayPriceOverrides | null
    }[]
    const matched = search ? rows.filter((p) => matchesSearch(p.name, search)) : rows
    if (matched.length === 0) {
      return { content: 'No active menu items matched that search.' }
    }
    const lines = matched.map(
      (p) =>
        `- ${p.name} (product_id: ${p.id}) — ${formatCurrency(effectivePrice(p.price, p.day_price_overrides), ctx.currency)}${p.description ? ` — ${p.description}` : ''}`,
    )
    return { content: `Active menu items:\n${lines.join('\n')}` }
  },
}

/** Formats one product's addon groups for the model — generic across
 *  business types, since the group/option names themselves come from
 *  whatever the account configured (see file header). */
function formatAddonGroups(product: ProductWithAddonGroups): string {
  if (product.addon_groups.length === 0) {
    return 'This product has no customization options — just call add_to_cart with the product_id.'
  }
  const lines = product.addon_groups.map((g) => {
    const cardinality = g.is_required
      ? g.selection_type === 'single'
        ? 'required, choose exactly one'
        : 'required, choose at least one'
      : g.selection_type === 'single'
        ? 'optional, choose at most one'
        : 'optional, choose any number'
    const options = g.options
      .map((o) => `${o.name} (option_id: ${o.id}, +${o.price_delta})`)
      .join('; ')
    return `- ${g.name} (${cardinality}): ${options}`
  })
  return `Customization options:\n${lines.join('\n')}`
}

export const getProductDetailsTool: ToolDefinition = {
  name: 'get_product_details',
  description:
    "Get one menu product's full customization options (size, flavor, extras, or whatever this business configured — never assume, always check). ALWAYS call this before add_to_cart for a product you haven't already inspected in this conversation, so you know whether anything is required.",
  parameters: {
    type: 'object',
    properties: {
      product_id: { type: 'string', description: 'A product_id from search_menu.' },
    },
    required: ['product_id'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const productId = typeof args.product_id === 'string' ? args.product_id : ''
    if (!productId) return { content: 'Missing product_id — call search_menu first.' }
    const product = await loadProductWithAddonGroups(ctx.db, ctx.accountId, productId)
    if (!product) {
      return { content: "That product_id doesn't exist in this account's menu. Call search_menu again." }
    }
    return {
      content: `${product.name} — ${formatCurrency(product.price, ctx.currency)}\n\n${formatAddonGroups(product)}`,
    }
  },
}

export const viewCartTool: ToolDefinition = {
  name: 'view_cart',
  description: "Read the customer's current cart and running total. Use this before asking for order confirmation.",
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async execute(_args, ctx) {
    const cart = await readCart(ctx.db, ctx.conversationId)
    if (cart.length === 0) return { content: 'The cart is currently empty.' }
    const { subtotal } = computeCartTotal(cart)
    // Numbered (1-based) and notes shown explicitly — this is the
    // identifier update_cart_item's line_number refers to. Necessary
    // because the SAME product can legitimately appear on more than one
    // line with different notes (e.g. two separately-customized orders
    // of the same dish) — confirmed live (2026-08-20, Concórdia,
    // Fabiane): a customer described how they wanted one marmita
    // prepared across two messages, and it ended up on two different
    // lines instead of one — without a line number, there would be no
    // way to tell the model which "Marmita P" line to fix.
    const lines = cart.map((item, i) => {
      const addons = item.addons ?? []
      const addonsTxt = addons.length ? ` (${addons.map((a) => a.option_name).join(', ')})` : ''
      const notesTxt = item.notes?.trim() ? ` [${item.notes.trim()}]` : ''
      return `${i + 1}. ${item.quantity}x ${item.product_name}${addonsTxt}${notesTxt}`
    })
    return { content: `Current cart:\n${lines.join('\n')}\nSubtotal: ${formatCurrency(subtotal, ctx.currency)}` }
  },
}

export const addToCartTool: ToolDefinition = {
  name: 'add_to_cart',
  description:
    "Add one item to the customer's cart. product_id must be one returned by a prior search_menu call — never guess an id. addon_option_ids are option ids from that product's addon groups (see get_product_details) — required groups MUST have a selection or this call is rejected. " +
    'Only for adding — if the customer is reducing a quantity, removing an item, or you need to undo something already in the cart, use update_cart_item instead, never a workaround here.',
  parameters: {
    type: 'object',
    properties: {
      product_id: { type: 'string', description: 'A product_id from search_menu.' },
      quantity: { type: 'integer', description: 'How many of this item. Defaults to 1.' },
      addon_option_ids: {
        type: 'array',
        items: { type: 'string' },
        description: "Chosen addon option ids for this product, if any.",
      },
      notes: { type: 'string', description: 'Free-text note for this item, e.g. "no onions".' },
    },
    required: ['product_id'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const productId = typeof args.product_id === 'string' ? args.product_id : ''
    if (!productId) return { content: 'Missing product_id — call search_menu first.' }

    const product = await loadProductWithAddonGroups(ctx.db, ctx.accountId, productId)
    if (!product) {
      return { content: "That product_id doesn't exist in this account's menu. Call search_menu again." }
    }

    const quantity = Math.max(1, Math.min(20, Math.trunc(Number(args.quantity)) || 1))
    const requestedOptionIds = Array.isArray(args.addon_option_ids)
      ? args.addon_option_ids.filter((v): v is string => typeof v === 'string')
      : []
    const allOptions = product.addon_groups.flatMap((g) =>
      g.options.map((o) => ({ ...o, group_id: g.id, group_name: g.name })),
    )
    const addons: CartLineItemAddon[] = requestedOptionIds
      .map((id) => allOptions.find((o) => o.id === id))
      .filter((o): o is (typeof allOptions)[number] => !!o)
      .map((o) => ({
        group_id: o.group_id,
        group_name: o.group_name,
        option_id: o.id,
        option_name: o.name,
        price_delta: o.price_delta,
      }))

    // Enforce is_required / single-selection server-side — same rule
    // the button-driven Flow engine already enforces (never trust the
    // model to have asked, same "defense in depth" as the id checks
    // above). Generic across business types: whatever groups this
    // particular account configured for this particular product.
    const selectedByGroup = new Map<string, CartLineItemAddon[]>()
    for (const a of addons) {
      const list = selectedByGroup.get(a.group_id) ?? []
      list.push(a)
      selectedByGroup.set(a.group_id, list)
    }
    const problems: string[] = []
    for (const group of product.addon_groups) {
      const picked = selectedByGroup.get(group.id) ?? []
      if (group.is_required && picked.length === 0) {
        const options = group.options.map((o) => `${o.name} (option_id: ${o.id})`).join(', ')
        problems.push(`"${group.name}" requires a choice — options: ${options}`)
      } else if (group.selection_type === 'single' && picked.length > 1) {
        problems.push(
          `"${group.name}" allows only one choice, but ${picked.length} were given (${picked
            .map((p) => p.option_name)
            .join(', ')})`,
        )
      }
    }
    if (problems.length > 0) {
      return {
        content: `Cannot add to cart yet — ${problems.join('; ')}. Ask the customer to choose, then call add_to_cart again with the right addon_option_ids.`,
      }
    }

    const item: CartLineItem = {
      product_id: product.id,
      product_name: product.name,
      unit_price: product.price,
      quantity,
      addons,
      notes: typeof args.notes === 'string' ? args.notes : null,
    }

    // The model has no memory of tool calls from earlier turns (they're
    // ephemeral — see this file's header doc), only the human-readable
    // transcript. Confirmed live (2026-08-06): that made it re-call
    // add_to_cart for a product a customer asked for only once, and
    // without this merge, that created a SECOND separate line instead
    // of updating the first — a cart quietly showing 3x the real order.
    // Same product + identical customization (same addon options, same
    // notes) merges into the existing line by summing quantity; only a
    // genuinely different customization gets its own line.
    const cartBefore = await readCart(ctx.db, ctx.conversationId)
    const addonsKey = (list: CartLineItemAddon[]) =>
      [...list.map((a) => a.option_id)].sort().join(',')
    const exactMatchIndex = cartBefore.findIndex(
      (line) =>
        line.product_id === item.product_id &&
        addonsKey(line.addons ?? []) === addonsKey(item.addons) &&
        (line.notes ?? null) === item.notes,
    )

    // A second, narrower match for when the exact one above misses:
    // same product + addons, but the existing line has no notes yet
    // and this call is quantity 1 with some. Confirmed live
    // (2026-08-07): a customer said "1 marmita P" (added bare, no
    // notes), then in the next message described how they wanted it
    // prepared ("sem carne, com ovo frito, sem macarrão") — the model,
    // with no memory of the first call, re-called add_to_cart with
    // that as `notes`. Without this, the two calls (notes "" vs notes
    // "sem carne...") don't match the exact check above, so they
    // became two separate 1x lines — R$20 x 2 shown as R$40 for what
    // was really one R$20 marmita. This is almost always the customer
    // volunteering a customization detail for the item they just
    // ordered, not asking for a second unit, so it updates the note in
    // place rather than summing quantity.
    const refinementMatchIndex =
      exactMatchIndex === -1 && quantity === 1 && item.notes && item.notes.trim()
        ? cartBefore.findIndex(
            (line) =>
              line.product_id === item.product_id &&
              addonsKey(line.addons ?? []) === addonsKey(item.addons) &&
              !(line.notes ?? '').trim(),
          )
        : -1

    let cart: CartLineItem[]
    let mergedQuantity = quantity
    let noteUpdated = false
    if (exactMatchIndex >= 0) {
      cart = [...cartBefore]
      const previousQuantity = cart[exactMatchIndex]!.quantity
      mergedQuantity = previousQuantity + quantity
      cart[exactMatchIndex] = { ...cart[exactMatchIndex]!, quantity: mergedQuantity }
      // This merge is the confirmed mechanism behind three separate
      // live incidents so far (2026-08-06 x2, 2026-08-07) — legitimate
      // when the customer really did ask for more, but also exactly
      // what happens when the model redundantly re-adds an item it
      // already committed (confirmed live 2026-08-15: several customer
      // messages arriving back-to-back led to a full re-add that
      // silently doubled every quantity in the order summary). No
      // reliable way to tell the two apart here — logging every
      // occurrence is what was missing to root-cause the 08-15
      // incident with any confidence; this is the trail for next time.
      console.warn(
        `[ai add_to_cart] merged into existing line — conversation ${ctx.conversationId}, product ${item.product_id} (${item.product_name}): ${previousQuantity} + ${quantity} = ${mergedQuantity}`,
      )
    } else if (refinementMatchIndex >= 0) {
      cart = [...cartBefore]
      mergedQuantity = cart[refinementMatchIndex]!.quantity
      cart[refinementMatchIndex] = { ...cart[refinementMatchIndex]!, notes: item.notes }
      noteUpdated = true
    } else {
      cart = [...cartBefore, item]
    }

    await writeCart(ctx.db, ctx.conversationId, cart)
    const { subtotal } = computeCartTotal(cart)
    // Deliberately phrased the same way whether this merged into an
    // existing line or started a new one — a message that instead
    // announces "already in cart / merged" reads to the model like
    // something unexpected happened, and confirmed live (2026-08-06)
    // that was enough to make it hesitate and hand off right after a
    // perfectly correct merge, even though the cart itself was fine.
    // Calling add_to_cart again for something already there is normal
    // (the model has no memory of earlier turns' tool calls) and must
    // read as a routine running-total update, not an anomaly.
    return {
      content:
        exactMatchIndex >= 0
          ? `Added ${quantity}x ${product.name} — now ${mergedQuantity}x total in the cart. Cart has ${cart.length} item(s), running subtotal ${formatCurrency(subtotal, ctx.currency)}.`
          : noteUpdated
            ? `Noted for the ${mergedQuantity}x ${product.name} already in the cart — no new line added, quantity unchanged. Cart has ${cart.length} item(s), running subtotal ${formatCurrency(subtotal, ctx.currency)}.`
            : `Added ${quantity}x ${product.name} to the cart. Cart now has ${cart.length} item(s), running subtotal ${formatCurrency(subtotal, ctx.currency)}.`,
    }
  },
}

/**
 * Confirmed live (2026-08-20, Concórdia, Fabiane): a customer corrected
 * an order down from 2 marmitas to 1, the model correctly recognized
 * it and asked "quer que eu deixe só 1?", the customer confirmed — and
 * then the model had no way to actually DO that, so it silently handed
 * off instead of finishing the correction. add_to_cart only ever adds;
 * there was no tool that could remove a line or bring a quantity down,
 * so a customer catching their own mistake (or the model's) hit a dead
 * end every time.
 *
 * Takes a line_number (the 1-based position shown by view_cart / the
 * "Order so far" Cart line), not a product_id — the same product can
 * legitimately sit on more than one cart line with different notes
 * (exactly what happened in the Fabiane incident), so a product_id
 * alone can't say which line to touch.
 */
export const updateCartItemTool: ToolDefinition = {
  name: 'update_cart_item',
  description:
    'Change or remove ONE line already in the cart. Use this — never add_to_cart — whenever the customer is correcting something already in the cart: they want fewer of an item, want to remove it entirely, or you added the wrong thing and need to take it back out. ' +
    "line_number is the position shown in view_cart's Current cart list or the Cart line in Order so far (1 = first line, 2 = second, etc.) — call view_cart first if you are not already looking at current line numbers. new_quantity is the item's new TOTAL quantity on that line, not an amount to add or subtract — set it to 0 to remove the line completely.",
  parameters: {
    type: 'object',
    properties: {
      line_number: {
        type: 'integer',
        description: '1-based position of the cart line to change, as shown by view_cart.',
      },
      new_quantity: {
        type: 'integer',
        description: 'The new total quantity for this line. 0 removes the line entirely.',
      },
    },
    required: ['line_number', 'new_quantity'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const lineNumber = Math.trunc(Number(args.line_number))
    if (!Number.isFinite(lineNumber) || lineNumber < 1) {
      return { content: 'Invalid line_number — call view_cart first to see the current line numbers, then try again.' }
    }
    const newQuantity = Math.trunc(Number(args.new_quantity))
    if (!Number.isFinite(newQuantity) || newQuantity < 0) {
      return { content: 'Invalid new_quantity — it must be 0 (to remove the line) or a positive whole number.' }
    }

    const cart = await readCart(ctx.db, ctx.conversationId)
    const index = lineNumber - 1
    if (index < 0 || index >= cart.length) {
      return {
        content:
          cart.length === 0
            ? 'The cart is currently empty — there is nothing to update.'
            : `There is no line ${lineNumber} — the cart currently has ${cart.length} line(s). Call view_cart to see the current lines, then try again.`,
      }
    }

    const target = cart[index]!
    const nextCart =
      newQuantity === 0 ? cart.filter((_, i) => i !== index) : cart.map((line, i) => (i === index ? { ...line, quantity: newQuantity } : line))
    await writeCart(ctx.db, ctx.conversationId, nextCart)
    const { subtotal } = computeCartTotal(nextCart)

    if (newQuantity === 0) {
      return {
        content: `Removed ${target.quantity}x ${target.product_name} from the cart. Cart now has ${nextCart.length} item(s), running subtotal ${formatCurrency(subtotal, ctx.currency)}.`,
      }
    }
    return {
      content: `Updated line ${lineNumber} (${target.product_name}) to ${newQuantity}x. Cart now has ${nextCart.length} item(s), running subtotal ${formatCurrency(subtotal, ctx.currency)}.`,
    }
  },
}

export const calculateDeliveryFeeTool: ToolDefinition = {
  name: 'calculate_delivery_fee',
  description:
    "Calculate the real delivery fee for a customer's address. ALWAYS call this before telling the customer what delivery costs — never estimate, guess, or reuse a number from earlier in the conversation, since fees depend on the account's configured method and can change. Whenever you know the customer's neighbourhood/bairro as its own answer — you asked for it separately, or they volunteered it on its own ('bairro Guarujá', 'jardim Guarujá', etc.) — you MUST pass it verbatim as `neighborhood`, not just fold it into `address`: accounts using a fixed per-neighbourhood fee match directly against that name and skip address lookup entirely, while relying on `address` alone forces a geocoder guess that can miss a real, registered neighbourhood on a small/local street (confirmed live 2026-08-19 — a customer's real bairro was registered and correctly priced, but omitting it from `neighborhood` and geocoding the street instead failed three times running and lost the order). " +
    "If the customer's last message was a shared WhatsApp location (a GPS pin, not typed text), you don't need to look up or pass any coordinates yourself — this tool detects it automatically and uses the exact numbers, which is more accurate than any typed address; just call it, `address` can be omitted entirely. You may still pass `latitude`/`longitude` explicitly if you already have them for some other reason. " +
    "The response may include a Resolved address for that location/address — always read it back to the customer and get their explicit confirmation ('is this address correct?') before calling place_order; never assume a resolved address or coordinates are correct without asking. " +
    "The response also includes the cart Subtotal and the Total (subtotal + fee) — when you write the order summary, copy those two numbers character-for-character from here. Doing that arithmetic yourself is exactly how a wrong total gets shown to the customer (confirmed live 2026-08-06: a single R$25 item was summarized as a R$100 subtotal).",
  parameters: {
    type: 'object',
    properties: {
      address: {
        type: 'string',
        description: "The customer's full delivery address. Not needed when latitude/longitude are given.",
      },
      neighborhood: {
        type: 'string',
        description:
          "The customer's neighbourhood/bairro, if you already have it as its own answer (not just embedded in `address`). Optional, but pass it whenever you know it.",
      },
      latitude: {
        type: 'number',
        description: 'Exact latitude from a WhatsApp location share, if the customer sent one.',
      },
      longitude: {
        type: 'number',
        description: 'Exact longitude from a WhatsApp location share, if the customer sent one.',
      },
    },
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const address = typeof args.address === 'string' ? args.address : ''
    const lat = typeof args.latitude === 'number' ? args.latitude : null
    const lng = typeof args.longitude === 'number' ? args.longitude : null
    let location = lat != null && lng != null ? { lat, lng } : null
    const neighborhood = typeof args.neighborhood === 'string' ? args.neighborhood : null

    // Deterministic fallback: the model has no memory of its own prior
    // tool calls, and can fail to notice/parse the "[Customer shared
    // their location]" transcript line — when it calls this tool with
    // neither an address nor coordinates, check directly whether the
    // customer's own last message actually was a shared location pin
    // and use it automatically, rather than erroring out and having
    // the model re-ask for an address the customer already gave (as
    // GPS, not text).
    if (!address.trim() && !location) {
      location = await mostRecentSharedLocation(ctx.db, ctx.conversationId)
    }

    if (!address.trim() && !location) {
      return {
        content:
          'Missing address — ask the customer for their delivery address, or ask them to share their location pin in WhatsApp.',
      }
    }

    const cart = await readCart(ctx.db, ctx.conversationId)
    const { subtotal } = computeCartTotal(cart)

    const result = await calculateDeliveryFeeForAccount(ctx.db, ctx.accountId, {
      address: address.trim() || null,
      neighborhoodName: neighborhood,
      location,
      subtotal,
    })
    if (!result.ok) return { content: describeFeeFailure(result.reason, result.suggestions) }

    const freeNote = result.freeShipping ? ' (free shipping applied)' : ''
    // Total is computed here, server-side, and handed to the model as a
    // ready number — never make it re-derive subtotal + fee itself in
    // the order-summary text (see the description above for why).
    // Rounded to cents same as computeCartTotal/fee-engine, so float
    // drift never shows up in what the customer sees.
    const total = Math.round((subtotal + result.fee) * 100) / 100
    // Only surfaced when the provider actually resolved one (a typed
    // address doesn't always geocode to a nameable place, and a fixed
    // fee with no distance/neighbourhood need never even looks one up)
    // — see the description above for why this must be read back to
    // the customer, not silently trusted.
    const addressNote = result.resolvedLabel ? `Resolved address: ${result.resolvedLabel}. ` : ''

    // Persisted so the NEXT turn's injected order-state summary already
    // shows this quote — the model doesn't have to remember it said
    // this, or recalculate just to relay the same number again in the
    // order summary. `undefined` (not `null`) for anything not given
    // this call, so a neighborhood learned earlier via update_order_info
    // isn't clobbered by an address-only call. See order-state.ts.
    // `location` is explicit-`null` (not `undefined`) when this call
    // was address-only — a stale coordinate from an earlier call must
    // not survive to be reused for a since-changed address (see
    // OrderInfo.location's doc for why this specific field can never
    // be silently left stale: place_order's own mandatory recalculation
    // depends on it matching whatever this quote actually used).
    const quotedAddress = address.trim() || (location ? `${location.lat},${location.lng}` : null)
    await writeOrderInfo(ctx.db, ctx.conversationId, {
      deliveryAddress: address.trim() || undefined,
      neighborhood: neighborhood || undefined,
      location,
      lastFeeQuote: {
        subtotal,
        fee: result.fee,
        total,
        address: quotedAddress,
        resolvedAddress: result.resolvedLabel,
        quotedAt: new Date().toISOString(),
      },
    })

    return {
      content:
        addressNote +
        `Subtotal: ${formatCurrency(subtotal, ctx.currency)}. ` +
        `Delivery fee for that address: ${formatCurrency(result.fee, ctx.currency)}${freeNote}. ` +
        `Total: ${formatCurrency(total, ctx.currency)}.`,
    }
  },
}

/** `place_order`'s success payload — handed to the loop (generate.ts),
 *  not the model, so the caller can build a deterministic confirmation
 *  without another provider round-trip. See generate.ts for why. */
export interface PlacedOrderPayload {
  id: string
  total: number
  deliveryFee: number
  currency: string
  items: { product_name: string; quantity: number; line_total: number }[]
  /** Whatever the customer told update_order_info earlier (e.g. "pix",
   *  "cartão", "dinheiro"), free text, null if never captured. Lets the
   *  deterministic order-confirmation message (auto-reply.ts) decide
   *  whether to append the account's Pix key. */
  paymentMethod: string | null
}

export const placeOrderTool: ToolDefinition = {
  name: 'place_order',
  description:
    'Finalize the order from the current cart. Only call this AFTER the customer has explicitly confirmed the itemized cart and total earlier in this conversation. Set is_pickup to true when the customer is picking the order up themselves (no delivery address needed, no delivery fee) — never leave delivery_address empty for a real delivery order, unless the customer only ever shared a WhatsApp location pin, which is picked up automatically. ' +
    'Any field you omit here falls back to what update_order_info or calculate_delivery_fee already recorded earlier in this conversation (shown in the order-state summary) — you do not need to repeat information you already captured, only pass a field again if it changed.',
  parameters: {
    type: 'object',
    properties: {
      delivery_address: { type: 'string' },
      customer_name: { type: 'string' },
      notes: { type: 'string' },
      is_pickup: {
        type: 'boolean',
        description:
          'True when the customer said they will pick the order up (retirada) instead of having it delivered. Skips the delivery fee entirely.',
      },
    },
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const cart = await readCart(ctx.db, ctx.conversationId)
    if (cart.length === 0) {
      return { content: 'The cart is empty — there is nothing to order yet. Use add_to_cart first.' }
    }

    // Fase 5 (Operação): self-service channels respect business hours;
    // a staff member creating a manual order never goes through this
    // tool, so this never blocks a phone/counter sale.
    const businessHours = await getBusinessHours(ctx.db, ctx.accountId)
    if (businessHours?.enabled && !isWithinBusinessHours(businessHours.hours, businessHours.timezone)) {
      return { content: closedMessage(businessHours.hours) }
    }

    // Falls back to whatever update_order_info/calculate_delivery_fee
    // already captured this conversation — the model doesn't always
    // re-pass something it already told the customer earlier, and
    // without this fallback that info was silently lost right at the
    // one step that most needed it. Explicit args always win when given
    // (the customer may have changed their mind since).
    const orderInfo = await readOrderInfo(ctx.db, ctx.conversationId)
    const isPickup = typeof args.is_pickup === 'boolean' ? args.is_pickup : orderInfo.isPickup === true
    const deliveryAddress =
      typeof args.delivery_address === 'string' && args.delivery_address.trim()
        ? args.delivery_address
        : orderInfo.deliveryAddress
    const customerName =
      typeof args.customer_name === 'string' && args.customer_name.trim()
        ? args.customer_name
        : orderInfo.customerName

    // A driver can't navigate off nothing — when the customer only
    // ever shared a WhatsApp location pin and never gave any text
    // address at all, fall back to a tappable Google Maps link for
    // the stored/printed address instead of hard-blocking the order.
    // Deliberately NOT fed back into `deliveryAddress` itself — that
    // variable still drives the fee recalculation below, which must
    // stay free-text-or-null so the `sameAddressAsLastQuote` check
    // (Regra 4) correctly takes the `orderInfo.location` bypass
    // instead of trying to geocode a Maps URL as if it were an
    // address. Any text address the customer gave, even a partial
    // one, always wins.
    const sharedLocation =
      !isPickup && !deliveryAddress?.trim()
        ? await mostRecentSharedLocation(ctx.db, ctx.conversationId)
        : null
    const storedAddress =
      deliveryAddress?.trim() ||
      (sharedLocation ? `https://www.google.com/maps?q=${sharedLocation.lat},${sharedLocation.lng}` : null)

    if (!isPickup && !storedAddress) {
      return {
        content:
          'Missing delivery_address for a delivery order. Ask the customer for their full delivery address, or ask them to share their location pin in WhatsApp, or call this again with is_pickup: true if they are picking it up themselves.',
      }
    }

    const { subtotal } = computeCartTotal(cart)

    // Pickup orders never go through fee calculation at all — same as
    // a staff member creating one manually (src/app/api/delivery/orders
    // just leaves delivery_fee unset for those, never calls the fee
    // engine). Before this, place_order unconditionally called
    // calculateDeliveryFeeForAccount even for a stated pickup — for any
    // account on a distance-based method (per_km, distance_range, or
    // neighborhood without an explicit name), that ALWAYS needs an
    // address to compute distance, so every pickup order failed at this
    // step (confirmed live 2026-08-06) — the model would ask for an
    // address the customer had already said they didn't need.
    let deliveryFee = 0
    if (!isPickup) {
      // Regra 4 — the model never invents a fee, even if it already
      // called calculate_delivery_fee earlier: this is the mandatory,
      // final calculation right before the order is created. BUT this
      // must reuse the same precise inputs that quote used — confirmed
      // live (2026-08-07): with only `address` passed here, a customer
      // who shared an exact WhatsApp location pin got quoted R$9 (fee
      // computed from that precise pin) and charged R$12 (this
      // recalculation re-geocoding the free-text address landed on a
      // less precise point further away) for the identical order. Only
      // trusted when `deliveryAddress` still matches what that quote
      // was for — if the model/customer changed the address at the
      // last step, the old coordinates belong to a different place and
      // must not be reused (falls through to a fresh address geocode).
      const sameAddressAsLastQuote = orderInfo.deliveryAddress === deliveryAddress
      const feeResult = await calculateDeliveryFeeForAccount(ctx.db, ctx.accountId, {
        address: deliveryAddress,
        neighborhoodName: sameAddressAsLastQuote ? orderInfo.neighborhood : null,
        location: sameAddressAsLastQuote ? orderInfo.location : null,
        subtotal,
      })
      if (!feeResult.ok) return { content: describeFeeFailure(feeResult.reason) }
      deliveryFee = feeResult.fee
    }

    const order = await finalizeDeliveryOrder(ctx.db, {
      accountId: ctx.accountId,
      contactId: ctx.contactId,
      conversationId: ctx.conversationId,
      source: 'ai_chat',
      cart,
      currency: ctx.currency,
      deliveryAddress: isPickup ? null : storedAddress,
      deliveryFee,
      customerName,
      notes: typeof args.notes === 'string' ? args.notes : null,
      paymentMethod: orderInfo.paymentMethod,
      paymentNotes: orderInfo.paymentNotes,
    })
    await writeCart(ctx.db, ctx.conversationId, [])
    // The quote is tied to the cart just cleared above — carrying it
    // forward would show a stale total for whatever this customer
    // orders next. Durable facts (name, address, payment method) are
    // deliberately kept; see clearStaleFeeQuote's doc.
    await clearStaleFeeQuote(ctx.db, ctx.conversationId)
    // See lastPlacedOrderId's doc (order-state.ts) — the fact that
    // closes the duplicate-order gap: without this, nothing told the
    // model an order already existed this conversation when the
    // customer corrected something right after confirming.
    await writeOrderInfo(ctx.db, ctx.conversationId, {
      lastPlacedOrderId: order.id,
      lastPlacedOrderTotal: order.total,
    })

    const payload: PlacedOrderPayload = {
      id: order.id,
      total: order.total,
      deliveryFee: order.delivery_fee ?? 0,
      currency: order.currency,
      items: cart.map((item) => ({
        product_name: item.product_name,
        quantity: item.quantity,
        line_total:
          (item.unit_price + (item.addons ?? []).reduce((s, a) => s + a.price_delta, 0)) * item.quantity,
      })),
      paymentMethod: orderInfo.paymentMethod,
    }
    return { content: `Order placed successfully (id ${order.id}).`, data: payload }
  },
}

export const updateOrderInfoTool: ToolDefinition = {
  name: 'update_order_info',
  description:
    "Record a piece of order information as soon as the customer gives it — their name, whether it's pickup or delivery, their address/neighbourhood, or payment method. This is saved and shown back to you automatically at the start of every future turn (as part of the order-state summary), so you never have to ask for it again or re-derive it from scrolling back through the conversation. Only pass the field(s) you actually just learned — anything you omit is left exactly as it was.",
  parameters: {
    type: 'object',
    properties: {
      customer_name: { type: 'string' },
      is_pickup: { type: 'boolean', description: 'True for pickup (retirada), false for delivery.' },
      delivery_address: { type: 'string' },
      neighborhood: { type: 'string' },
      payment_method: { type: 'string', description: 'e.g. "pix", "cartão", "dinheiro".' },
      payment_notes: {
        type: 'string',
        description: 'Anything extra about payment, e.g. "troco para R$100".',
      },
    },
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const patch: Partial<OrderInfo> = {}
    if (typeof args.customer_name === 'string') patch.customerName = args.customer_name.trim() || null
    if (typeof args.is_pickup === 'boolean') patch.isPickup = args.is_pickup
    if (typeof args.delivery_address === 'string') {
      patch.deliveryAddress = args.delivery_address.trim() || null
    }
    if (typeof args.neighborhood === 'string') patch.neighborhood = args.neighborhood.trim() || null
    if (typeof args.payment_method === 'string') patch.paymentMethod = args.payment_method.trim() || null
    if (typeof args.payment_notes === 'string') patch.paymentNotes = args.payment_notes.trim() || null

    if (Object.keys(patch).length === 0) {
      return { content: 'Nothing to update — pass at least one field (customer_name, is_pickup, delivery_address, neighborhood, payment_method, or payment_notes).' }
    }
    await writeOrderInfo(ctx.db, ctx.conversationId, patch)
    return { content: 'Noted — saved for the rest of this conversation.' }
  },
}

export const cancelOrderTool: ToolDefinition = {
  name: 'cancel_order',
  description:
    'Cancels the order placed earlier THIS conversation (see "An order was ALREADY PLACED" in the order-state summary — that is the one this cancels, you never need to pass an id). ' +
    'Use this the moment the customer corrects or changes anything about an order you already placed — a different quantity, a different item, a different address — BEFORE building the corrected cart and calling place_order again. ' +
    'Never place a second order without cancelling the first one first: that sends the kitchen two separate tickets for what the customer meant as one single corrected order, and can double-charge them.',
  parameters: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Short note on why, e.g. "customer corrected quantity". Optional.' },
    },
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const orderInfo = await readOrderInfo(ctx.db, ctx.conversationId)
    if (!orderInfo.lastPlacedOrderId) {
      return { content: 'No order was placed in this conversation to cancel — nothing to do.' }
    }

    const { data: order } = await ctx.db
      .from('delivery_orders')
      .select('id, status, contact_id, total, currency')
      .eq('id', orderInfo.lastPlacedOrderId)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (!order) {
      // Row's gone (rare — a staff member could have deleted it) —
      // still clear the stale pointer so a future turn doesn't keep
      // trying to cancel a ghost.
      await writeOrderInfo(ctx.db, ctx.conversationId, { lastPlacedOrderId: null, lastPlacedOrderTotal: null })
      return { content: 'That order no longer exists — nothing to cancel.' }
    }
    if (order.status === 'cancelled') {
      return { content: 'That order is already cancelled.' }
    }
    // Once it's out the door, an automatic cancel here is more likely
    // to cause confusion (a driver already carrying it, a kitchen
    // ticket already fired) than to help — same "too far along" line
    // a human would draw. Tell the model to hand this one to staff
    // instead of silently flipping a status a delivery is already
    // committed to.
    if (order.status === 'out_for_delivery' || order.status === 'delivered') {
      return {
        content: `Order ${order.id} is already ${order.status} — too late to cancel automatically. Tell the customer a human needs to help with this correction.`,
      }
    }

    const { error } = await ctx.db
      .from('delivery_orders')
      .update({ status: 'cancelled', status_changed_at: new Date().toISOString() })
      .eq('id', order.id)
    if (error) {
      return { content: `Failed to cancel order ${order.id}: ${error.message}` }
    }

    await writeOrderInfo(ctx.db, ctx.conversationId, { lastPlacedOrderId: null, lastPlacedOrderTotal: null })

    // Same two side effects the manual PATCH /api/delivery/orders/:id
    // route fires on a staff-initiated status change — an AI-initiated
    // cancel should look identical to anything downstream (webhooks,
    // automations) watching for order status changes.
    await dispatchWebhookEvent(ctx.db, ctx.accountId, 'order.status_changed', {
      order_id: order.id,
      previous_status: order.status,
      status: 'cancelled',
    })
    await runAutomationsForTrigger({
      accountId: ctx.accountId,
      triggerType: 'order_status_changed',
      contactId: order.contact_id,
      context: {
        order_status: 'cancelled',
        vars: {
          order_id: order.id,
          order_status: 'cancelled',
          order_previous_status: order.status,
          order_total: order.total,
          order_currency: order.currency,
        },
      },
    })

    return { content: `Order ${order.id} cancelled.` }
  },
}

export function getAvailableTools(args: {
  accountHasDeliveryModule: boolean
  toolsEnabled: boolean
  allowSideEffects: boolean
}): ToolDefinition[] {
  if (!args.accountHasDeliveryModule) return []
  // Draft/Playground: read-only menu lookups (and fee calculation,
  // which only reads config) are free and safe to try regardless of
  // the tools_enabled switch — they can't mutate anything.
  if (!args.allowSideEffects) {
    return [searchMenuTool, getProductDetailsTool, viewCartTool, calculateDeliveryFeeTool]
  }
  // Live customer chat: the mutating tools (and therefore any tool at
  // all here) require the account to have explicitly opted in.
  if (!args.toolsEnabled) return []
  return [
    searchMenuTool,
    getProductDetailsTool,
    viewCartTool,
    calculateDeliveryFeeTool,
    addToCartTool,
    updateCartItemTool,
    placeOrderTool,
    updateOrderInfoTool,
    cancelOrderTool,
  ]
}
