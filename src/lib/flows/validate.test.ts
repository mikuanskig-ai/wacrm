import { describe, it, expect } from "vitest";
import { validateFlowForActivation, reachableFromEntry } from "./validate";

const validFlow = {
  name: "Welcome",
  trigger_type: "keyword" as const,
  trigger_config: { keywords: ["support"] },
  entry_node_id: "start",
};

const validNodes = [
  { node_key: "start", node_type: "start", config: { next_node_key: "menu" } },
  {
    node_key: "menu",
    node_type: "numeric_menu",
    config: {
      prompt_text: "How can we help?",
      options: [
        { label: "A", next_node_key: "ho" },
        { label: "B", next_node_key: "ho" },
      ],
    },
  },
  { node_key: "ho", node_type: "handoff", config: {} },
];

describe("validateFlowForActivation — happy path", () => {
  it("produces no issues on a well-formed flow", () => {
    expect(validateFlowForActivation(validFlow, validNodes)).toEqual([]);
  });
});

describe("validateFlowForActivation — flow-level", () => {
  it("flags empty name", () => {
    expect(
      validateFlowForActivation({ ...validFlow, name: "" }, validNodes),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: "flow", field: "name" }),
      ]),
    );
  });

  it("flags whitespace-only name", () => {
    const issues = validateFlowForActivation(
      { ...validFlow, name: "   " },
      validNodes,
    );
    expect(issues.some((i) => i.field === "name")).toBe(true);
  });

  it("flags missing entry_node_id", () => {
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: null },
      validNodes,
    );
    expect(issues.some((i) => i.field === "entry_node_id")).toBe(true);
  });

  it("flags entry_node_id that doesn't exist in nodes", () => {
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "ghost" },
      validNodes,
    );
    expect(
      issues.some(
        (i) =>
          i.field === "entry_node_id" &&
          i.message.includes('"ghost"'),
      ),
    ).toBe(true);
  });

  it("flags empty node list", () => {
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: null },
      [],
    );
    expect(
      issues.some((i) => i.message.includes("at least one node")),
    ).toBe(true);
  });

  it("flags duplicate node_key", () => {
    const dupes = [
      { node_key: "a", node_type: "start", config: { next_node_key: "b" } },
      { node_key: "a", node_type: "end", config: {} },
      { node_key: "b", node_type: "handoff", config: {} },
    ];
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "a" },
      dupes,
    );
    expect(
      issues.some(
        (i) =>
          i.message.includes("Duplicate node_key") &&
          i.node_key === "a",
      ),
    ).toBe(true);
  });
});

describe("validateFlowForActivation — trigger", () => {
  it("flags keyword trigger with no keywords", () => {
    const issues = validateFlowForActivation(
      {
        ...validFlow,
        trigger_config: { keywords: [] },
      },
      validNodes,
    );
    expect(
      issues.some(
        (i) =>
          i.scope === "trigger" &&
          i.message.includes("at least one keyword"),
      ),
    ).toBe(true);
  });

  it("flags keyword trigger missing keywords field entirely", () => {
    const issues = validateFlowForActivation(
      { ...validFlow, trigger_config: {} },
      validNodes,
    );
    expect(issues.some((i) => i.scope === "trigger")).toBe(true);
  });

  it("warns when keywords contain blanks", () => {
    const issues = validateFlowForActivation(
      {
        ...validFlow,
        trigger_config: { keywords: ["support", "", " "] },
      },
      validNodes,
    );
    expect(
      issues.some(
        (i) =>
          i.scope === "trigger" &&
          i.severity === "warning" &&
          i.message.includes("blank"),
      ),
    ).toBe(true);
  });

  it("first_inbound_message trigger needs no config", () => {
    const issues = validateFlowForActivation(
      {
        ...validFlow,
        trigger_type: "first_inbound_message",
        trigger_config: {},
      },
      validNodes,
    );
    expect(issues.filter((i) => i.scope === "trigger")).toEqual([]);
  });
});

describe("validateFlowForActivation — nodes", () => {
  it("warns about unreachable nodes", () => {
    const nodes = [
      { node_key: "s", node_type: "start", config: { next_node_key: "h" } },
      { node_key: "h", node_type: "handoff", config: {} },
      // Orphaned — nothing points at it.
      { node_key: "orphan", node_type: "end", config: {} },
    ];
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "s" },
      nodes,
    );
    expect(
      issues.some(
        (i) =>
          i.node_key === "orphan" &&
          i.severity === "warning" &&
          i.message.includes("unreachable"),
      ),
    ).toBe(true);
  });

  it("doesn't crash on unknown node_type — flags it", () => {
    const nodes = [
      { node_key: "s", node_type: "wibble", config: {} },
    ];
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "s" },
      nodes,
    );
    expect(
      issues.some((i) => i.message.includes("Unknown node type")),
    ).toBe(true);
  });
});

describe("validateFlowForActivation — send_media", () => {
  const baseFlow = { ...validFlow, entry_node_id: "s" };
  const nodesWith = (mediaConfig: Record<string, unknown>) => [
    { node_key: "s", node_type: "start", config: { next_node_key: "m" } },
    { node_key: "m", node_type: "send_media", config: mediaConfig },
    { node_key: "h", node_type: "handoff", config: {} },
  ];

  it("passes on a fully-populated send_media node", () => {
    const issues = validateFlowForActivation(
      baseFlow,
      nodesWith({
        media_type: "document",
        media_url: "https://cdn.example/invoice.pdf",
        caption: "Your invoice",
        filename: "invoice.pdf",
        next_node_key: "h",
      }),
    );
    expect(issues).toEqual([]);
  });

  it("flags missing media_url", () => {
    const issues = validateFlowForActivation(
      baseFlow,
      nodesWith({
        media_type: "image",
        media_url: "",
        next_node_key: "h",
      }),
    );
    expect(
      issues.some((i) => i.node_key === "m" && i.field === "media_url"),
    ).toBe(true);
  });

  it("flags missing media_type", () => {
    const issues = validateFlowForActivation(
      baseFlow,
      nodesWith({
        media_url: "https://cdn.example/x.png",
        next_node_key: "h",
      }),
    );
    expect(
      issues.some((i) => i.node_key === "m" && i.field === "media_type"),
    ).toBe(true);
  });

  it("flags next_node_key pointing at a non-existent node", () => {
    const issues = validateFlowForActivation(
      baseFlow,
      nodesWith({
        media_type: "image",
        media_url: "https://cdn.example/x.png",
        next_node_key: "ghost",
      }),
    );
    expect(
      issues.some(
        (i) =>
          i.node_key === "m" &&
          i.field === "next_node_key" &&
          i.message.includes("ghost"),
      ),
    ).toBe(true);
  });

  it("flags caption exceeding 1024 chars", () => {
    const issues = validateFlowForActivation(
      baseFlow,
      nodesWith({
        media_type: "image",
        media_url: "https://cdn.example/x.png",
        caption: "x".repeat(1025),
        next_node_key: "h",
      }),
    );
    expect(
      issues.some((i) => i.node_key === "m" && i.field === "caption"),
    ).toBe(true);
  });

  it("contributes its next_node_key to reachability", () => {
    const set = reachableFromEntry(
      "s",
      nodesWith({
        media_type: "image",
        media_url: "https://cdn.example/x.png",
        next_node_key: "h",
      }),
    );
    expect(set).toEqual(new Set(["s", "m", "h"]));
  });
});

describe("validateFlowForActivation — add_order_item / order_summary", () => {
  const baseFlow = { ...validFlow, entry_node_id: "s" };
  const nodesWith = (
    aoiConfig: Record<string, unknown>,
    summaryConfig: Record<string, unknown>,
  ) => [
    { node_key: "s", node_type: "start", config: { next_node_key: "aoi" } },
    { node_key: "aoi", node_type: "add_order_item", config: aoiConfig },
    { node_key: "summary", node_type: "order_summary", config: summaryConfig },
    { node_key: "h", node_type: "handoff", config: {} },
  ];

  it("passes on a fully-populated pair", () => {
    const issues = validateFlowForActivation(
      baseFlow,
      nodesWith(
        {
          prompt_text: "Choose an item:",
          button_label: "View menu",
          cart_var_key: "cart",
          next_node_key: "summary",
        },
        {
          cart_var_key: "cart",
          add_more_next_node_key: "aoi",
          finish_next_node_key: "h",
        },
      ),
    );
    expect(issues).toEqual([]);
  });

  it("flags add_order_item missing prompt_text", () => {
    const issues = validateFlowForActivation(
      baseFlow,
      nodesWith(
        { button_label: "View menu", cart_var_key: "cart", next_node_key: "summary" },
        { cart_var_key: "cart", add_more_next_node_key: "aoi", finish_next_node_key: "h" },
      ),
    );
    expect(
      issues.some((i) => i.node_key === "aoi" && i.field === "prompt_text"),
    ).toBe(true);
  });

  it("flags add_order_item missing button_label", () => {
    const issues = validateFlowForActivation(
      baseFlow,
      nodesWith(
        { prompt_text: "Choose:", cart_var_key: "cart", next_node_key: "summary" },
        { cart_var_key: "cart", add_more_next_node_key: "aoi", finish_next_node_key: "h" },
      ),
    );
    expect(
      issues.some((i) => i.node_key === "aoi" && i.field === "button_label"),
    ).toBe(true);
  });

  it("flags add_order_item missing cart_var_key", () => {
    const issues = validateFlowForActivation(
      baseFlow,
      nodesWith(
        { prompt_text: "Choose:", button_label: "View menu", next_node_key: "summary" },
        { cart_var_key: "cart", add_more_next_node_key: "aoi", finish_next_node_key: "h" },
      ),
    );
    expect(
      issues.some((i) => i.node_key === "aoi" && i.field === "cart_var_key"),
    ).toBe(true);
  });

  it("flags cart_var_key with invalid characters", () => {
    const issues = validateFlowForActivation(
      baseFlow,
      nodesWith(
        {
          prompt_text: "Choose:",
          button_label: "View menu",
          cart_var_key: "my cart!",
          next_node_key: "summary",
        },
        { cart_var_key: "cart", add_more_next_node_key: "aoi", finish_next_node_key: "h" },
      ),
    );
    expect(
      issues.some(
        (i) =>
          i.node_key === "aoi" &&
          i.field === "cart_var_key" &&
          i.message.includes("alphanumeric"),
      ),
    ).toBe(true);
  });

  it("flags add_order_item next_node_key pointing at a non-existent node", () => {
    const issues = validateFlowForActivation(
      baseFlow,
      nodesWith(
        {
          prompt_text: "Choose:",
          button_label: "View menu",
          cart_var_key: "cart",
          next_node_key: "ghost",
        },
        { cart_var_key: "cart", add_more_next_node_key: "aoi", finish_next_node_key: "h" },
      ),
    );
    expect(
      issues.some(
        (i) =>
          i.node_key === "aoi" &&
          i.field === "next_node_key" &&
          i.message.includes("ghost"),
      ),
    ).toBe(true);
  });

  it("flags order_summary missing cart_var_key", () => {
    const issues = validateFlowForActivation(
      baseFlow,
      nodesWith(
        {
          prompt_text: "Choose:",
          button_label: "View menu",
          cart_var_key: "cart",
          next_node_key: "summary",
        },
        { add_more_next_node_key: "aoi", finish_next_node_key: "h" },
      ),
    );
    expect(
      issues.some((i) => i.node_key === "summary" && i.field === "cart_var_key"),
    ).toBe(true);
  });

  it("flags order_summary missing add_more_next_node_key and finish_next_node_key", () => {
    const issues = validateFlowForActivation(
      baseFlow,
      nodesWith(
        {
          prompt_text: "Choose:",
          button_label: "View menu",
          cart_var_key: "cart",
          next_node_key: "summary",
        },
        { cart_var_key: "cart" },
      ),
    );
    expect(
      issues.some(
        (i) => i.node_key === "summary" && i.field === "add_more_next_node_key",
      ),
    ).toBe(true);
    expect(
      issues.some(
        (i) => i.node_key === "summary" && i.field === "finish_next_node_key",
      ),
    ).toBe(true);
  });

  it("flags order_summary branches pointing at non-existent nodes", () => {
    const issues = validateFlowForActivation(
      baseFlow,
      nodesWith(
        {
          prompt_text: "Choose:",
          button_label: "View menu",
          cart_var_key: "cart",
          next_node_key: "summary",
        },
        {
          cart_var_key: "cart",
          add_more_next_node_key: "ghost1",
          finish_next_node_key: "ghost2",
        },
      ),
    );
    expect(
      issues.some(
        (i) =>
          i.node_key === "summary" &&
          i.field === "add_more_next_node_key" &&
          i.message.includes("ghost1"),
      ),
    ).toBe(true);
    expect(
      issues.some(
        (i) =>
          i.node_key === "summary" &&
          i.field === "finish_next_node_key" &&
          i.message.includes("ghost2"),
      ),
    ).toBe(true);
  });

  it("contributes add_order_item's next_node_key to reachability", () => {
    const set = reachableFromEntry(
      "s",
      nodesWith(
        {
          prompt_text: "Choose:",
          button_label: "View menu",
          cart_var_key: "cart",
          next_node_key: "summary",
        },
        { cart_var_key: "cart", add_more_next_node_key: "aoi", finish_next_node_key: "h" },
      ),
    );
    expect(set).toEqual(new Set(["s", "aoi", "summary", "h"]));
  });
});

describe("validateFlowForActivation — numeric_menu", () => {
  it("produces no issues on a well-formed numeric_menu", () => {
    const nodes = [
      { node_key: "s", node_type: "start", config: { next_node_key: "m" } },
      {
        node_key: "m",
        node_type: "numeric_menu",
        config: {
          prompt_text: "Para qual setor?",
          options: [
            { label: "Financeiro", next_node_key: "h" },
            { label: "Comercial", next_node_key: "h" },
          ],
        },
      },
      { node_key: "h", node_type: "handoff", config: {} },
    ];
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "s" },
      nodes,
    );
    expect(issues).toEqual([]);
  });

  it("flags a missing prompt_text", () => {
    const nodes = [
      { node_key: "s", node_type: "start", config: { next_node_key: "m" } },
      {
        node_key: "m",
        node_type: "numeric_menu",
        config: { options: [{ label: "A", next_node_key: "h" }] },
      },
      { node_key: "h", node_type: "handoff", config: {} },
    ];
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "s" },
      nodes,
    );
    expect(
      issues.some((i) => i.node_key === "m" && i.field === "prompt_text"),
    ).toBe(true);
  });

  it("flags zero options", () => {
    const nodes = [
      { node_key: "s", node_type: "start", config: { next_node_key: "m" } },
      {
        node_key: "m",
        node_type: "numeric_menu",
        config: { prompt_text: "Pick", options: [] },
      },
      { node_key: "h", node_type: "handoff", config: {} },
    ];
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "s" },
      nodes,
    );
    expect(
      issues.some(
        (i) =>
          i.node_key === "m" &&
          i.field === "options" &&
          i.message.includes("at least one"),
      ),
    ).toBe(true);
  });

  it("flags an option missing a label", () => {
    const nodes = [
      { node_key: "s", node_type: "start", config: { next_node_key: "m" } },
      {
        node_key: "m",
        node_type: "numeric_menu",
        config: {
          prompt_text: "Pick",
          options: [{ label: "", next_node_key: "h" }],
        },
      },
      { node_key: "h", node_type: "handoff", config: {} },
    ];
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "s" },
      nodes,
    );
    expect(
      issues.some((i) => i.node_key === "m" && i.field === "options.0.label"),
    ).toBe(true);
  });

  it("flags an option pointing to a non-existent node", () => {
    const nodes = [
      { node_key: "s", node_type: "start", config: { next_node_key: "m" } },
      {
        node_key: "m",
        node_type: "numeric_menu",
        config: {
          prompt_text: "Pick",
          options: [{ label: "A", next_node_key: "nowhere" }],
        },
      },
    ];
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "s" },
      nodes,
    );
    expect(
      issues.some(
        (i) =>
          i.node_key === "m" &&
          i.field === "options.0.next_node_key" &&
          i.message.includes("nowhere"),
      ),
    ).toBe(true);
  });

  it("warns on more than 9 options", () => {
    const options = Array.from({ length: 10 }, (_, i) => ({
      label: `Option ${i + 1}`,
      next_node_key: "h",
    }));
    const nodes = [
      { node_key: "s", node_type: "start", config: { next_node_key: "m" } },
      {
        node_key: "m",
        node_type: "numeric_menu",
        config: { prompt_text: "Pick", options },
      },
      { node_key: "h", node_type: "handoff", config: {} },
    ];
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "s" },
      nodes,
    );
    const warning = issues.find(
      (i) => i.node_key === "m" && i.field === "options" && i.severity === "warning",
    );
    expect(warning).toBeTruthy();
  });
});

describe("reachableFromEntry", () => {
  it("walks the graph from the entry", () => {
    const set = reachableFromEntry("start", validNodes);
    expect(set.has("start")).toBe(true);
    expect(set.has("menu")).toBe(true);
    expect(set.has("ho")).toBe(true);
  });

  it("returns the entry alone when no edges lead out", () => {
    const set = reachableFromEntry("only", [
      { node_key: "only", node_type: "handoff", config: {} },
    ]);
    expect(set).toEqual(new Set(["only"]));
  });

  it("survives a cycle (visited guard)", () => {
    const nodes = [
      { node_key: "a", node_type: "start", config: { next_node_key: "b" } },
      {
        node_key: "b",
        node_type: "numeric_menu",
        config: {
          prompt_text: "Loop",
          options: [{ label: "Back", next_node_key: "a" }],
        },
      },
    ];
    const set = reachableFromEntry("a", nodes);
    expect(set).toEqual(new Set(["a", "b"]));
  });
});
