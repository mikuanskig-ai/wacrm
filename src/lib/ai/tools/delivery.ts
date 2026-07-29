// ============================================================
// Delivery tool-calling for the AI chat path (Fase 2). Four tools,
// deliberately minimal: search the menu, add to cart, view the cart,
// place the order. No edit/remove-from-cart tool — the model can just
// add again, or the customer restates what they want; a full cart CRUD
// surface is not needed for a first version.
//
// Every tool re-validates any id the model hands it against
// `ctx.accountId` before touching the database (never trust an id or a
// price coming from the model — same "defense in depth" principle
// already used by `automations/engine.ts`'s `create_deal`), and reuses
// the exact query shapes the Flow-based `add_order_item`/`order_summary`
// nodes already use (`loadProductWithAddonGroups`, `getAccountCurrency`
// in src/lib/flows/engine.ts) rather than re-deriving them.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadProductWithAddonGroups } from '@/lib/flows/engine'
import {
  computeCartTotal,
  finalizeDeliveryOrder,
  type CartLineItem,
  type CartLineItemAddon,
} from '@/lib/delivery/create-order'
import { formatCurrency } from '@/lib/currency'
import { getBusinessHours, isWithinBusinessHours, closedMessage } from '@/lib/delivery/business-hours'
import type { ToolDefinition } from './types'

async function readCart(db: SupabaseClient, conversationId: string): Promise<CartLineItem[]> {
  const { data } = await db
    .from('conversations')
    .select('ai_cart')
    .eq('id', conversationId)
    .maybeSingle()
  return ((data as { ai_cart?: CartLineItem[] } | null)?.ai_cart as CartLineItem[] | undefined) ?? []
}

async function writeCart(db: SupabaseClient, conversationId: string, cart: CartLineItem[]): Promise<void> {
  await db.from('conversations').update({ ai_cart: cart }).eq('id', conversationId)
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
    let query = ctx.db
      .from('delivery_products')
      .select('id, name, description, price')
      .eq('account_id', ctx.accountId)
      .eq('is_active', true)
      .order('position')
      .limit(20)
    const search = typeof args.query === 'string' ? args.query.trim() : ''
    if (search) query = query.ilike('name', `%${search}%`)
    const { data } = await query
    const rows = (data ?? []) as { id: string; name: string; description: string | null; price: number }[]
    if (rows.length === 0) {
      return { content: 'No active menu items matched that search.' }
    }
    const lines = rows.map(
      (p) =>
        `- ${p.name} (product_id: ${p.id}) — ${formatCurrency(p.price, ctx.currency)}${p.description ? ` — ${p.description}` : ''}`,
    )
    return { content: `Active menu items:\n${lines.join('\n')}` }
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
    const lines = cart.map((item) => {
      const addonsTxt = item.addons.length ? ` (${item.addons.map((a) => a.option_name).join(', ')})` : ''
      return `- ${item.quantity}x ${item.product_name}${addonsTxt}`
    })
    return { content: `Current cart:\n${lines.join('\n')}\nSubtotal: ${formatCurrency(subtotal, ctx.currency)}` }
  },
}

export const addToCartTool: ToolDefinition = {
  name: 'add_to_cart',
  description:
    "Add one item to the customer's cart. product_id must be one returned by a prior search_menu call — never guess an id. addon_option_ids are optional option ids from that product's addon groups.",
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

    const item: CartLineItem = {
      product_id: product.id,
      product_name: product.name,
      unit_price: product.price,
      quantity,
      addons,
      notes: typeof args.notes === 'string' ? args.notes : null,
    }

    const cart = [...(await readCart(ctx.db, ctx.conversationId)), item]
    await writeCart(ctx.db, ctx.conversationId, cart)
    const { subtotal } = computeCartTotal(cart)
    return {
      content: `Added ${quantity}x ${product.name} to the cart. Cart now has ${cart.length} item(s), running subtotal ${formatCurrency(subtotal, ctx.currency)}.`,
    }
  },
}

/** `place_order`'s success payload — handed to the loop (generate.ts),
 *  not the model, so the caller can build a deterministic confirmation
 *  without another provider round-trip. See generate.ts for why. */
export interface PlacedOrderPayload {
  id: string
  total: number
  currency: string
  items: { product_name: string; quantity: number; line_total: number }[]
}

export const placeOrderTool: ToolDefinition = {
  name: 'place_order',
  description:
    'Finalize the order from the current cart. Only call this AFTER the customer has explicitly confirmed the itemized cart and total earlier in this conversation.',
  parameters: {
    type: 'object',
    properties: {
      delivery_address: { type: 'string' },
      customer_name: { type: 'string' },
      notes: { type: 'string' },
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

    const order = await finalizeDeliveryOrder(ctx.db, {
      accountId: ctx.accountId,
      contactId: ctx.contactId,
      conversationId: ctx.conversationId,
      source: 'ai_chat',
      cart,
      currency: ctx.currency,
      deliveryAddress: typeof args.delivery_address === 'string' ? args.delivery_address : null,
      customerName: typeof args.customer_name === 'string' ? args.customer_name : null,
      notes: typeof args.notes === 'string' ? args.notes : null,
    })
    await writeCart(ctx.db, ctx.conversationId, [])

    const payload: PlacedOrderPayload = {
      id: order.id,
      total: order.total,
      currency: order.currency,
      items: cart.map((item) => ({
        product_name: item.product_name,
        quantity: item.quantity,
        line_total:
          (item.unit_price + item.addons.reduce((s, a) => s + a.price_delta, 0)) * item.quantity,
      })),
    }
    return { content: `Order placed successfully (id ${order.id}).`, data: payload }
  },
}

export function getAvailableTools(args: {
  accountHasDeliveryModule: boolean
  toolsEnabled: boolean
  allowSideEffects: boolean
}): ToolDefinition[] {
  if (!args.accountHasDeliveryModule) return []
  // Draft/Playground: read-only menu lookups are free and safe to try
  // regardless of the tools_enabled switch — they can't mutate anything.
  if (!args.allowSideEffects) return [searchMenuTool, viewCartTool]
  // Live customer chat: the mutating tools (and therefore any tool at
  // all here) require the account to have explicitly opted in.
  if (!args.toolsEnabled) return []
  return [searchMenuTool, viewCartTool, addToCartTool, placeOrderTool]
}
