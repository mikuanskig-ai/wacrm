import { describe, it, expect } from "vitest";
import { advance, reply, createInitialState, type SimNode, type SimProduct } from "./simulate";

function nodes(list: SimNode[]): Map<string, SimNode> {
  const map = new Map<string, SimNode>();
  for (const n of list) map.set(n.node_key, n);
  return map;
}

describe("advance", () => {
  it("interpolates vars in send_message and auto-advances to end", () => {
    const graph = nodes([
      { node_key: "start", node_type: "start", config: { next_node_key: "hello" } },
      {
        node_key: "hello",
        node_type: "send_message",
        config: { text: "Hi {{vars.name}}!", next_node_key: "end" },
      },
      { node_key: "end", node_type: "end", config: {} },
    ]);
    const state = createInitialState({ name: "Ana" });
    state.vars.name = "Ana";
    const result = advance(graph, "start", state, [], new Map());
    expect(result.state.status).toBe("ended");
    expect(result.messages.map((m) => m.text)).toContain("Hi Ana!");
  });

  it("branches a condition on a var", () => {
    const graph = nodes([
      {
        node_key: "c",
        node_type: "condition",
        config: { subject: "var", subject_key: "vip", operator: "equals", value: "yes", true_next: "yes_msg", false_next: "no_msg" },
      },
      { node_key: "yes_msg", node_type: "send_message", config: { text: "VIP", next_node_key: "end" } },
      { node_key: "no_msg", node_type: "send_message", config: { text: "Regular", next_node_key: "end" } },
      { node_key: "end", node_type: "end", config: {} },
    ]);
    const state = createInitialState({});
    state.vars.vip = "yes";
    const result = advance(graph, "c", state, [], new Map());
    expect(result.messages.map((m) => m.text)).toContain("VIP");
  });

  it("branches a condition on a simulated tag", () => {
    const graph = nodes([
      {
        node_key: "c",
        node_type: "condition",
        config: { subject: "tag", subject_key: "tag-1", operator: "present", true_next: "yes_msg", false_next: "no_msg" },
      },
      { node_key: "yes_msg", node_type: "send_message", config: { text: "Has tag", next_node_key: "end" } },
      { node_key: "no_msg", node_type: "send_message", config: { text: "No tag", next_node_key: "end" } },
      { node_key: "end", node_type: "end", config: {} },
    ]);
    const state = createInitialState({});
    state.tagIds.add("tag-1");
    const result = advance(graph, "c", state, [], new Map());
    expect(result.messages.map((m) => m.text)).toContain("Has tag");
  });

  it("branches a condition on a simulated contact field", () => {
    const graph = nodes([
      {
        node_key: "c",
        node_type: "condition",
        config: { subject: "contact_field", subject_key: "company", operator: "present", true_next: "yes_msg", false_next: "no_msg" },
      },
      { node_key: "yes_msg", node_type: "send_message", config: { text: "Has company", next_node_key: "end" } },
      { node_key: "no_msg", node_type: "send_message", config: { text: "No company", next_node_key: "end" } },
      { node_key: "end", node_type: "end", config: {} },
    ]);
    const state = createInitialState({ company: "Acme" });
    const result = advance(graph, "c", state, [], new Map());
    expect(result.messages.map((m) => m.text)).toContain("Has company");
  });

  it("set_tag mutates the simulated tag set and reports the tag name", () => {
    const graph = nodes([
      { node_key: "t", node_type: "set_tag", config: { mode: "add", tag_id: "tag-1", next_node_key: "end" } },
      { node_key: "end", node_type: "end", config: {} },
    ]);
    const state = createInitialState({});
    const result = advance(graph, "t", state, [], new Map([["tag-1", "VIP"]]));
    expect(result.state.tagIds.has("tag-1")).toBe(true);
    expect(result.messages.some((m) => m.text.includes("VIP"))).toBe(true);
  });

  it("suspends on collect_input and captures the reply into vars", () => {
    const graph = nodes([
      { node_key: "ask", node_type: "collect_input", config: { prompt_text: "Your name?", var_key: "name", next_node_key: "thanks" } },
      { node_key: "thanks", node_type: "send_message", config: { text: "Thanks {{vars.name}}", next_node_key: "end" } },
      { node_key: "end", node_type: "end", config: {} },
    ]);
    const started = advance(graph, "ask", createInitialState({}), [], new Map());
    expect(started.state.status).toBe("running");
    expect(started.state.currentNodeKey).toBe("ask");

    const replied = reply(graph, started.state, "Bruno", [], new Map());
    expect(replied.state.vars.name).toBe("Bruno");
    expect(replied.messages.map((m) => m.text)).toContain("Thanks Bruno");
    expect(replied.state.status).toBe("ended");
  });

  it("resolves a numeric_menu reply by number and by label, and rejects garbage", () => {
    const graph = nodes([
      {
        node_key: "menu",
        node_type: "numeric_menu",
        config: {
          prompt_text: "Choose",
          options: [
            { label: "Financeiro", next_node_key: "fin" },
            { label: "Comercial", next_node_key: "com" },
          ],
        },
      },
      { node_key: "fin", node_type: "send_message", config: { text: "Financeiro path", next_node_key: "end" } },
      { node_key: "com", node_type: "send_message", config: { text: "Comercial path", next_node_key: "end" } },
      { node_key: "end", node_type: "end", config: {} },
    ]);
    const started = advance(graph, "menu", createInitialState({}), [], new Map());

    const byNumber = reply(graph, started.state, "2", [], new Map());
    expect(byNumber.messages.map((m) => m.text)).toContain("Comercial path");

    const byLabel = reply(graph, started.state, "financeiro", [], new Map());
    expect(byLabel.messages.map((m) => m.text)).toContain("Financeiro path");

    const garbage = reply(graph, started.state, "xyz", [], new Map());
    expect(garbage.state.status).toBe("running");
    expect(garbage.messages[0].text).toContain("Não entendi");
  });

  it("ends the run on a handoff node", () => {
    const graph = nodes([
      { node_key: "h", node_type: "handoff", config: { note: "escalate" } },
    ]);
    const result = advance(graph, "h", createInitialState({}), [], new Map());
    expect(result.state.status).toBe("handed_off");
    expect(result.messages.some((m) => m.text.includes("escalate"))).toBe(true);
  });

  it("walks a full add_order_item → order_summary cart flow", () => {
    const catalog: SimProduct[] = [
      {
        id: "p1",
        name: "Pizza",
        price: 30,
        category_id: null,
        addon_groups: [
          {
            id: "g1",
            name: "Size",
            selection_type: "single",
            is_required: true,
            options: [
              { id: "o1", name: "Small", price_delta: 0 },
              { id: "o2", name: "Large", price_delta: 10 },
            ],
          },
        ],
      },
    ];
    const graph = nodes([
      {
        node_key: "add",
        node_type: "add_order_item",
        config: { prompt_text: "Pick a product", button_label: "Menu", cart_var_key: "cart", next_node_key: "summary" },
      },
      {
        node_key: "summary",
        node_type: "order_summary",
        config: { cart_var_key: "cart", add_more_next_node_key: "add", finish_next_node_key: "done" },
      },
      { node_key: "done", node_type: "send_message", config: { text: "Order placed", next_node_key: "end" } },
      { node_key: "end", node_type: "end", config: {} },
    ]);

    const started = advance(graph, "add", createInitialState({}), catalog, new Map());
    expect(started.state.currentNodeKey).toBe("add");

    // Pick product 1 (Pizza) — has a required addon group, so it should
    // suspend again on the size picker rather than finishing immediately.
    const pickedProduct = reply(graph, started.state, "1", catalog, new Map());
    expect(pickedProduct.messages[0].text).toContain("Size");

    // Pick addon option 2 (Large, +10) — required single-select group,
    // so this should auto-finish the item and land on order_summary.
    const pickedAddon = reply(graph, pickedProduct.state, "2", catalog, new Map());
    expect(pickedAddon.messages.some((m) => m.text.includes("Total: R$ 40,00"))).toBe(true);

    // Finish the order (option 2 on the summary prompt).
    const finished = reply(graph, pickedAddon.state, "2", catalog, new Map());
    expect(finished.state.vars.last_order_id).toBe("SIMULADO");
    expect(finished.messages.some((m) => m.text.includes("Order placed"))).toBe(true);
    expect((finished.state.vars.cart as unknown[] | undefined)).toBeUndefined();
  });
});
