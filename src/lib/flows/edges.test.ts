import { describe, it, expect } from "vitest";
import {
  applyEdgeConnection,
  deriveCanvasEdges,
  outgoingSlots,
  unlinkNodeReferences,
} from "./edges";
import type { BuilderNode } from "@/components/flows/shared";

function nodes(...ns: BuilderNode[]): BuilderNode[] {
  return ns;
}

describe("deriveCanvasEdges — single-outgoing node types", () => {
  it("derives a `next` edge from send_message", () => {
    const edges = deriveCanvasEdges(
      nodes(
        {
          node_key: "a",
          node_type: "send_message",
          config: { text: "hi", next_node_key: "b" },
        },
        { node_key: "b", node_type: "end", config: {} },
      ),
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      source: "a",
      target: "b",
      sourceHandle: "next",
    });
  });

  it("derives a `next` edge from send_media, set_tag, collect_input, start", () => {
    const edges = deriveCanvasEdges(
      nodes(
        { node_key: "s", node_type: "start", config: { next_node_key: "m" } },
        {
          node_key: "m",
          node_type: "send_media",
          config: {
            media_type: "image",
            media_url: "https://x/y.png",
            next_node_key: "t",
          },
        },
        {
          node_key: "t",
          node_type: "set_tag",
          config: { mode: "add", tag_id: "u", next_node_key: "ci" },
        },
        {
          node_key: "ci",
          node_type: "collect_input",
          config: {
            prompt_text: "p",
            var_key: "v",
            next_node_key: "e",
          },
        },
        { node_key: "e", node_type: "end", config: {} },
      ),
    );
    expect(edges).toHaveLength(4);
    expect(edges.map((e) => `${e.source}->${e.target}`)).toEqual([
      "s->m",
      "m->t",
      "t->ci",
      "ci->e",
    ]);
  });

  it("derives a `next` edge from add_order_item", () => {
    const edges = deriveCanvasEdges(
      nodes(
        {
          node_key: "aoi",
          node_type: "add_order_item",
          config: {
            prompt_text: "Choose an item:",
            button_label: "View menu",
            cart_var_key: "cart",
            next_node_key: "summary",
          },
        },
        { node_key: "summary", node_type: "end", config: {} },
      ),
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      source: "aoi",
      target: "summary",
      sourceHandle: "next",
    });
  });

  it("skips dangling edges (next_node_key pointing nowhere)", () => {
    const edges = deriveCanvasEdges(
      nodes({
        node_key: "a",
        node_type: "send_message",
        config: { text: "hi", next_node_key: "ghost" },
      }),
    );
    expect(edges).toEqual([]);
  });

  it("skips empty next_node_key (fresh node)", () => {
    const edges = deriveCanvasEdges(
      nodes({
        node_key: "a",
        node_type: "send_message",
        config: { text: "hi", next_node_key: "" },
      }),
    );
    expect(edges).toEqual([]);
  });
});

describe("deriveCanvasEdges — condition (true/false branches)", () => {
  it("produces a labeled edge for each branch", () => {
    const edges = deriveCanvasEdges(
      nodes(
        {
          node_key: "c",
          node_type: "condition",
          config: {
            subject: "var",
            subject_key: "x",
            operator: "equals",
            value: "y",
            true_next: "t",
            false_next: "f",
          },
        },
        { node_key: "t", node_type: "end", config: {} },
        { node_key: "f", node_type: "end", config: {} },
      ),
    );
    expect(edges).toHaveLength(2);
    expect(edges.find((e) => e.sourceHandle === "true")).toMatchObject({
      target: "t",
      label: "true",
    });
    expect(edges.find((e) => e.sourceHandle === "false")).toMatchObject({
      target: "f",
      label: "false",
    });
  });

  it("emits whichever branches are set when one points nowhere", () => {
    const edges = deriveCanvasEdges(
      nodes(
        {
          node_key: "c",
          node_type: "condition",
          config: {
            subject: "var",
            subject_key: "x",
            operator: "present",
            true_next: "t",
            false_next: "",
          },
        },
        { node_key: "t", node_type: "end", config: {} },
      ),
    );
    expect(edges).toHaveLength(1);
    expect(edges[0].sourceHandle).toBe("true");
  });
});

describe("deriveCanvasEdges — order_summary (add_more/finish branches)", () => {
  it("produces a labeled edge for each branch", () => {
    const edges = deriveCanvasEdges(
      nodes(
        {
          node_key: "summary",
          node_type: "order_summary",
          config: {
            cart_var_key: "cart",
            add_more_next_node_key: "aoi",
            finish_next_node_key: "done",
          },
        },
        { node_key: "aoi", node_type: "end", config: {} },
        { node_key: "done", node_type: "end", config: {} },
      ),
    );
    expect(edges).toHaveLength(2);
    expect(edges.find((e) => e.sourceHandle === "add_more")).toMatchObject({
      target: "aoi",
      label: "Add another",
    });
    expect(edges.find((e) => e.sourceHandle === "finish")).toMatchObject({
      target: "done",
      label: "Finish",
    });
  });

  it("emits whichever branch is set when the other points nowhere", () => {
    const edges = deriveCanvasEdges(
      nodes(
        {
          node_key: "summary",
          node_type: "order_summary",
          config: {
            cart_var_key: "cart",
            add_more_next_node_key: "",
            finish_next_node_key: "done",
          },
        },
        { node_key: "done", node_type: "end", config: {} },
      ),
    );
    expect(edges).toHaveLength(1);
    expect(edges[0].sourceHandle).toBe("finish");
  });
});

describe("deriveCanvasEdges — numeric_menu (per-option)", () => {
  it("emits one edge per option, labeled with its number and label", () => {
    const edges = deriveCanvasEdges(
      nodes(
        {
          node_key: "menu",
          node_type: "numeric_menu",
          config: {
            prompt_text: "Para qual setor?",
            options: [
              { label: "Financeiro", next_node_key: "fin" },
              { label: "Comercial", next_node_key: "com" },
            ],
          },
        },
        { node_key: "fin", node_type: "handoff", config: {} },
        { node_key: "com", node_type: "handoff", config: {} },
      ),
    );
    expect(edges).toHaveLength(2);
    expect(edges[0]).toMatchObject({
      source: "menu",
      target: "fin",
      sourceHandle: "option:0",
      label: "1: Financeiro",
    });
    expect(edges[1]).toMatchObject({
      source: "menu",
      target: "com",
      sourceHandle: "option:1",
      label: "2: Comercial",
    });
  });

  it("skips options whose target doesn't exist", () => {
    const edges = deriveCanvasEdges(
      nodes(
        {
          node_key: "m",
          node_type: "numeric_menu",
          config: {
            prompt_text: "x",
            options: [
              { label: "Good", next_node_key: "real" },
              { label: "Bad", next_node_key: "ghost" },
            ],
          },
        },
        { node_key: "real", node_type: "end", config: {} },
      ),
    );
    expect(edges).toHaveLength(1);
    expect(edges[0].sourceHandle).toBe("option:0");
  });
});

describe("deriveCanvasEdges — terminal nodes", () => {
  it("emits no outgoing edges from handoff / end", () => {
    const edges = deriveCanvasEdges(
      nodes(
        { node_key: "h", node_type: "handoff", config: { note: "x" } },
        { node_key: "e", node_type: "end", config: {} },
      ),
    );
    expect(edges).toEqual([]);
  });
});

describe("deriveCanvasEdges — id stability", () => {
  it("produces unique, deterministic ids per (source, slot, target)", () => {
    const edges = deriveCanvasEdges(
      nodes(
        {
          node_key: "m",
          node_type: "numeric_menu",
          config: {
            prompt_text: "x",
            options: [
              { label: "A", next_node_key: "x" },
              { label: "B", next_node_key: "x" },
            ],
          },
        },
        { node_key: "x", node_type: "end", config: {} },
      ),
    );
    const ids = edges.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("outgoingSlots", () => {
  it("returns a single 'next' slot for the auto-advancing types", () => {
    const each = (node: BuilderNode) =>
      outgoingSlots(node).map((s) => s.id);
    expect(
      each({ node_key: "x", node_type: "start", config: { next_node_key: "y" } }),
    ).toEqual(["next"]);
    expect(
      each({ node_key: "x", node_type: "send_message", config: {} }),
    ).toEqual(["next"]);
    expect(
      each({ node_key: "x", node_type: "send_media", config: {} }),
    ).toEqual(["next"]);
    expect(
      each({ node_key: "x", node_type: "collect_input", config: {} }),
    ).toEqual(["next"]);
    expect(each({ node_key: "x", node_type: "set_tag", config: {} })).toEqual([
      "next",
    ]);
    expect(
      each({ node_key: "x", node_type: "add_order_item", config: {} }),
    ).toEqual(["next"]);
  });

  it("returns true/false slots for condition", () => {
    const slots = outgoingSlots({
      node_key: "c",
      node_type: "condition",
      config: {},
    });
    expect(slots.map((s) => s.id)).toEqual(["true", "false"]);
    expect(slots.map((s) => s.label)).toEqual(["true", "false"]);
  });

  it("returns add_more/finish slots for order_summary", () => {
    const slots = outgoingSlots({
      node_key: "summary",
      node_type: "order_summary",
      config: {},
    });
    expect(slots).toEqual([
      { id: "add_more", label: "Add another" },
      { id: "finish", label: "Finish" },
    ]);
  });

  it("returns one slot per numeric_menu option, numbered and labelled", () => {
    const slots = outgoingSlots({
      node_key: "m",
      node_type: "numeric_menu",
      config: {
        prompt_text: "Pick",
        options: [
          { label: "Financeiro", next_node_key: "" },
          { label: "Comercial", next_node_key: "" },
        ],
      },
    });
    expect(slots).toEqual([
      { id: "option:0", label: "1: Financeiro" },
      { id: "option:1", label: "2: Comercial" },
    ]);
  });

  it("terminal nodes (handoff / end) have no outgoing slots", () => {
    expect(
      outgoingSlots({ node_key: "h", node_type: "handoff", config: {} }),
    ).toEqual([]);
    expect(
      outgoingSlots({ node_key: "e", node_type: "end", config: {} }),
    ).toEqual([]);
  });
});

describe("applyEdgeConnection", () => {
  it("patches next_node_key for single-outgoing nodes", () => {
    const node: BuilderNode = {
      node_key: "a",
      node_type: "send_message",
      config: { text: "hi", next_node_key: "" },
    };
    expect(applyEdgeConnection(node, "next", "b")).toEqual({
      next_node_key: "b",
    });
  });

  it("returns null when the source handle isn't recognised on the type", () => {
    const node: BuilderNode = {
      node_key: "a",
      node_type: "send_message",
      config: {},
    };
    expect(applyEdgeConnection(node, "true", "b")).toBeNull();
    expect(applyEdgeConnection(node, "button:x", "b")).toBeNull();
  });

  it("patches next_node_key for add_order_item", () => {
    const node: BuilderNode = {
      node_key: "aoi",
      node_type: "add_order_item",
      config: { cart_var_key: "cart", next_node_key: "" },
    };
    expect(applyEdgeConnection(node, "next", "summary")).toEqual({
      next_node_key: "summary",
    });
  });

  it("patches the right branch on order_summary", () => {
    const node: BuilderNode = {
      node_key: "summary",
      node_type: "order_summary",
      config: {
        cart_var_key: "cart",
        add_more_next_node_key: "",
        finish_next_node_key: "",
      },
    };
    expect(applyEdgeConnection(node, "add_more", "aoi")).toEqual({
      add_more_next_node_key: "aoi",
    });
    expect(applyEdgeConnection(node, "finish", "done")).toEqual({
      finish_next_node_key: "done",
    });
    expect(applyEdgeConnection(node, "true", "x")).toBeNull();
  });

  it("patches the right branch on a condition", () => {
    const node: BuilderNode = {
      node_key: "c",
      node_type: "condition",
      config: {
        subject: "var",
        subject_key: "x",
        operator: "equals",
        value: "y",
        true_next: "",
        false_next: "",
      },
    };
    expect(applyEdgeConnection(node, "true", "t")).toEqual({ true_next: "t" });
    expect(applyEdgeConnection(node, "false", "f")).toEqual({
      false_next: "f",
    });
  });

  it("patches only the matching option on numeric_menu", () => {
    const node: BuilderNode = {
      node_key: "m",
      node_type: "numeric_menu",
      config: {
        prompt_text: "Pick",
        options: [
          { label: "Financeiro", next_node_key: "" },
          { label: "Comercial", next_node_key: "" },
        ],
      },
    };
    const patch = applyEdgeConnection(node, "option:1", "com");
    expect(patch).toEqual({
      options: [
        { label: "Financeiro", next_node_key: "" },
        { label: "Comercial", next_node_key: "com" },
      ],
    });
  });

  it("returns null when the numeric_menu option index doesn't exist", () => {
    const node: BuilderNode = {
      node_key: "m",
      node_type: "numeric_menu",
      config: {
        prompt_text: "x",
        options: [{ label: "A", next_node_key: "" }],
      },
    };
    expect(applyEdgeConnection(node, "option:5", "z")).toBeNull();
  });

  it("returns null for terminal nodes (no outgoing)", () => {
    expect(
      applyEdgeConnection(
        { node_key: "h", node_type: "handoff", config: {} },
        "next",
        "x",
      ),
    ).toBeNull();
    expect(
      applyEdgeConnection(
        { node_key: "e", node_type: "end", config: {} },
        "next",
        "x",
      ),
    ).toBeNull();
  });
});

describe("unlinkNodeReferences", () => {
  it("clears next_node_key when it points at the deleted node", () => {
    const before: BuilderNode[] = [
      {
        node_key: "a",
        node_type: "send_message",
        config: { text: "hi", next_node_key: "victim" },
      },
      { node_key: "victim", node_type: "end", config: {} },
    ];
    const after = unlinkNodeReferences(before, "victim");
    expect(
      (after[0].config as { next_node_key: string }).next_node_key,
    ).toBe("");
  });

  it("clears both true_next and false_next when condition points at the deleted node", () => {
    const before: BuilderNode[] = [
      {
        node_key: "c",
        node_type: "condition",
        config: {
          true_next: "victim",
          false_next: "victim",
        },
      },
    ];
    const after = unlinkNodeReferences(before, "victim");
    const cfg = after[0].config as {
      true_next: string;
      false_next: string;
    };
    expect(cfg.true_next).toBe("");
    expect(cfg.false_next).toBe("");
  });

  it("clears only the numeric_menu options that point at the deleted node", () => {
    const before: BuilderNode[] = [
      {
        node_key: "m",
        node_type: "numeric_menu",
        config: {
          prompt_text: "Pick",
          options: [
            { label: "Financeiro", next_node_key: "victim" },
            { label: "Comercial", next_node_key: "safe" },
          ],
        },
      },
    ];
    const after = unlinkNodeReferences(before, "victim");
    const options = (after[0].config as {
      options: Array<{ label: string; next_node_key: string }>;
    }).options;
    expect(options[0].next_node_key).toBe("");
    expect(options[1].next_node_key).toBe("safe");
  });

  it("clears both add_more_next_node_key and finish_next_node_key when order_summary points at the deleted node", () => {
    const before: BuilderNode[] = [
      {
        node_key: "summary",
        node_type: "order_summary",
        config: {
          cart_var_key: "cart",
          add_more_next_node_key: "victim",
          finish_next_node_key: "victim",
        },
      },
    ];
    const after = unlinkNodeReferences(before, "victim");
    const cfg = after[0].config as {
      add_more_next_node_key: string;
      finish_next_node_key: string;
    };
    expect(cfg.add_more_next_node_key).toBe("");
    expect(cfg.finish_next_node_key).toBe("");
  });

  it("returns the input nodes by identity when none reference the deleted key (no-op path)", () => {
    const nodes: BuilderNode[] = [
      {
        node_key: "a",
        node_type: "send_message",
        config: { text: "hi", next_node_key: "b" },
      },
      { node_key: "b", node_type: "end", config: {} },
    ];
    const after = unlinkNodeReferences(nodes, "ghost");
    // Same array length, each entry === input (no clone).
    expect(after).toHaveLength(2);
    expect(after[0]).toBe(nodes[0]);
    expect(after[1]).toBe(nodes[1]);
  });
});
