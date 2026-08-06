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
import type { ToolDefinition } from './types'

/** Model-facing explanation for a failed fee calculation — tells the
 *  assistant what to ask the customer for next, never a raw code. */
function describeFeeFailure(reason: DeliveryFeeFailureReason): string {
  switch (reason) {
    case 'address_required':
      return 'A delivery address is required to calculate the fee. Ask the customer for their full delivery address.'
    case 'origin_not_configured':
      return "This account hasn't configured a delivery origin address yet — a staff member needs to set this up in Settings before delivery orders can be placed."
    case 'geocode_failed':
      return "Could not locate that address. Ask the customer to double-check it or provide more detail (street, number, neighborhood, city)."
    case 'out_of_range':
      return "Sorry, we currently don't deliver to that address — it's outside our service area."
    case 'neighborhood_not_found':
      return "That neighborhood isn't in our delivery list. Ask the customer which neighborhood they're in, or provide a more complete address."
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
      .select('id, name, description, price, day_price_overrides')
      .eq('account_id', ctx.accountId)
      .eq('is_active', true)
      .order('position')
      .limit(20)
    const search = typeof args.query === 'string' ? args.query.trim() : ''
    if (search) query = query.ilike('name', `%${search}%`)
    const { data } = await query
    const rows = (data ?? []) as {
      id: string
      name: string
      description: string | null
      price: number
      day_price_overrides: DayPriceOverrides | null
    }[]
    if (rows.length === 0) {
      return { content: 'No active menu items matched that search.' }
    }
    const lines = rows.map(
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
    "Add one item to the customer's cart. product_id must be one returned by a prior search_menu call — never guess an id. addon_option_ids are option ids from that product's addon groups (see get_product_details) — required groups MUST have a selection or this call is rejected.",
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

    const cart = [...(await readCart(ctx.db, ctx.conversationId)), item]
    await writeCart(ctx.db, ctx.conversationId, cart)
    const { subtotal } = computeCartTotal(cart)
    return {
      content: `Added ${quantity}x ${product.name} to the cart. Cart now has ${cart.length} item(s), running subtotal ${formatCurrency(subtotal, ctx.currency)}.`,
    }
  },
}

export const calculateDeliveryFeeTool: ToolDefinition = {
  name: 'calculate_delivery_fee',
  description:
    "Calculate the real delivery fee for a customer's address. ALWAYS call this before telling the customer what delivery costs — never estimate, guess, or reuse a number from earlier in the conversation, since fees depend on the account's configured method and can change.",
  parameters: {
    type: 'object',
    properties: {
      address: { type: 'string', description: "The customer's full delivery address." },
    },
    required: ['address'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const address = typeof args.address === 'string' ? args.address : ''
    if (!address.trim()) return { content: 'Missing address — ask the customer for their delivery address first.' }

    const cart = await readCart(ctx.db, ctx.conversationId)
    const { subtotal } = computeCartTotal(cart)

    const result = await calculateDeliveryFeeForAccount(ctx.db, ctx.accountId, { address, subtotal })
    if (!result.ok) return { content: describeFeeFailure(result.reason) }

    const freeNote = result.freeShipping ? ' (free shipping applied)' : ''
    return { content: `Delivery fee for that address: ${formatCurrency(result.fee, ctx.currency)}${freeNote}.` }
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

    const deliveryAddress = typeof args.delivery_address === 'string' ? args.delivery_address : null

    // Regra 4 — the model never invents a fee, even if it already
    // called calculate_delivery_fee earlier: this is the mandatory,
    // final calculation right before the order is created.
    const { subtotal } = computeCartTotal(cart)
    const feeResult = await calculateDeliveryFeeForAccount(ctx.db, ctx.accountId, {
      address: deliveryAddress,
      subtotal,
    })
    if (!feeResult.ok) return { content: describeFeeFailure(feeResult.reason) }

    const order = await finalizeDeliveryOrder(ctx.db, {
      accountId: ctx.accountId,
      contactId: ctx.contactId,
      conversationId: ctx.conversationId,
      source: 'ai_chat',
      cart,
      currency: ctx.currency,
      deliveryAddress,
      deliveryFee: feeResult.fee,
      customerName: typeof args.customer_name === 'string' ? args.customer_name : null,
      notes: typeof args.notes === 'string' ? args.notes : null,
    })
    await writeCart(ctx.db, ctx.conversationId, [])

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
    placeOrderTool,
  ]
}
