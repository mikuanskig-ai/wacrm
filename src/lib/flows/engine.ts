/**
 * Flow runner.
 *
 * The single entry point `dispatchInboundToFlows` is called by the
 * WhatsApp webhook on every inbound message *for an account that has
 * opted into the Flows beta*. It decides whether the message belongs
 * to an active conversation flow (advance it) or matches the entry
 * trigger of an active flow (start a new run) — and reports back to
 * the webhook so the webhook knows whether to also fire automations.
 *
 * Architecture in a sentence: the runner walks the customer through
 * a DB-stored node graph, suspending only at nodes that need
 * customer input. Each tap or text reply wakes it back up.
 *
 * What lives here vs elsewhere:
 *   - Pure decision logic (which button matched, where to advance to,
 *     when to fallback) — here.
 *   - DB shape (table reads/writes) — here.
 *   - Meta API calls — `meta-send.ts` (engineSendInteractive*).
 *   - Policy resolution (reprompt vs handoff vs end) — `fallback.ts`.
 *   - Type definitions — `types.ts`.
 *
 * Concurrency model:
 *   - Idempotency on `meta_message_id`: the runner refuses to advance
 *     an active run twice for the same Meta message — protects against
 *     Meta's retries.
 *   - Optimistic UPDATE with `current_node_key` precondition: two
 *     simultaneous taps for the same run collide at the DB layer; the
 *     second is a no-op.
 *   - Partial unique index `idx_one_active_run_per_contact`: two
 *     simultaneous starts for the same contact collide; the second
 *     INSERT raises 23505 and the runner catches & exits.
 */

import { supabaseAdmin } from "./admin-client";
import { engineSendMedia, engineSendText } from "./meta-send";
import { decideFallback, resolveFallbackPolicy } from "./fallback";
import { addContactTagAndDispatch } from "@/lib/contacts/tag-events";
import { removeContactTag } from "@/lib/contacts/tag-write";
import {
  extractLeadingNumber,
  matchNumericMenuReply,
  matchesKeywordTrigger,
  isAutoAdvancing,
  isSuspending,
  isTerminal,
  evaluateConditionPredicate,
  interpolateVars,
} from "./predicates";
// Re-exported so existing importers (engine.test.ts) keep working
// unchanged — the implementations moved to predicates.ts so the
// client-side flow simulator can use them without pulling in this
// file's server-only imports (supabaseAdmin, Meta senders, delivery
// order creation).
export {
  matchNumericMenuReply,
  matchesKeywordTrigger,
  isAutoAdvancing,
  isSuspending,
  isTerminal,
  evaluateConditionPredicate,
};
import {
  type CollectInputNodeConfig,
  type ConditionNodeConfig,
  type DispatchInboundInput,
  type DispatchInboundResult,
  type FlowNodeRow,
  type FlowRow,
  type FlowRunRow,
  type ParsedInbound,
  type SendMediaNodeConfig,
  type SendMessageNodeConfig,
  type SetTagNodeConfig,
  type StartNodeConfig,
  type KeywordTriggerConfig,
  type AddOrderItemNodeConfig,
  type OrderSummaryNodeConfig,
  type NumericMenuNodeConfig,
} from "./types";
import { formatCurrency } from "@/lib/currency";
import {
  computeCartTotal,
  finalizeDeliveryOrder,
  type CartLineItem,
  type CartLineItemAddon,
} from "@/lib/delivery/create-order";
import { getBusinessHours, isWithinBusinessHours, closedMessage } from "@/lib/delivery/business-hours";
import { effectivePrice, type DayPriceOverrides } from "@/lib/delivery/day-price";
import { calculateDeliveryFeeForAccount, type DeliveryFeeFailureReason } from "@/lib/delivery/fee-engine";

/** Deterministic, never LLM-generated — same reasoning as
 *  closedMessage() (business-hours.ts): a customer-facing message
 *  telling them their order can't be completed must never depend on a
 *  paraphrase. */
function deliveryFeeFailureMessage(reason: DeliveryFeeFailureReason): string {
  switch (reason) {
    case "out_of_range":
      return "Desculpe, atualmente não realizamos entregas nessa região.";
    case "neighborhood_not_found":
      return "Não localizamos esse bairro na nossa área de entrega. Poderia informar o bairro ou um endereço mais completo?";
    case "no_matching_distance_range":
      return "Desculpe, não conseguimos calcular a taxa de entrega para esse endereço.";
    case "geocode_failed":
      return "Não conseguimos localizar esse endereço. Poderia conferir e enviar novamente com mais detalhes (rua, número, bairro)?";
    case "address_required":
      return "Precisamos do endereço de entrega para calcular a taxa. Poderia informá-lo?";
    case "origin_not_configured":
      return "No momento não estamos conseguindo calcular a taxa de entrega. Por favor, aguarde ou entre em contato.";
  }
}

// Pure decision helpers (extractLeadingNumber, matchNumericMenuReply,
// matchesKeywordTrigger, isAutoAdvancing, isSuspending, isTerminal,
// evaluateConditionPredicate, interpolateVars) now live in
// predicates.ts — imported above, re-exported above for engine.test.ts.

// ============================================================
// DB I/O — wrapped in tiny helpers so the dispatch flow stays
// readable. Errors surface as thrown — the entry point catches.
// ============================================================

type AdminClient = ReturnType<typeof supabaseAdmin>;

async function loadActiveRunForContact(
  db: AdminClient,
  accountId: string,
  contactId: string,
): Promise<FlowRunRow | null> {
  // The partial unique index `idx_one_active_run_per_contact` was
  // rebuilt in migration 017 over `(account_id, contact_id)` — so
  // "two active runs for one contact in one account" is impossible
  // by design. But a future migration glitch or manual SQL could
  // create one, and .maybeSingle() throws on >1 row — which would
  // kill dispatch for that contact's webhook entirely. .limit(1) is
  // forgiving: pick the newest, let the cron sweep clean up the
  // stale one.
  const { data, error } = await db
    .from("flow_runs")
    .select("*")
    .eq("account_id", accountId)
    .eq("contact_id", contactId)
    .eq("status", "active")
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) {
    console.error("[flows] loadActiveRunForContact error:", error.message);
    return null;
  }
  const rows = (data as FlowRunRow[] | null) ?? [];
  return rows[0] ?? null;
}

async function loadFlow(
  db: AdminClient,
  flowId: string,
): Promise<FlowRow | null> {
  const { data, error } = await db
    .from("flows")
    .select("*")
    .eq("id", flowId)
    .maybeSingle();
  if (error) {
    console.error("[flows] loadFlow error:", error.message);
    return null;
  }
  return (data as FlowRow | null) ?? null;
}

/**
 * Load every node of a flow in one round trip and key them by
 * `node_key`. The advance loop is then in-memory — a 5-node
 * auto-advancing chain costs one SELECT, not five.
 *
 * Returns an empty map on error so the caller can still dispatch
 * cleanly (every subsequent .get() returns undefined → the run
 * fails with node_not_found, same as the old per-node lookup).
 */
async function loadAllNodes(
  db: AdminClient,
  flowId: string,
): Promise<Map<string, FlowNodeRow>> {
  const { data, error } = await db
    .from("flow_nodes")
    .select("*")
    .eq("flow_id", flowId);
  if (error) {
    console.error("[flows] loadAllNodes error:", error.message);
    return new Map();
  }
  const map = new Map<string, FlowNodeRow>();
  for (const row of (data ?? []) as FlowNodeRow[]) {
    map.set(row.node_key, row);
  }
  return map;
}

async function logEvent(
  db: AdminClient,
  flowRunId: string,
  event_type:
    | "started"
    | "node_entered"
    | "message_sent"
    | "reply_received"
    | "fallback_fired"
    | "handoff"
    | "timeout"
    | "error"
    | "completed",
  node_key: string | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await db.from("flow_run_events").insert({
    flow_run_id: flowRunId,
    event_type,
    node_key,
    payload,
  });
  if (error) {
    // Logging failure is non-fatal — surface but don't throw.
    console.error("[flows] logEvent error:", error.message);
  }
}

/**
 * Idempotency check — has a `reply_received` event with this Meta
 * message_id already been recorded for any of the contact's flow
 * runs? If yes, the inbound is a duplicate (Meta retry) and we
 * exit without re-advancing.
 *
 * Implementation note: scoped to runs belonging to this user/contact
 * so the lookup is cheap (the index on flow_run_events(flow_run_id,
 * event_type) plus the small set of runs per contact).
 */
async function isDuplicateInbound(
  db: AdminClient,
  accountId: string,
  contactId: string,
  metaMessageId: string,
): Promise<boolean> {
  // Fetch ALL run ids for this contact in this account (active +
  // historical). Bounded by how many flows the customer has been
  // through — small.
  const { data: runs } = await db
    .from("flow_runs")
    .select("id")
    .eq("account_id", accountId)
    .eq("contact_id", contactId);
  if (!runs?.length) return false;
  const runIds = runs.map((r) => (r as { id: string }).id);

  const { count } = await db
    .from("flow_run_events")
    .select("id", { count: "exact", head: true })
    .in("flow_run_id", runIds)
    .eq("event_type", "reply_received")
    .filter("payload->>meta_message_id", "eq", metaMessageId);
  return (count ?? 0) > 0;
}

async function findEntryFlow(
  db: AdminClient,
  accountId: string,
  message: ParsedInbound,
  isFirstInbound: boolean,
): Promise<FlowRow | null> {
  // Only text messages can match an entry trigger. Interactive replies
  // are responses to existing prompts; they never start a new flow.
  if (message.kind !== "text") return null;

  // Pull all active flows for this account. Active set is bounded
  // (the builder discourages double-trigger overlap; partial index
  // makes the lookup index-supported).
  const { data: flows, error } = await db
    .from("flows")
    .select("*")
    .eq("account_id", accountId)
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error || !flows) return null;

  const typed = flows as FlowRow[];
  for (const flow of typed) {
    if (flow.trigger_type === "keyword") {
      if (matchesKeywordTrigger(
        message.text,
        flow.trigger_config as KeywordTriggerConfig,
      )) {
        return flow;
      }
    } else if (flow.trigger_type === "first_inbound_message" && isFirstInbound) {
      return flow;
    }
    // 'manual' triggers do not auto-start from inbound messages.
  }
  return null;
}

// ============================================================
// Node executors — each handles ONE node type. Suspending nodes
// persist `last_prompt_message_id` so the inbox
// thread can quote the prompt the customer is replying to.
// ============================================================

/** Looks up the internal `messages` row id for a just-sent Meta message
 *  and stashes it on the run so the inbox thread can quote the prompt
 *  the customer is replying to. Shared by every node type that suspends. */
async function persistLastPromptMessage(
  db: AdminClient,
  run: FlowRunRow,
  whatsappMessageId: string,
): Promise<void> {
  const { data: msg } = await db
    .from("messages")
    .select("id")
    .eq("message_id", whatsappMessageId)
    .maybeSingle();
  await db
    .from("flow_runs")
    .update({ last_prompt_message_id: (msg as { id: string } | null)?.id ?? null })
    .eq("id", run.id);
}

/**
 * Renders a numeric_menu as plain text ("1: Financeiro\n2: Comercial"
 * appended below the prompt, framed by an optional header/footer line)
 * and sends it via engineSendText — the only branching prompt the
 * builder offers now that Meta's interactive buttons/list messages
 * have been removed (whatsmeow has no equivalent). See
 * matchNumericMenuReply for how the customer's reply resolves back to
 * an option.
 */
async function sendNumericMenuAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as NumericMenuNodeConfig;
  const menuLines = cfg.options.map((o, i) => `${i + 1}: ${o.label}`).join("\n");
  const header = cfg.header_text ? `${interpolateVars(cfg.header_text, run.vars)}\n\n` : "";
  const footer = cfg.footer_text ? `\n\n${interpolateVars(cfg.footer_text, run.vars)}` : "";
  const bodyText = `${header}${interpolateVars(cfg.prompt_text, run.vars)}\n\n${menuLines}${footer}`;
  const { whatsapp_message_id } = await engineSendText({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    text: bodyText,
  });
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "numeric_menu",
    whatsapp_message_id,
  });
  await persistLastPromptMessage(db, run, whatsapp_message_id);
  return { outcome: "advanced", node_key: node.node_key };
}

// ============================================================
// Zontalk Delivery — add_order_item / order_summary node executors.
//
// Reply-id encoding lets `handleAddOrderItemReply` decode which control
// the customer tapped from the string alone, without a DB round-trip.
// Product/option ids are the DB's own UUIDs, so a plain prefix is
// sufficient (no delimiter collision risk).
// ============================================================

const AOI_PRODUCT_REPLY_PREFIX = "aoi_product:";
const AOI_OPTION_REPLY_PREFIX = "aoi_opt:";
const AOI_DONE_REPLY_PREFIX = "aoi_done:";
const AOI_SKIP_REPLY_PREFIX = "aoi_skip:";

interface AddOrderItemRuntimeState {
  step: "product" | "addon_group";
  product_id?: string;
  addon_group_index?: number;
  selected_addons?: CartLineItemAddon[];
}

function aoiStateKey(nodeKey: string): string {
  return `__aoi_${nodeKey}`;
}

async function persistAoiState(
  db: AdminClient,
  run: FlowRunRow,
  stateKey: string,
  state: AddOrderItemRuntimeState | undefined,
): Promise<void> {
  const newVars = { ...run.vars };
  if (state) newVars[stateKey] = state;
  else delete newVars[stateKey];
  const { error } = await db
    .from("flow_runs")
    .update({ vars: newVars })
    .eq("id", run.id);
  if (!error) run.vars = newVars;
}

export async function getAccountCurrency(
  db: AdminClient,
  accountId: string,
): Promise<string> {
  const { data } = await db
    .from("accounts")
    .select("default_currency")
    .eq("id", accountId)
    .maybeSingle();
  return (data as { default_currency?: string } | null)?.default_currency ?? "USD";
}

interface AddonOptionRow {
  id: string;
  name: string;
  price_delta: number;
  group_id: string;
}

interface AddonGroupRow {
  id: string;
  name: string;
  selection_type: "single" | "multiple";
  is_required: boolean;
  position: number;
}

export interface ProductWithAddonGroups {
  id: string;
  name: string;
  price: number;
  addon_groups: (AddonGroupRow & { options: AddonOptionRow[] })[];
}

export async function loadProductWithAddonGroups(
  db: AdminClient,
  accountId: string,
  productId: string,
): Promise<ProductWithAddonGroups | null> {
  const { data: product } = await db
    .from("delivery_products")
    .select("id, name, price, day_price_overrides")
    .eq("id", productId)
    .eq("account_id", accountId)
    .maybeSingle();
  if (!product) return null;
  const { data: groups } = await db
    .from("delivery_addon_groups")
    .select("id, name, selection_type, is_required, position")
    .eq("product_id", productId)
    .order("position");
  const groupRows = (groups ?? []) as AddonGroupRow[];
  let options: AddonOptionRow[] = [];
  if (groupRows.length > 0) {
    const { data: opts } = await db
      .from("delivery_addon_options")
      .select("id, name, price_delta, group_id")
      .in("group_id", groupRows.map((g) => g.id))
      .eq("is_active", true)
      .order("position");
    options = (opts ?? []) as AddonOptionRow[];
  }
  const typedProduct = product as {
    id: string;
    name: string;
    price: number;
    day_price_overrides: DayPriceOverrides | null;
  };
  return {
    id: typedProduct.id,
    name: typedProduct.name,
    price: effectivePrice(typedProduct.price, typedProduct.day_price_overrides),
    addon_groups: groupRows.map((g) => ({
      ...g,
      options: options.filter((o) => o.group_id === g.id),
    })),
  };
}

/**
 * Product-list prompt for a fresh (or re-prompted) `add_order_item`
 * visit. Returns false when the account has no matching active
 * products to show — the caller treats that as a dead end.
 */
async function sendAddOrderItemProductPrompt(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  cfg: AddOrderItemNodeConfig,
): Promise<boolean> {
  let query = db
    .from("delivery_products")
    .select("id, name, price, day_price_overrides")
    .eq("account_id", run.account_id)
    .eq("is_active", true)
    .order("position")
    .limit(10);
  if (cfg.category_id) query = query.eq("category_id", cfg.category_id);
  const { data: products } = await query;
  const rows = (products ?? []) as {
    id: string;
    name: string;
    price: number;
    day_price_overrides: DayPriceOverrides | null;
  }[];
  if (rows.length === 0) return false;

  const currency = await getAccountCurrency(db, run.account_id);
  const menuLines = rows
    .map((p, i) => `${i + 1}: ${p.name} — ${formatCurrency(effectivePrice(p.price, p.day_price_overrides), currency)}`)
    .join("\n");
  const bodyText = `${interpolateVars(cfg.prompt_text, run.vars)}\n\n${menuLines}`;
  const { whatsapp_message_id } = await engineSendText({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    text: bodyText,
  });
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "add_order_item",
    step: "product",
    whatsapp_message_id,
  });
  await persistLastPromptMessage(db, run, whatsapp_message_id);
  return true;
}

/**
 * Re-runs the same product query as {@link sendAddOrderItemProductPrompt}
 * to reconstruct the numbered order the customer is replying against —
 * so a "1"/"2"/... text reply resolves to the same product ids that
 * were actually rendered. `AOI_PRODUCT_REPLY_PREFIX`-prefixed, matching
 * the internal id shape `handleAddOrderItemReplyInner` already expects.
 */
async function loadAoiProductReplyIds(
  db: AdminClient,
  run: FlowRunRow,
  cfg: AddOrderItemNodeConfig,
): Promise<string[]> {
  let query = db
    .from("delivery_products")
    .select("id")
    .eq("account_id", run.account_id)
    .eq("is_active", true)
    .order("position")
    .limit(10);
  if (cfg.category_id) query = query.eq("category_id", cfg.category_id);
  const { data: products } = await query;
  return ((products ?? []) as { id: string }[]).map((p) => `${AOI_PRODUCT_REPLY_PREFIX}${p.id}`);
}

/**
 * Add-on-group prompt for the group at `groupIndex` on `product`.
 * `currentSelections` (already-picked addons for THIS product, across
 * all its groups so far) drives the ✅ prefix on re-renders of a
 * `multiple`-selection group after a toggle.
 */
async function sendAddOrderItemGroupPrompt(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  product: ProductWithAddonGroups,
  groupIndex: number,
  currentSelections: CartLineItemAddon[] = [],
): Promise<void> {
  const group = product.addon_groups[groupIndex];
  const currency = await getAccountCurrency(db, run.account_id);
  const selectedIds = new Set(
    currentSelections
      .filter((a) => a.group_id === group.id)
      .map((a) => a.option_id),
  );
  const optionRows = group.options.map((o) => ({
    id: `${AOI_OPTION_REPLY_PREFIX}${o.id}`,
    label: `${selectedIds.has(o.id) ? "✅ " : ""}${o.name}${o.price_delta !== 0 ? ` (${formatCurrency(o.price_delta, currency)})` : ""}`,
  }));
  const controlRows: { id: string; label: string }[] = [];
  if (group.selection_type === "multiple") {
    controlRows.push({ id: `${AOI_DONE_REPLY_PREFIX}${group.id}`, label: "✅ Done" });
  }
  if (!group.is_required) {
    controlRows.push({ id: `${AOI_SKIP_REPLY_PREFIX}${group.id}`, label: "Skip" });
  }
  const allRows = [...optionRows, ...controlRows];
  const menuLines = allRows.map((r, i) => `${i + 1}: ${r.label}`).join("\n");
  const bodyText = `${product.name} — ${group.name}${group.is_required ? " *" : ""}\n\n${menuLines}`;

  const { whatsapp_message_id } = await engineSendText({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    text: bodyText,
  });
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "add_order_item",
    step: "addon_group",
    group_id: group.id,
    whatsapp_message_id,
  });
  await persistLastPromptMessage(db, run, whatsapp_message_id);
}

/**
 * Reconstructs the numbered order rendered by
 * {@link sendAddOrderItemGroupPrompt} for the SAME group/selections
 * (options first, then Done/Skip in that fixed order), so a numeric
 * text reply resolves to the same internal ids the interactive-list
 * version used to carry.
 */
function aoiGroupReplyIds(
  group: ProductWithAddonGroups["addon_groups"][number],
): string[] {
  const optionIds = group.options.map((o) => `${AOI_OPTION_REPLY_PREFIX}${o.id}`);
  const controlIds: string[] = [];
  if (group.selection_type === "multiple") {
    controlIds.push(`${AOI_DONE_REPLY_PREFIX}${group.id}`);
  }
  if (!group.is_required) {
    controlIds.push(`${AOI_SKIP_REPLY_PREFIX}${group.id}`);
  }
  return [...optionIds, ...controlIds];
}

/**
 * Appends `item` to the run's cart var, clears the node's in-flight
 * picker sub-state, and advances to `cfg.next_node_key` — the point
 * where a single `add_order_item` visit is considered "done".
 */
async function finishAddOrderItem(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  cfg: AddOrderItemNodeConfig,
  nodes: Map<string, FlowNodeRow>,
  item: CartLineItem,
): Promise<DispatchInboundResult> {
  const cart = (run.vars[cfg.cart_var_key] as CartLineItem[] | undefined) ?? [];
  const newVars: Record<string, unknown> = {
    ...run.vars,
    [cfg.cart_var_key]: [...cart, item],
  };
  delete newVars[aoiStateKey(node.node_key)];
  const { error } = await db
    .from("flow_runs")
    .update({ vars: newVars, reprompt_count: 0 })
    .eq("id", run.id);
  if (!error) {
    run.vars = newVars;
    run.reprompt_count = 0;
  }
  const outcome = await advanceFromNodeKey(db, run, cfg.next_node_key, nodes);
  return { consumed: true, flow_run_id: run.id, outcome: outcome.outcome };
}

/**
 * Handles a reply while the run is suspended on an `add_order_item`
 * node. Returns `null` when the reply_id isn't recognised for the
 * node's current sub-step (caller falls through to the normal
 * fallback/reprompt policy) — otherwise fully handles the turn
 * (re-suspends on the same or next sub-step, or completes the item and
 * advances) and returns the result to hand straight back to the caller.
 */
/**
 * Thin wrapper around handleAddOrderItemReplyInner — every branch
 * below ends up calling a WuzAPI send (product prompt, addon prompt,
 * or a finishAddOrderItem → advanceFromNodeKey chain) with no
 * try/catch of its own, so a channel-send failure would otherwise
 * propagate all the way to dispatchInboundToFlows's catch-all and
 * leave the run stuck active/suspended forever with no failure
 * recorded — same failure mode fixed for the node-type handlers in
 * advanceFromNodeKey.
 */
/**
 * Resolves a customer's numbered text reply ("1", "2 - Skip", ...)
 * against whichever numbered list is currently in flight for this
 * `add_order_item` node (product list, or the current addon group) —
 * reconstructed identically to how it was rendered, so position N in
 * the reply matches position N in the prompt. Returns the same
 * internal `replyId` shape `handleAddOrderItemReplyInner` already
 * understands (its own logic is otherwise unchanged).
 */
async function resolveAoiNumericReply(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  text: string,
): Promise<string | null> {
  const n = extractLeadingNumber(text);
  if (n === null) return null;
  const cfg = node.config as unknown as AddOrderItemNodeConfig;
  const state =
    (run.vars[aoiStateKey(node.node_key)] as AddOrderItemRuntimeState | undefined) ?? {
      step: "product",
    };

  if (state.step === "product" || !state.product_id) {
    const ids = await loadAoiProductReplyIds(db, run, cfg);
    return ids[n - 1] ?? null;
  }
  const product = await loadProductWithAddonGroups(db, run.account_id, state.product_id);
  const group = product?.addon_groups[state.addon_group_index ?? 0];
  if (!group) return null;
  const ids = aoiGroupReplyIds(group);
  return ids[n - 1] ?? null;
}

async function handleAddOrderItemReply(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  replyId: string,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult | null> {
  try {
    return await handleAddOrderItemReplyInner(db, run, node, replyId, nodes);
  } catch (err) {
    await logEvent(db, run.id, "error", node.node_key, {
      reason: "add_order_item_reply_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
    await endRun(db, run.id, "failed", "add_order_item_reply_failed");
    return { consumed: true, flow_run_id: run.id, outcome: "completed" };
  }
}

async function handleAddOrderItemReplyInner(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  replyId: string,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult | null> {
  const cfg = node.config as unknown as AddOrderItemNodeConfig;
  const stateKey = aoiStateKey(node.node_key);
  const state =
    (run.vars[stateKey] as AddOrderItemRuntimeState | undefined) ?? { step: "product" };

  if (state.step === "product") {
    if (!replyId.startsWith(AOI_PRODUCT_REPLY_PREFIX)) return null;
    const productId = replyId.slice(AOI_PRODUCT_REPLY_PREFIX.length);
    const product = await loadProductWithAddonGroups(db, run.account_id, productId);
    if (!product) return null;

    if (product.addon_groups.length === 0) {
      return finishAddOrderItem(db, run, node, cfg, nodes, {
        product_id: product.id,
        product_name: product.name,
        unit_price: product.price,
        quantity: 1,
        addons: [],
      });
    }
    await persistAoiState(db, run, stateKey, {
      step: "addon_group",
      product_id: product.id,
      addon_group_index: 0,
      selected_addons: [],
    });
    await sendAddOrderItemGroupPrompt(db, run, node, product, 0);
    return { consumed: true, flow_run_id: run.id, outcome: "advanced" };
  }

  // step === "addon_group"
  if (!state.product_id) return null;
  const product = await loadProductWithAddonGroups(db, run.account_id, state.product_id);
  if (!product) return null;
  const groupIndex = state.addon_group_index ?? 0;
  const group = product.addon_groups[groupIndex];
  if (!group) return null;

  let selected = [...(state.selected_addons ?? [])];
  let advanceGroup = false;

  if (
    replyId === `${AOI_DONE_REPLY_PREFIX}${group.id}` ||
    replyId === `${AOI_SKIP_REPLY_PREFIX}${group.id}`
  ) {
    if (group.is_required && !selected.some((a) => a.group_id === group.id)) {
      // Required group with nothing picked yet — ignore the tap and
      // re-render the same prompt instead of silently skipping it.
      await sendAddOrderItemGroupPrompt(db, run, node, product, groupIndex, selected);
      return { consumed: true, flow_run_id: run.id, outcome: "advanced" };
    }
    advanceGroup = true;
  } else if (replyId.startsWith(AOI_OPTION_REPLY_PREFIX)) {
    const optionId = replyId.slice(AOI_OPTION_REPLY_PREFIX.length);
    const option = group.options.find((o) => o.id === optionId);
    if (!option) return null;
    const addon: CartLineItemAddon = {
      group_id: group.id,
      group_name: group.name,
      option_id: option.id,
      option_name: option.name,
      price_delta: option.price_delta,
    };
    if (group.selection_type === "single") {
      selected = selected.filter((a) => a.group_id !== group.id);
      selected.push(addon);
      advanceGroup = true;
    } else {
      const exists = selected.some((a) => a.option_id === option.id);
      selected = exists
        ? selected.filter((a) => a.option_id !== option.id)
        : [...selected, addon];
      await persistAoiState(db, run, stateKey, { ...state, selected_addons: selected });
      await sendAddOrderItemGroupPrompt(db, run, node, product, groupIndex, selected);
      return { consumed: true, flow_run_id: run.id, outcome: "advanced" };
    }
  } else {
    return null;
  }

  if (!advanceGroup) return null;

  const nextIndex = groupIndex + 1;
  if (nextIndex >= product.addon_groups.length) {
    return finishAddOrderItem(db, run, node, cfg, nodes, {
      product_id: product.id,
      product_name: product.name,
      unit_price: product.price,
      quantity: 1,
      addons: selected,
    });
  }
  await persistAoiState(db, run, stateKey, {
    step: "addon_group",
    product_id: product.id,
    addon_group_index: nextIndex,
    selected_addons: selected,
  });
  await sendAddOrderItemGroupPrompt(db, run, node, product, nextIndex, selected);
  return { consumed: true, flow_run_id: run.id, outcome: "advanced" };
}

/** Re-sends whatever the customer is currently looking at for an
 *  in-progress `add_order_item` node — used by the fallback/reprompt
 *  path so a garbled reply gets the same prompt again, not a dead run. */
async function resendAddOrderItemPrompt(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  cfg: AddOrderItemNodeConfig,
): Promise<void> {
  const state =
    (run.vars[aoiStateKey(node.node_key)] as AddOrderItemRuntimeState | undefined) ?? {
      step: "product",
    };
  if (state.step === "product" || !state.product_id) {
    await sendAddOrderItemProductPrompt(db, run, node, cfg);
    return;
  }
  const product = await loadProductWithAddonGroups(db, run.account_id, state.product_id);
  if (product) {
    await sendAddOrderItemGroupPrompt(
      db,
      run,
      node,
      product,
      state.addon_group_index ?? 0,
      state.selected_addons ?? [],
    );
  }
}

function formatCartLine(item: CartLineItem, currency: string): string {
  const addons = item.addons ?? [];
  const addonsTotal = addons.reduce((s, a) => s + a.price_delta, 0);
  const lineTotal = (item.unit_price + addonsTotal) * item.quantity;
  const addonsLabel = addons.length
    ? ` (${addons.map((a) => a.option_name).join(", ")})`
    : "";
  return `${item.quantity}x ${item.product_name}${addonsLabel} — ${formatCurrency(lineTotal, currency)}`;
}

async function sendOrderSummaryPrompt(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  cfg: OrderSummaryNodeConfig,
): Promise<void> {
  const cart = (run.vars[cfg.cart_var_key] as CartLineItem[] | undefined) ?? [];
  const currency = await getAccountCurrency(db, run.account_id);
  const { subtotal } = computeCartTotal(cart);
  const lines = cart.map((item) => formatCartLine(item, currency)).join("\n");
  const intro = cfg.intro_text ? `${interpolateVars(cfg.intro_text, run.vars)}\n\n` : "";
  const bodyText = `${intro}${lines}\n\nTotal: ${formatCurrency(subtotal, currency)}\n\n1: Add another item\n2: Finish order`;

  const { whatsapp_message_id } = await engineSendText({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    text: bodyText,
  });
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "order_summary",
    whatsapp_message_id,
  });
  await persistLastPromptMessage(db, run, whatsapp_message_id);
}

/**
 * Creates the `delivery_orders` row from the accumulated cart,
 * clears the cart var, and stashes `vars.last_order_id` for a
 * following `send_message` node to reference. Returns false (and
 * leaves the run suspended on order_summary) on an empty cart or a
 * DB failure — the customer sees no visible change and can retry, and
 * the fallback policy's reprompt path re-sends the same summary.
 */
async function finishOrderFromSummary(
  db: AdminClient,
  run: FlowRunRow,
  cfg: OrderSummaryNodeConfig,
): Promise<boolean> {
  const cart = (run.vars[cfg.cart_var_key] as CartLineItem[] | undefined) ?? [];
  if (cart.length === 0) return false;

  // Fase 5 (Operação): self-service order channels respect business
  // hours; a manual staff order never goes through this Flow node, so
  // this never blocks a phone/counter sale.
  const businessHours = await getBusinessHours(db, run.account_id);
  if (businessHours?.enabled && !isWithinBusinessHours(businessHours.hours, businessHours.timezone)) {
    try {
      await engineSendText({
        accountId: run.account_id,
        userId: run.user_id,
        conversationId: run.conversation_id!,
        contactId: run.contact_id!,
        text: closedMessage(businessHours.hours),
      });
    } catch (err) {
      console.error("[flows] failed to send closed-hours message:", err);
    }
    return false;
  }

  // Motor de Cálculo de Entrega — opt-in via address_var_key (set on
  // the node when an earlier collect_input node captured the
  // customer's address). Omitted = no fee calculated, same behavior
  // as before this field existed.
  let deliveryAddress: string | null = null;
  let deliveryFee: number | null = null;
  if (cfg.address_var_key) {
    deliveryAddress = (run.vars[cfg.address_var_key] as string | undefined)?.trim() || null;
    const { subtotal } = computeCartTotal(cart);
    const feeResult = await calculateDeliveryFeeForAccount(db, run.account_id, {
      address: deliveryAddress,
      subtotal,
    });
    if (!feeResult.ok) {
      try {
        await engineSendText({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: deliveryFeeFailureMessage(feeResult.reason),
        });
      } catch (err) {
        console.error("[flows] failed to send delivery-fee failure message:", err);
      }
      return false;
    }
    deliveryFee = feeResult.fee;
  }

  try {
    const currency = await getAccountCurrency(db, run.account_id);
    const order = await finalizeDeliveryOrder(db, {
      accountId: run.account_id,
      contactId: run.contact_id,
      conversationId: run.conversation_id,
      userId: run.user_id,
      flowRunId: run.id,
      source: "whatsapp_flow",
      cart,
      deliveryAddress,
      deliveryFee,
      currency,
    });
    const newVars: Record<string, unknown> = { ...run.vars, last_order_id: order.id };
    delete newVars[cfg.cart_var_key];
    const { error } = await db
      .from("flow_runs")
      .update({ vars: newVars })
      .eq("id", run.id);
    if (!error) run.vars = newVars;
    return true;
  } catch (err) {
    console.error("[flows] finishOrderFromSummary error:", err);
    return false;
  }
}

async function executeHandoff(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<void> {
  const cfg = node.config as { assign_to?: string; note?: string };
  const convUpdate: Record<string, unknown> = {
    status: "pending",
    // A flow handoff means the bot's deterministic path is done and a
    // human is needed — without this, an unassigned handoff would
    // still read as "the bot is actively eligible to answer" (the
    // PENDENTE vs CHATBOT inbox bucket is derived from this flag).
    ai_autoreply_disabled: true,
    updated_at: new Date().toISOString(),
  };
  if (cfg.assign_to) convUpdate.assigned_agent_id = cfg.assign_to;
  if (run.conversation_id) {
    await db
      .from("conversations")
      .update(convUpdate)
      .eq("id", run.conversation_id);
  }
  await logEvent(db, run.id, "handoff", node.node_key, {
    note: cfg.note ?? null,
    assigned_to: cfg.assign_to ?? null,
  });
  await endRun(db, run.id, "handed_off", "handoff_node");
}

/**
 * Resolve a condition node's subject value from DB / run state, then
 * call the pure `evaluateConditionPredicate`. Splits out so the
 * predicate itself stays unit-testable without a Supabase mock.
 *
 * Subject sources:
 *   - `var` → `flow_runs.vars[subject_key]` (captured by collect_input
 *     or http_fetch in v2).
 *   - `tag` → present iff `contact_tags(contact_id, tag_id)` exists.
 *     `subject_key` IS the tag UUID; the SELECT returns 1 row or 0.
 *   - `contact_field` → one of name/email/phone/company on `contacts`.
 */
async function evaluateConditionNode(
  db: AdminClient,
  run: FlowRunRow,
  cfg: ConditionNodeConfig,
): Promise<boolean> {
  let subjectValue: string | undefined;
  if (cfg.subject === "var") {
    const v = run.vars[cfg.subject_key];
    subjectValue = typeof v === "string" ? v : v === undefined ? undefined : String(v);
  } else if (cfg.subject === "tag") {
    const { count } = await db
      .from("contact_tags")
      .select("contact_id", { count: "exact", head: true })
      .eq("contact_id", run.contact_id!)
      .eq("tag_id", cfg.subject_key);
    // For tags, "present" really is the only meaningful test — the
    // `present`/`absent` operators are the natural fit. equals/contains
    // against a tag UUID would still work mechanically (compare its
    // existence to the value).
    subjectValue = (count ?? 0) > 0 ? cfg.subject_key : undefined;
  } else {
    const ALLOWED = ["name", "email", "phone", "company"] as const;
    type AllowedField = (typeof ALLOWED)[number];
    if (!ALLOWED.includes(cfg.subject_key as AllowedField)) {
      throw new Error(`unsupported contact_field: ${cfg.subject_key}`);
    }
    const { data } = await db
      .from("contacts")
      .select(cfg.subject_key)
      .eq("id", run.contact_id!)
      .maybeSingle();
    const raw = (data as Record<string, unknown> | null)?.[cfg.subject_key];
    subjectValue = typeof raw === "string" && raw.length > 0 ? raw : undefined;
  }
  return evaluateConditionPredicate({
    operator: cfg.operator,
    subjectValue,
    configValue: cfg.value,
  });
}

async function endRun(
  db: AdminClient,
  runId: string,
  status: "completed" | "handed_off" | "timed_out" | "failed",
  reason: string,
): Promise<void> {
  await db
    .from("flow_runs")
    .update({
      status,
      ended_at: new Date().toISOString(),
      end_reason: reason,
    })
    .eq("id", runId);
}

// ============================================================
// The synchronous advance loop. Walks through auto-advance nodes
// until it hits one that suspends (collect_input/numeric_menu/
// add_order_item/order_summary) or terminates (handoff/end). Each
// suspending node persists the
// new current_node_key before returning.
// ============================================================

async function advanceFromNodeKey(
  db: AdminClient,
  run: FlowRunRow,
  startNodeKey: string,
  nodes: Map<string, FlowNodeRow>,
): Promise<{ outcome: "advanced" | "completed" | "handed_off" }> {
  let currentKey: string | null = startNodeKey;
  // Defensive cap — if a flow has a cycle (which the validator
  // SHOULD catch but doesn't yet in v1), we bail rather than loop.
  for (let safety = 0; safety < 64; safety += 1) {
    if (!currentKey) {
      await logEvent(db, run.id, "error", null, {
        reason: "next_node_key was null mid-advance",
      });
      await endRun(db, run.id, "failed", "missing_next_node");
      return { outcome: "completed" };
    }
    const node: FlowNodeRow | null = nodes.get(currentKey) ?? null;
    if (!node) {
      await logEvent(db, run.id, "error", currentKey, {
        reason: "node_not_found",
      });
      await endRun(db, run.id, "failed", "node_not_found");
      return { outcome: "completed" };
    }
    await logEvent(db, run.id, "node_entered", node.node_key, {
      node_type: node.node_type,
    });

    if (node.node_type === "start") {
      currentKey = (node.config as unknown as StartNodeConfig).next_node_key;
      continue;
    }
    if (node.node_type === "send_message") {
      const cfg = node.config as unknown as SendMessageNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.text, run.vars),
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_message",
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_text_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_text_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_media") {
      const cfg = node.config as unknown as SendMediaNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendMedia({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          kind: cfg.media_type,
          link: cfg.media_url,
          caption: cfg.caption
            ? interpolateVars(cfg.caption, run.vars)
            : undefined,
          filename: cfg.filename,
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_media",
          media_type: cfg.media_type,
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_media_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_media_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "collect_input") {
      // Send the prompt and suspend. Customer's next TEXT reply will
      // wake us up via handleReplyForActiveRun's collect_input branch.
      const cfg = node.config as unknown as CollectInputNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "collect_input",
          whatsapp_message_id,
        });
        const { data: msg } = await db
          .from("messages")
          .select("id")
          .eq("message_id", whatsapp_message_id)
          .maybeSingle();
        await db
          .from("flow_runs")
          .update({
            last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
          })
          .eq("id", run.id);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "collect_input_prompt_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "collect_input_prompt_failed");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "condition") {
      const cfg = node.config as unknown as ConditionNodeConfig;
      let branch: "true" | "false";
      try {
        branch = (await evaluateConditionNode(db, run, cfg))
          ? "true"
          : "false";
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "condition_evaluation_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "condition_evaluation_failed");
        return { outcome: "completed" };
      }
      currentKey =
        branch === "true" ? cfg.true_next : cfg.false_next;
      await logEvent(db, run.id, "node_entered", node.node_key, {
        condition_result: branch,
        advancing_to: currentKey,
      });
      continue;
    }
    if (node.node_type === "set_tag") {
      const cfg = node.config as unknown as SetTagNodeConfig;
      try {
        if (cfg.mode === "add") {
          await addContactTagAndDispatch({
            db,
            accountId: run.account_id,
            contactId: run.contact_id!,
            tagId: cfg.tag_id,
            context: {
              conversation_id: run.conversation_id ?? undefined,
              vars: run.vars,
            },
          });
        } else {
          await removeContactTag(db, {
            accountId: run.account_id,
            contactId: run.contact_id!,
            tagId: cfg.tag_id,
          });
        }
      } catch (err) {
        // Non-fatal — log + advance. A tag-write failure shouldn't
        // strand the customer mid-flow.
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "set_tag_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "add_order_item") {
      const cfg = node.config as unknown as AddOrderItemNodeConfig;
      // A fresh (or re-entered, e.g. looped back via order_summary's
      // "add another item") visit always starts at the product-pick
      // step — clear any stale in-flight sub-state left over from an
      // earlier pass through this same node.
      await persistAoiState(db, run, aoiStateKey(node.node_key), undefined);
      let sent: boolean;
      try {
        sent = await sendAddOrderItemProductPrompt(db, run, node, cfg);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "add_order_item_send_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "add_order_item_send_failed");
        return { outcome: "completed" };
      }
      if (!sent) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "add_order_item_no_products",
        });
        await endRun(db, run.id, "failed", "add_order_item_no_products");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "order_summary") {
      const cfg = node.config as unknown as OrderSummaryNodeConfig;
      try {
        await sendOrderSummaryPrompt(db, run, node, cfg);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "order_summary_send_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "order_summary_send_failed");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "numeric_menu") {
      try {
        await sendNumericMenuAndSuspend(db, run, node);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "numeric_menu_send_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "numeric_menu_send_failed");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "handoff") {
      await executeHandoff(db, run, node);
      return { outcome: "handed_off" };
    }
    if (node.node_type === "end") {
      await logEvent(db, run.id, "completed", node.node_key);
      await endRun(db, run.id, "completed", "end_node");
      return { outcome: "completed" };
    }
    // Unknown node type — shouldn't happen given the CHECK constraint.
    await logEvent(db, run.id, "error", node.node_key, {
      reason: `unknown_node_type:${node.node_type}`,
    });
    await endRun(db, run.id, "failed", "unknown_node_type");
    return { outcome: "completed" };
  }
  // Safety break — log + fail.
  await logEvent(db, run.id, "error", currentKey, {
    reason: "advance_loop_safety_break",
  });
  await endRun(db, run.id, "failed", "advance_loop_overflow");
  return { outcome: "completed" };
}

/**
 * Optimistic UPDATE — only advance current_node_key when it matches
 * the value we read at the top of dispatch. If another webhook beat
 * us, the row's pointer has already moved and our UPDATE returns
 * zero rows; we treat that as a no-op and let the other run continue.
 */
async function advanceCurrentNodeKey(
  db: AdminClient,
  runId: string,
  expectedOldKey: string | null,
  newKey: string,
): Promise<boolean> {
  // PostgREST: when expectedOldKey is null we can't `.eq` (would match
  // any row); use `.is('current_node_key', null)` instead.
  let q = db
    .from("flow_runs")
    .update({
      current_node_key: newKey,
      last_advanced_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .eq("status", "active");
  if (expectedOldKey === null) {
    q = q.is("current_node_key", null);
  } else {
    q = q.eq("current_node_key", expectedOldKey);
  }
  const { data, error } = await q.select("id");
  if (error) {
    console.error("[flows] advanceCurrentNodeKey error:", error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

// ============================================================
// Public entry point — the webhook calls this on every inbound.
// ============================================================

export async function dispatchInboundToFlows(
  input: DispatchInboundInput & { isFirstInboundMessage: boolean },
): Promise<DispatchInboundResult> {
  const db = supabaseAdmin();
  try {
    const activeRun = await loadActiveRunForContact(
      db,
      input.accountId,
      input.contactId,
    );

    // Idempotency — only matters if there's already a run for this
    // contact. For new runs, the partial unique index catches duplicate
    // starts at INSERT time.
    if (activeRun) {
      const dupe = await isDuplicateInbound(
        db,
        input.accountId,
        input.contactId,
        input.message.meta_message_id,
      );
      if (dupe) {
        return {
          consumed: true,
          flow_run_id: activeRun.id,
          outcome: "duplicate_inbound_ignored",
        };
      }
      // One SELECT for the whole flow's nodes — advance loop is now
      // in-memory. See loadAllNodes.
      const nodes = await loadAllNodes(db, activeRun.flow_id);
      return handleReplyForActiveRun(db, activeRun, input.message, nodes);
    }

    // No active run → look for a flow whose entry trigger matches.
    const flow = await findEntryFlow(
      db,
      input.accountId,
      input.message,
      input.isFirstInboundMessage,
    );
    if (!flow || !flow.entry_node_id) {
      return { consumed: false, outcome: "no_match" };
    }
    const nodes = await loadAllNodes(db, flow.id);
    return startNewRun(db, flow, input, nodes);
  } catch (err) {
    console.error(
      "[flows] dispatchInboundToFlows threw:",
      err instanceof Error ? err.message : err,
    );
    return { consumed: false, outcome: "no_match" };
  }
}

async function handleReplyForActiveRun(
  db: AdminClient,
  run: FlowRunRow,
  message: ParsedInbound,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  // Note: we intentionally do NOT persist the raw customer text. A
  // `collect_input` prompt that asks "what's your card number?" would
  // otherwise leave the PAN sitting in flow_run_events.payload forever,
  // visible to anyone with access to the runs viewer or the events
  // table. Length is enough for "did they actually reply?" debugging;
  // for the captured value itself, the `node_entered` event already
  // records `captured_key` + `captured_length` after the var is stored.
  await logEvent(db, run.id, "reply_received", run.current_node_key, {
    meta_message_id: message.meta_message_id,
    reply_kind: message.kind,
    reply_id: message.kind === "interactive_reply" ? message.reply_id : null,
    text_length: message.kind === "text" ? message.text.length : null,
  });

  if (!run.current_node_key) {
    // Defensive — a run with status='active' but no current node is
    // malformed. Fail the run rather than spin.
    await endRun(db, run.id, "failed", "active_run_missing_current_node");
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: "no_match",
    };
  }

  const currentNode = nodes.get(run.current_node_key) ?? null;
  if (!currentNode) {
    await endRun(db, run.id, "failed", "current_node_not_found");
    return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
  }

  // add_order_item manages its own multi-turn suspend/resume cycle
  // (product pick, then one suspend per add-on group) — it doesn't fit
  // the single-tap "matched → advance" shape below, so it's handled as
  // its own early return. `null` means the reply wasn't recognised for
  // the node's current sub-step; fall through to the normal
  // fallback/reprompt policy same as any other unmatched reply.
  if (message.kind === "text" && currentNode.node_type === "add_order_item") {
    const replyId = await resolveAoiNumericReply(db, run, currentNode, message.text);
    if (replyId) {
      const result = await handleAddOrderItemReply(db, run, currentNode, replyId, nodes);
      if (result) return result;
    }
  }

  // Two ways a reply can advance:
  //   1. Numbered text reply on a numeric_menu node.
  //   2. Text reply on a collect_input node — capture into vars.
  //   3. Numbered text reply on an order_summary node — "finish"
  //      additionally creates the delivery_orders row (side effect)
  //      before the normal matched→advance codepath below picks it up.
  //
  // Everything else falls through to the fallback policy below.
  let matched: string | null = null;
  if (
    message.kind === "text" &&
    currentNode.node_type === "order_summary"
  ) {
    const cfg = currentNode.config as unknown as OrderSummaryNodeConfig;
    const n = extractLeadingNumber(message.text);
    if (n === 1) {
      matched = cfg.add_more_next_node_key;
    } else if (n === 2) {
      const finished = await finishOrderFromSummary(db, run, cfg);
      if (finished) matched = cfg.finish_next_node_key;
    }
  } else if (
    message.kind === "text" &&
    currentNode.node_type === "collect_input"
  ) {
    const cfg = currentNode.config as unknown as CollectInputNodeConfig;
    const captured = message.text.trim();
    if (captured.length > 0 && cfg.var_key) {
      // Persist captured value + reset reprompt count atomically.
      const newVars = { ...run.vars, [cfg.var_key]: captured };
      const { error: capErr } = await db
        .from("flow_runs")
        .update({
          vars: newVars,
          reprompt_count: 0,
        })
        .eq("id", run.id);
      if (!capErr) {
        // Mirror the UPDATE in-memory so downstream interpolation in
        // the advance loop sees the captured var without us having to
        // re-SELECT the whole row.
        run.vars = newVars;
        run.reprompt_count = 0;
        await logEvent(db, run.id, "node_entered", currentNode.node_key, {
          captured_key: cfg.var_key,
          captured_length: captured.length,
        });
        matched = cfg.next_node_key;
      }
    }
  } else if (
    message.kind === "text" &&
    currentNode.node_type === "numeric_menu"
  ) {
    const cfg = currentNode.config as unknown as NumericMenuNodeConfig;
    matched = matchNumericMenuReply(message.text, cfg.options);
  }

  if (matched) {
    // Reset reprompt count on a successful match. Skip the write when
    // already 0 — the collect_input capture branch above already
    // zeroed it, and interactive-reply matches against a fresh run
    // (post-prior-reset) are also already 0. The previous re-read of
    // the whole row was needed only because we weren't mirroring the
    // capture UPDATE into the in-memory `run`; now that we do, the
    // local copy is the source of truth.
    if (run.reprompt_count !== 0) {
      const { error } = await db
        .from("flow_runs")
        .update({ reprompt_count: 0 })
        .eq("id", run.id);
      if (!error) run.reprompt_count = 0;
    }
    const outcome = await advanceFromNodeKey(db, run, matched, nodes);
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: outcome.outcome,
    };
  }

  // No match → fallback. Apply the policy.
  const policy = resolveFallbackPolicy(
    (await loadFlow(db, run.flow_id))?.fallback_policy,
  );
  const newReprompts = run.reprompt_count + 1;
  await db
    .from("flow_runs")
    .update({ reprompt_count: newReprompts })
    .eq("id", run.id);

  const action = decideFallback({ policy, reprompt_count: newReprompts });
  await logEvent(db, run.id, "fallback_fired", run.current_node_key, {
    action: action.type,
    reprompt_count: newReprompts,
  });
  if (action.type === "ignore") {
    // Don't consume — let automations have a shot at it.
    return { consumed: false, flow_run_id: run.id, outcome: "no_match" };
  }
  if (action.type === "reprompt") {
    // Re-send the same prompt. Same node, no current_node_key change.
    // Every branch here re-sends via the same Meta/WuzAPI channel calls
    // guarded in the main advance loop — same "leaves the run stuck
    // forever" risk on failure, so each gets the same log+endRun
    // treatment (collect_input's own try/catch predates this and
    // intentionally just logs + keeps the run alive for another retry;
    // left as-is).
    if (currentNode.node_type === "collect_input") {
      // Customer typed something we couldn't accept (empty after trim,
      // or var_key missing — rare). Re-send the prompt so they try again.
      const cfg = currentNode.config as unknown as CollectInputNodeConfig;
      try {
        await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
      } catch (err) {
        await logEvent(db, run.id, "error", currentNode.node_key, {
          reason: "reprompt_send_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (currentNode.node_type === "add_order_item") {
      const cfg = currentNode.config as unknown as AddOrderItemNodeConfig;
      try {
        await resendAddOrderItemPrompt(db, run, currentNode, cfg);
      } catch (err) {
        await logEvent(db, run.id, "error", currentNode.node_key, {
          reason: "reprompt_add_order_item_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "reprompt_add_order_item_failed");
        return { consumed: true, flow_run_id: run.id, outcome: "completed" };
      }
    } else if (currentNode.node_type === "order_summary") {
      const cfg = currentNode.config as unknown as OrderSummaryNodeConfig;
      try {
        await sendOrderSummaryPrompt(db, run, currentNode, cfg);
      } catch (err) {
        await logEvent(db, run.id, "error", currentNode.node_key, {
          reason: "reprompt_order_summary_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "reprompt_order_summary_failed");
        return { consumed: true, flow_run_id: run.id, outcome: "completed" };
      }
    } else if (currentNode.node_type === "numeric_menu") {
      try {
        await sendNumericMenuAndSuspend(db, run, currentNode);
      } catch (err) {
        await logEvent(db, run.id, "error", currentNode.node_key, {
          reason: "reprompt_numeric_menu_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "reprompt_numeric_menu_failed");
        return { consumed: true, flow_run_id: run.id, outcome: "completed" };
      }
    }
    return { consumed: true, flow_run_id: run.id, outcome: "fallback_fired" };
  }
  if (action.type === "handoff") {
    if (run.conversation_id) {
      await db
        .from("conversations")
        .update({ status: "pending", updated_at: new Date().toISOString() })
        .eq("id", run.conversation_id);
    }
    await logEvent(db, run.id, "handoff", run.current_node_key, {
      reason: "fallback_exhausted",
    });
    await endRun(db, run.id, "handed_off", "fallback_exhausted");
    return { consumed: true, flow_run_id: run.id, outcome: "handed_off" };
  }
  // action.type === 'end'
  await endRun(db, run.id, "completed", "fallback_exhausted_end");
  return { consumed: true, flow_run_id: run.id, outcome: "completed" };
}

async function startNewRun(
  db: AdminClient,
  flow: FlowRow,
  input: DispatchInboundInput,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  // INSERT — partial unique index `idx_one_active_run_per_contact`
  // catches concurrent inserts with 23505. We catch and return as
  // consumed:true (the parallel webhook handles it).
  const { data: inserted, error: insErr } = await db
    .from("flow_runs")
    .insert({
      flow_id: flow.id,
      // Tenancy: NOT NULL post-017. The partial unique index
      // `idx_one_active_run_per_contact` is over (account_id,
      // contact_id) WHERE status='active', so two accounts sharing
      // a contact phone number each run their own flows independently.
      account_id: flow.account_id,
      // Audit: preserves the flow's author on the run row for log
      // attribution.
      user_id: flow.user_id,
      contact_id: input.contactId,
      conversation_id: input.conversationId,
      status: "active",
      current_node_key: flow.entry_node_id,
    })
    .select("*")
    .maybeSingle();
  if (insErr) {
    // 23505 = unique_violation → another webhook is starting the run.
    const msg = insErr.message ?? "";
    if (msg.includes("23505") || msg.includes("duplicate key")) {
      return { consumed: true, outcome: "duplicate_inbound_ignored" };
    }
    console.error("[flows] startNewRun insert error:", insErr.message);
    return { consumed: false, outcome: "no_match" };
  }
  const run = inserted as FlowRunRow;
  await logEvent(db, run.id, "started", flow.entry_node_id, {
    flow_id: flow.id,
    trigger_type: flow.trigger_type,
    meta_message_id: input.message.meta_message_id,
  });
  // Bump the flow's execution counter — used by the builder UI to
  // surface "X runs since activation" on the flow card.
  //
  // Atomic RPC (migration 012) rather than read-modify-write: two
  // concurrent webhooks starting runs for different contacts on the
  // same flow would otherwise both read N and both write N+1, losing
  // a count. Mirrors the automations engine's use of
  // `increment_automation_execution_count` (migration 007).
  const { error: incErr } = await db.rpc("increment_flow_execution_count", {
    p_flow_id: flow.id,
  });
  if (incErr) {
    // Non-fatal — the run itself succeeded; only the counter is off.
    console.error("[flows] execution_count rpc error:", incErr.message);
  }

  // Run the advance loop starting from the entry node.
  const outcome = await advanceFromNodeKey(db, run, flow.entry_node_id!, nodes);
  return {
    consumed: true,
    flow_run_id: run.id,
    outcome: outcome.outcome === "advanced" ? "started" : outcome.outcome,
  };
}
