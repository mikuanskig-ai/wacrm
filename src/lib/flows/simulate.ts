/**
 * Client-safe flow simulator — walks the SAME node graph the real
 * runner (engine.ts) walks, using the SAME pure predicates
 * (predicates.ts: matchesKeywordTrigger, evaluateConditionPredicate,
 * matchNumericMenuReply, interpolateVars, isAutoAdvancing/isSuspending/
 * isTerminal), but never touches Supabase or sends a real WhatsApp
 * message — every "send" becomes a transcript entry, tag writes touch
 * an in-memory Set, and a "completed" order is never actually created.
 *
 * Runs against the flow editor's current (possibly unsaved) node list
 * — testing a flow doesn't require saving it first, same reasoning as
 * the AI Playground testing an unsaved system prompt.
 *
 * Not reused from engine.ts: the DB I/O (loadFlow, logEvent, ...) and
 * anything that writes real rows (finalizeDeliveryOrder, real tag
 * writes, real Meta sends) — those are exactly what a simulation must
 * never do. Everything that IS pure decision logic lives in
 * predicates.ts and is shared verbatim.
 */

import {
  evaluateConditionPredicate,
  extractLeadingNumber,
  interpolateVars,
  matchNumericMenuReply,
} from "./predicates";
import type {
  AddOrderItemNodeConfig,
  CollectInputNodeConfig,
  ConditionNodeConfig,
  HandoffNodeConfig,
  NumericMenuNodeConfig,
  OrderSummaryNodeConfig,
  SendMediaNodeConfig,
  SendMessageNodeConfig,
  SetTagNodeConfig,
  StartNodeConfig,
} from "./types";

export interface SimNode {
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
}

export interface SimAddonOption {
  id: string;
  name: string;
  price_delta: number;
}

export interface SimAddonGroup {
  id: string;
  name: string;
  selection_type: "single" | "multiple";
  is_required: boolean;
  options: SimAddonOption[];
}

export interface SimProduct {
  id: string;
  name: string;
  price: number;
  category_id: string | null;
  addon_groups: SimAddonGroup[];
}

export interface SimCartAddon {
  group_id: string;
  group_name: string;
  option_id: string;
  option_name: string;
  price_delta: number;
}

export interface SimCartItem {
  product_id: string;
  product_name: string;
  unit_price: number;
  quantity: number;
  addons: SimCartAddon[];
}

export interface SimContact {
  name?: string;
  email?: string;
  phone?: string;
  company?: string;
}

interface AoiSubState {
  step: "product" | "addon_group" | "quantity";
  product_id?: string;
  addon_group_index?: number;
  selected_addons?: SimCartAddon[];
}

export interface SimState {
  vars: Record<string, unknown>;
  tagIds: Set<string>;
  contact: SimContact;
  aoiState: Record<string, AoiSubState>;
  currentNodeKey: string | null;
  status: "not_started" | "running" | "handed_off" | "ended";
  endReason?: string;
}

export interface SimMessage {
  from: "bot" | "system";
  text: string;
}

export interface SimStepResult {
  state: SimState;
  messages: SimMessage[];
}

export function createInitialState(contact: SimContact): SimState {
  return {
    vars: {},
    tagIds: new Set(),
    contact,
    aoiState: {},
    currentNodeKey: null,
    status: "not_started",
  };
}

const AOI_OPTION_PREFIX = "aoi_opt:";
const AOI_DONE_PREFIX = "aoi_done:";
const AOI_SKIP_PREFIX = "aoi_skip:";
// Mirrors AOI_MAX_QUANTITY in engine.ts — same ceiling add_to_cart's
// own quantity clamp uses (tools/delivery.ts).
const AOI_MAX_QUANTITY = 20;

function formatMoney(cents: number): string {
  return `R$ ${cents.toFixed(2).replace(".", ",")}`;
}

function productsFor(catalog: SimProduct[], categoryId?: string): SimProduct[] {
  const list = categoryId ? catalog.filter((p) => p.category_id === categoryId) : catalog;
  return list.slice(0, 10);
}

function renderProductPrompt(cfg: AddOrderItemNodeConfig, products: SimProduct[], vars: Record<string, unknown>): string {
  const lines = products.map((p, i) => `${i + 1}: ${p.name} — ${formatMoney(p.price)}`).join("\n");
  return `${interpolateVars(cfg.prompt_text, vars)}\n\n${lines}`;
}

function renderAddonGroupPrompt(
  product: SimProduct,
  group: SimAddonGroup,
  selected: SimCartAddon[],
): string {
  const selectedIds = new Set(selected.filter((a) => a.group_id === group.id).map((a) => a.option_id));
  const optionLines = group.options.map(
    (o) => `${selectedIds.has(o.id) ? "✅ " : ""}${o.name}${o.price_delta !== 0 ? ` (${formatMoney(o.price_delta)})` : ""}`,
  );
  const controlLines: string[] = [];
  if (group.selection_type === "multiple") controlLines.push("✅ Concluir");
  if (!group.is_required) controlLines.push("Pular");
  const all = [...optionLines, ...controlLines];
  const menu = all.map((l, i) => `${i + 1}: ${l}`).join("\n");
  return `${product.name} — ${group.name}${group.is_required ? " *" : ""}\n\n${menu}`;
}

function renderQuantityPrompt(product: SimProduct): string {
  return `How many units of ${product.name} would you like?`;
}

function aoiGroupReplyIds(group: SimAddonGroup): string[] {
  const ids = group.options.map((o) => `${AOI_OPTION_PREFIX}${o.id}`);
  if (group.selection_type === "multiple") ids.push(`${AOI_DONE_PREFIX}${group.id}`);
  if (!group.is_required) ids.push(`${AOI_SKIP_PREFIX}${group.id}`);
  return ids;
}

function cartLine(item: SimCartItem): string {
  const addonsTotal = item.addons.reduce((s, a) => s + a.price_delta, 0);
  const lineTotal = (item.unit_price + addonsTotal) * item.quantity;
  const addonsLabel = item.addons.length ? ` (${item.addons.map((a) => a.option_name).join(", ")})` : "";
  return `${item.quantity}x ${item.product_name}${addonsLabel} — ${formatMoney(lineTotal)}`;
}

/**
 * Walks auto-advancing nodes (start/send_message/send_media/condition/
 * set_tag) starting at `startKey` until it hits a suspending node
 * (waits for the simulated customer) or a terminal one (handoff/end).
 * Mutates and returns a new SimState + the transcript entries produced
 * along the way — mirrors advanceFromNodeKey in engine.ts node-for-node,
 * against in-memory state instead of flow_runs/messages/contact_tags.
 */
export function advance(
  nodesByKey: Map<string, SimNode>,
  startKey: string,
  prevState: SimState,
  catalog: SimProduct[],
  tagNamesById: Map<string, string>,
): SimStepResult {
  const state: SimState = {
    ...prevState,
    vars: { ...prevState.vars },
    tagIds: new Set(prevState.tagIds),
    aoiState: { ...prevState.aoiState },
    status: "running",
  };
  const messages: SimMessage[] = [];
  let currentKey: string | null = startKey;

  for (let safety = 0; safety < 64; safety += 1) {
    if (!currentKey) {
      state.status = "ended";
      state.endReason = "missing_next_node";
      messages.push({ from: "system", text: "⚠️ Fluxo interrompido: próximo nó não definido." });
      return { state, messages };
    }
    const node = nodesByKey.get(currentKey);
    if (!node) {
      state.status = "ended";
      state.endReason = "node_not_found";
      messages.push({ from: "system", text: `⚠️ Fluxo interrompido: nó "${currentKey}" não encontrado.` });
      return { state, messages };
    }

    if (node.node_type === "start") {
      currentKey = (node.config as unknown as StartNodeConfig).next_node_key;
      continue;
    }

    if (node.node_type === "send_message") {
      const cfg = node.config as unknown as SendMessageNodeConfig;
      messages.push({ from: "bot", text: interpolateVars(cfg.text, state.vars) });
      currentKey = cfg.next_node_key;
      continue;
    }

    if (node.node_type === "send_media") {
      const cfg = node.config as unknown as SendMediaNodeConfig;
      const caption = cfg.caption ? interpolateVars(cfg.caption, state.vars) : "";
      messages.push({
        from: "bot",
        text: `📎 [${cfg.media_type}]${cfg.filename ? ` ${cfg.filename}` : ""}${caption ? `\n${caption}` : ""}`,
      });
      currentKey = cfg.next_node_key;
      continue;
    }

    if (node.node_type === "condition") {
      const cfg = node.config as unknown as ConditionNodeConfig;
      let subjectValue: string | undefined;
      if (cfg.subject === "var") {
        const v = state.vars[cfg.subject_key];
        subjectValue = typeof v === "string" ? v : v === undefined ? undefined : String(v);
      } else if (cfg.subject === "tag") {
        subjectValue = state.tagIds.has(cfg.subject_key) ? cfg.subject_key : undefined;
      } else {
        const field = state.contact[cfg.subject_key as keyof SimContact];
        subjectValue = field && field.length > 0 ? field : undefined;
      }
      const result = evaluateConditionPredicate({
        operator: cfg.operator,
        subjectValue,
        configValue: cfg.value,
      });
      currentKey = result ? cfg.true_next : cfg.false_next;
      continue;
    }

    if (node.node_type === "set_tag") {
      const cfg = node.config as unknown as SetTagNodeConfig;
      const tagName = tagNamesById.get(cfg.tag_id) ?? cfg.tag_id;
      if (cfg.mode === "add") {
        state.tagIds.add(cfg.tag_id);
        messages.push({ from: "system", text: `🏷️ Tag "${tagName}" adicionada ao contato.` });
      } else {
        state.tagIds.delete(cfg.tag_id);
        messages.push({ from: "system", text: `🏷️ Tag "${tagName}" removida do contato.` });
      }
      currentKey = cfg.next_node_key;
      continue;
    }

    if (node.node_type === "collect_input") {
      const cfg = node.config as unknown as CollectInputNodeConfig;
      messages.push({ from: "bot", text: interpolateVars(cfg.prompt_text, state.vars) });
      state.currentNodeKey = node.node_key;
      return { state, messages };
    }

    if (node.node_type === "numeric_menu") {
      const cfg = node.config as unknown as NumericMenuNodeConfig;
      const menu = cfg.options.map((o, i) => `${i + 1}: ${o.label}`).join("\n");
      const header = cfg.header_text ? `${interpolateVars(cfg.header_text, state.vars)}\n\n` : "";
      const footer = cfg.footer_text ? `\n\n${interpolateVars(cfg.footer_text, state.vars)}` : "";
      messages.push({
        from: "bot",
        text: `${header}${interpolateVars(cfg.prompt_text, state.vars)}\n\n${menu}${footer}`,
      });
      state.currentNodeKey = node.node_key;
      return { state, messages };
    }

    if (node.node_type === "add_order_item") {
      const cfg = node.config as unknown as AddOrderItemNodeConfig;
      delete state.aoiState[node.node_key];
      const products = productsFor(catalog, cfg.category_id);
      if (products.length === 0) {
        state.status = "ended";
        state.endReason = "add_order_item_no_products";
        messages.push({ from: "system", text: "⚠️ Nenhum produto ativo disponível para este nó." });
        return { state, messages };
      }
      messages.push({ from: "bot", text: renderProductPrompt(cfg, products, state.vars) });
      state.aoiState[node.node_key] = { step: "product" };
      state.currentNodeKey = node.node_key;
      return { state, messages };
    }

    if (node.node_type === "order_summary") {
      const cfg = node.config as unknown as OrderSummaryNodeConfig;
      const cart = (state.vars[cfg.cart_var_key] as SimCartItem[] | undefined) ?? [];
      const lines = cart.map(cartLine).join("\n");
      const subtotal = cart.reduce((sum, item) => {
        const addonsTotal = item.addons.reduce((s, a) => s + a.price_delta, 0);
        return sum + (item.unit_price + addonsTotal) * item.quantity;
      }, 0);
      const intro = cfg.intro_text ? `${interpolateVars(cfg.intro_text, state.vars)}\n\n` : "";
      const feeNote = cfg.address_var_key
        ? "\n(taxa de entrega real calculada apenas em um pedido de verdade)"
        : "";
      messages.push({
        from: "bot",
        text: `${intro}${lines}\n\nTotal: ${formatMoney(subtotal)}${feeNote}\n\n1: Adicionar outro item\n2: Finalizar pedido`,
      });
      state.currentNodeKey = node.node_key;
      return { state, messages };
    }

    if (node.node_type === "handoff") {
      const cfg = node.config as unknown as HandoffNodeConfig;
      state.status = "handed_off";
      messages.push({
        from: "system",
        text: `🤝 Transferido para atendimento humano.${cfg.note ? ` Nota: ${cfg.note}` : ""}`,
      });
      return { state, messages };
    }

    if (node.node_type === "end") {
      state.status = "ended";
      state.endReason = "end_node";
      messages.push({ from: "system", text: "✅ Fluxo encerrado." });
      return { state, messages };
    }

    // Unknown node type — shouldn't happen with a valid graph.
    state.status = "ended";
    state.endReason = "unknown_node_type";
    messages.push({ from: "system", text: `⚠️ Tipo de nó desconhecido: "${node.node_type}".` });
    return { state, messages };
  }

  state.status = "ended";
  state.endReason = "safety_cap";
  messages.push({ from: "system", text: "⚠️ Simulação interrompida: possível ciclo no fluxo (limite de 64 nós)." });
  return { state, messages };
}

/**
 * Resolves the simulated customer's reply against whichever node the
 * simulation is currently suspended on, then either re-suspends (same
 * node, next sub-step) or calls `advance` to continue the graph.
 */
export function reply(
  nodesByKey: Map<string, SimNode>,
  prevState: SimState,
  userText: string,
  catalog: SimProduct[],
  tagNamesById: Map<string, string>,
): SimStepResult {
  const node = prevState.currentNodeKey ? nodesByKey.get(prevState.currentNodeKey) : undefined;
  if (!node) {
    return {
      state: { ...prevState, status: "ended", endReason: "no_active_node" },
      messages: [{ from: "system", text: "⚠️ Nenhum nó ativo para responder." }],
    };
  }

  if (node.node_type === "collect_input") {
    const cfg = node.config as unknown as CollectInputNodeConfig;
    const nextVars = { ...prevState.vars, [cfg.var_key]: userText.trim() };
    return advance(nodesByKey, cfg.next_node_key, { ...prevState, vars: nextVars }, catalog, tagNamesById);
  }

  if (node.node_type === "numeric_menu") {
    const cfg = node.config as unknown as NumericMenuNodeConfig;
    const nextKey = matchNumericMenuReply(userText, cfg.options);
    if (!nextKey) {
      return {
        state: prevState,
        messages: [{ from: "system", text: "🤖 Não entendi. Responda com o número de uma das opções." }],
      };
    }
    return advance(nodesByKey, nextKey, prevState, catalog, tagNamesById);
  }

  if (node.node_type === "add_order_item") {
    return handleAddOrderItemReply(nodesByKey, prevState, node, userText, catalog, tagNamesById);
  }

  if (node.node_type === "order_summary") {
    const cfg = node.config as unknown as OrderSummaryNodeConfig;
    const n = userText.trim().match(/^(\d+)/)?.[1];
    if (n === "1") {
      return advance(nodesByKey, cfg.add_more_next_node_key, prevState, catalog, tagNamesById);
    }
    if (n === "2") {
      const cart = (prevState.vars[cfg.cart_var_key] as SimCartItem[] | undefined) ?? [];
      if (cart.length === 0) {
        return {
          state: prevState,
          messages: [{ from: "system", text: "🤖 O carrinho está vazio." }],
        };
      }
      const newVars: Record<string, unknown> = { ...prevState.vars, last_order_id: "SIMULADO" };
      delete newVars[cfg.cart_var_key];
      const withConfirm = advance(
        nodesByKey,
        cfg.finish_next_node_key,
        { ...prevState, vars: newVars },
        catalog,
        tagNamesById,
      );
      return {
        state: withConfirm.state,
        messages: [
          { from: "system", text: "🧾 Pedido simulado — nenhum pedido real foi criado." },
          ...withConfirm.messages,
        ],
      };
    }
    return {
      state: prevState,
      messages: [{ from: "system", text: "🤖 Responda 1 ou 2." }],
    };
  }

  return {
    state: { ...prevState, status: "ended", endReason: "unhandled_suspend_type" },
    messages: [{ from: "system", text: `⚠️ Não sei como simular respostas para "${node.node_type}".` }],
  };
}

function handleAddOrderItemReply(
  nodesByKey: Map<string, SimNode>,
  prevState: SimState,
  node: SimNode,
  userText: string,
  catalog: SimProduct[],
  tagNamesById: Map<string, string>,
): SimStepResult {
  const cfg = node.config as unknown as AddOrderItemNodeConfig;
  const state: SimState = { ...prevState, aoiState: { ...prevState.aoiState } };
  const sub = state.aoiState[node.node_key] ?? { step: "product" as const };
  const n = extractLeadingNumber(userText);
  if (n === null) {
    return { state: prevState, messages: [{ from: "system", text: "🤖 Responda com o número de uma opção." }] };
  }

  if (sub.step === "product" || !sub.product_id) {
    const products = productsFor(catalog, cfg.category_id);
    const product = products[n - 1];
    if (!product) {
      return { state: prevState, messages: [{ from: "system", text: "🤖 Opção inválida." }] };
    }
    if (product.addon_groups.length === 0) {
      state.aoiState[node.node_key] = { step: "quantity", product_id: product.id, selected_addons: [] };
      return { state, messages: [{ from: "bot", text: renderQuantityPrompt(product) }] };
    }
    state.aoiState[node.node_key] = { step: "addon_group", product_id: product.id, addon_group_index: 0, selected_addons: [] };
    return {
      state,
      messages: [{ from: "bot", text: renderAddonGroupPrompt(product, product.addon_groups[0], []) }],
    };
  }

  if (sub.step === "quantity") {
    const product = catalog.find((p) => p.id === sub.product_id);
    if (!product) {
      return { state: prevState, messages: [{ from: "system", text: "🤖 Não foi possível continuar — produto não encontrado." }] };
    }
    const quantity = Math.min(Math.max(Math.trunc(n), 1), AOI_MAX_QUANTITY);
    return finishAddOrderItem(nodesByKey, state, node, cfg, catalog, tagNamesById, {
      product_id: product.id,
      product_name: product.name,
      unit_price: product.price,
      quantity,
      addons: sub.selected_addons ?? [],
    });
  }

  const product = catalog.find((p) => p.id === sub.product_id);
  const groupIndex = sub.addon_group_index ?? 0;
  const group = product?.addon_groups[groupIndex];
  if (!product || !group) {
    return { state: prevState, messages: [{ from: "system", text: "🤖 Não foi possível continuar — produto/grupo não encontrado." }] };
  }
  const ids = aoiGroupReplyIds(group);
  const replyId = ids[n - 1];
  if (!replyId) {
    return { state: prevState, messages: [{ from: "system", text: "🤖 Opção inválida." }] };
  }

  let selected = [...(sub.selected_addons ?? [])];
  let advanceGroup = false;

  if (replyId === `${AOI_DONE_PREFIX}${group.id}` || replyId === `${AOI_SKIP_PREFIX}${group.id}`) {
    if (group.is_required && !selected.some((a) => a.group_id === group.id)) {
      return { state: prevState, messages: [{ from: "bot", text: renderAddonGroupPrompt(product, group, selected) }] };
    }
    advanceGroup = true;
  } else if (replyId.startsWith(AOI_OPTION_PREFIX)) {
    const optionId = replyId.slice(AOI_OPTION_PREFIX.length);
    const option = group.options.find((o) => o.id === optionId);
    if (!option) return { state: prevState, messages: [{ from: "system", text: "🤖 Opção inválida." }] };
    const addon: SimCartAddon = {
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
      selected = exists ? selected.filter((a) => a.option_id !== option.id) : [...selected, addon];
      state.aoiState[node.node_key] = { ...sub, selected_addons: selected };
      return { state, messages: [{ from: "bot", text: renderAddonGroupPrompt(product, group, selected) }] };
    }
  } else {
    return { state: prevState, messages: [{ from: "system", text: "🤖 Opção inválida." }] };
  }

  if (!advanceGroup) return { state: prevState, messages: [] };

  const nextIndex = groupIndex + 1;
  if (nextIndex >= product.addon_groups.length) {
    state.aoiState[node.node_key] = { step: "quantity", product_id: product.id, selected_addons: selected };
    return { state, messages: [{ from: "bot", text: renderQuantityPrompt(product) }] };
  }
  state.aoiState[node.node_key] = { step: "addon_group", product_id: product.id, addon_group_index: nextIndex, selected_addons: selected };
  return {
    state,
    messages: [{ from: "bot", text: renderAddonGroupPrompt(product, product.addon_groups[nextIndex], selected) }],
  };
}

function finishAddOrderItem(
  nodesByKey: Map<string, SimNode>,
  state: SimState,
  node: SimNode,
  cfg: AddOrderItemNodeConfig,
  catalog: SimProduct[],
  tagNamesById: Map<string, string>,
  item: SimCartItem,
): SimStepResult {
  const cart = (state.vars[cfg.cart_var_key] as SimCartItem[] | undefined) ?? [];
  const newAoi = { ...state.aoiState };
  delete newAoi[node.node_key];
  const nextState: SimState = {
    ...state,
    vars: { ...state.vars, [cfg.cart_var_key]: [...cart, item] },
    aoiState: newAoi,
  };
  return advance(nodesByKey, cfg.next_node_key, nextState, catalog, tagNamesById);
}

