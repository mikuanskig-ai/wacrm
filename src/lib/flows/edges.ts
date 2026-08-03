/**
 * Derive canvas edges from the flow's node list.
 *
 * Edges live INSIDE each node's `config` JSONB (each numeric_menu
 * option / condition branch carries its own `next_node_key`). The
 * canvas needs them as a separate `{ source, target, label,
 * sourceHandle }` list to render arrows, and the labels need to be
 * meaningful — a `numeric_menu` node with three options isn't useful
 * on the canvas if the three outgoing arrows are unlabeled.
 *
 * Why this lives in lib/flows (not next to flow-canvas.tsx): the
 * derivation is pure data manipulation with no React-Flow types in
 * it, which makes it (a) trivially unit-testable and (b) reusable by
 * the editable canvas (PR 2) without dragging in client-only deps.
 *
 * `sourceHandle` ids are stable strings the canvas wires up to its
 * per-node renderer's outgoing connection points. They match the
 * scheme PR 2's drag-to-connect handler will read:
 *   - `next`          for single-outgoing nodes
 *   - `option:<index>` for numeric_menu options
 *   - `true` / `false` for condition branches
 */

import type { BuilderNode } from "@/components/flows/shared";

export interface CanvasEdge {
  /** Stable per-edge id — required by React-Flow. */
  id: string;
  /** node_key of the source node. */
  source: string;
  /** node_key of the target node. */
  target: string;
  /** Identifies which outgoing slot on the source node this edge belongs to. */
  sourceHandle: string;
  /** Human-readable label rendered on the canvas (e.g. "Yes button"). */
  label?: string;
}

export function deriveCanvasEdges(nodes: BuilderNode[]): CanvasEdge[] {
  const knownKeys = new Set(nodes.map((n) => n.node_key));
  const edges: CanvasEdge[] = [];

  for (const node of nodes) {
    const cfg = node.config;
    switch (node.node_type) {
      case "start":
      case "send_message":
      case "send_media":
      case "collect_input":
      case "set_tag":
      case "add_order_item": {
        const next = (cfg as { next_node_key?: string }).next_node_key;
        if (next && knownKeys.has(next)) {
          edges.push({
            id: `${node.node_key}--next--${next}`,
            source: node.node_key,
            target: next,
            sourceHandle: "next",
          });
        }
        break;
      }

      case "order_summary": {
        const addMore = (cfg as { add_more_next_node_key?: string }).add_more_next_node_key;
        const finish = (cfg as { finish_next_node_key?: string }).finish_next_node_key;
        if (addMore && knownKeys.has(addMore)) {
          edges.push({
            id: `${node.node_key}--add_more--${addMore}`,
            source: node.node_key,
            target: addMore,
            sourceHandle: "add_more",
            label: "Add another",
          });
        }
        if (finish && knownKeys.has(finish)) {
          edges.push({
            id: `${node.node_key}--finish--${finish}`,
            source: node.node_key,
            target: finish,
            sourceHandle: "finish",
            label: "Finish",
          });
        }
        break;
      }

      case "condition": {
        const trueNext = (cfg as { true_next?: string }).true_next;
        const falseNext = (cfg as { false_next?: string }).false_next;
        if (trueNext && knownKeys.has(trueNext)) {
          edges.push({
            id: `${node.node_key}--true--${trueNext}`,
            source: node.node_key,
            target: trueNext,
            sourceHandle: "true",
            label: "true",
          });
        }
        if (falseNext && knownKeys.has(falseNext)) {
          edges.push({
            id: `${node.node_key}--false--${falseNext}`,
            source: node.node_key,
            target: falseNext,
            sourceHandle: "false",
            label: "false",
          });
        }
        break;
      }

      case "numeric_menu": {
        const options = Array.isArray((cfg as { options?: unknown }).options)
          ? ((cfg as { options: Array<Record<string, unknown>> }).options)
          : [];
        options.forEach((option, i) => {
          const next =
            typeof option.next_node_key === "string" ? option.next_node_key : null;
          const label = typeof option.label === "string" ? option.label : null;
          if (!next || !knownKeys.has(next)) return;
          edges.push({
            id: `${node.node_key}--option:${i}--${next}`,
            source: node.node_key,
            target: next,
            sourceHandle: `option:${i}`,
            label: label ? `${i + 1}: ${label}` : `${i + 1}`,
          });
        });
        break;
      }

      case "handoff":
      case "end":
        // Terminal nodes — no outgoing edges.
        break;
    }
  }

  return edges;
}

// ============================================================
// Inverse operations — used by the canvas's drag-to-connect and
// delete-with-cleanup handlers (PR 2b). Kept in lib/flows so the
// canvas component stays free of edge-bookkeeping logic.
// ============================================================

/**
 * Outgoing-slot list for a node — used by the canvas to render one
 * source-side Handle per slot, labelled with the slot's user-facing
 * name. Order follows the order the slots appear in the node's
 * config so visual layout matches the form layout.
 *
 * Terminal nodes (handoff / end) return an empty list — they have
 * no outgoing edges and no source handles.
 */
export interface OutgoingSlot {
  /** Stable id matching the `sourceHandle` scheme used in
   *  CanvasEdge. */
  id: string;
  /** Visible label rendered next to the handle. */
  label: string;
}

export function outgoingSlots(node: BuilderNode): OutgoingSlot[] {
  const cfg = node.config;
  switch (node.node_type) {
    case "start":
    case "send_message":
    case "send_media":
    case "collect_input":
    case "set_tag":
    case "add_order_item":
      return [{ id: "next", label: "Next" }];

    case "condition":
      return [
        { id: "true", label: "true" },
        { id: "false", label: "false" },
      ];

    case "order_summary":
      return [
        { id: "add_more", label: "Add another" },
        { id: "finish", label: "Finish" },
      ];

    case "numeric_menu": {
      const options = Array.isArray((cfg as { options?: unknown }).options)
        ? ((cfg as { options: Array<Record<string, unknown>> }).options)
        : [];
      return options.map((option, i) => {
        const label = typeof option.label === "string" ? option.label : null;
        return {
          id: `option:${i}`,
          label: label ? `${i + 1}: ${label}` : `${i + 1}`,
        };
      });
    }

    case "handoff":
    case "end":
      return [];
  }
}

/**
 * Compute the config patch to apply when the user drags an edge from
 * `sourceHandle` on a node to `targetKey`. Returns `null` when the
 * handle isn't recognised on the node type (defensive — React-Flow
 * would have to misroute for this to fire).
 *
 * For `numeric_menu`, only the option at the matching index is
 * patched; the rest of the array passes through unchanged.
 */
export function applyEdgeConnection(
  node: BuilderNode,
  sourceHandle: string,
  targetKey: string,
): Record<string, unknown> | null {
  switch (node.node_type) {
    case "start":
    case "send_message":
    case "send_media":
    case "collect_input":
    case "set_tag":
    case "add_order_item":
      if (sourceHandle === "next") return { next_node_key: targetKey };
      return null;

    case "condition":
      if (sourceHandle === "true") return { true_next: targetKey };
      if (sourceHandle === "false") return { false_next: targetKey };
      return null;

    case "order_summary":
      if (sourceHandle === "add_more") return { add_more_next_node_key: targetKey };
      if (sourceHandle === "finish") return { finish_next_node_key: targetKey };
      return null;

    case "numeric_menu": {
      if (!sourceHandle.startsWith("option:")) return null;
      const index = Number(sourceHandle.slice("option:".length));
      const options = Array.isArray(
        (node.config as { options?: unknown }).options,
      )
        ? (node.config as {
            options: Array<Record<string, unknown>>;
          }).options
        : [];
      if (!options[index]) return null;
      return {
        options: options.map((o, i) =>
          i === index ? { ...o, next_node_key: targetKey } : o,
        ),
      };
    }

    case "handoff":
    case "end":
      return null;
  }
}

/**
 * Walk every node and clear any `next_node_key` / `true_next` /
 * `false_next` / `button.next_node_key` / `row.next_node_key`
 * reference to `deletedKey`. Cleared refs become the empty string —
 * the same "no target picked" sentinel the builder forms use.
 *
 * Returns a new array; original nodes are left untouched. Nodes
 * without any matching reference pass through by identity to avoid
 * needless re-renders downstream.
 */
export function unlinkNodeReferences(
  nodes: BuilderNode[],
  deletedKey: string,
): BuilderNode[] {
  return nodes.map((n) => {
    const patched = patchedConfigWithoutKey(n, deletedKey);
    return patched ? { ...n, config: patched } : n;
  });
}

function patchedConfigWithoutKey(
  node: BuilderNode,
  deletedKey: string,
): Record<string, unknown> | null {
  const cfg = node.config;
  switch (node.node_type) {
    case "start":
    case "send_message":
    case "send_media":
    case "collect_input":
    case "set_tag":
    case "add_order_item": {
      const next = (cfg as { next_node_key?: string }).next_node_key;
      if (next !== deletedKey) return null;
      return { ...cfg, next_node_key: "" };
    }

    case "condition": {
      const c = cfg as { true_next?: string; false_next?: string };
      const trueMatch = c.true_next === deletedKey;
      const falseMatch = c.false_next === deletedKey;
      if (!trueMatch && !falseMatch) return null;
      return {
        ...cfg,
        ...(trueMatch ? { true_next: "" } : {}),
        ...(falseMatch ? { false_next: "" } : {}),
      };
    }

    case "order_summary": {
      const c = cfg as { add_more_next_node_key?: string; finish_next_node_key?: string };
      const addMoreMatch = c.add_more_next_node_key === deletedKey;
      const finishMatch = c.finish_next_node_key === deletedKey;
      if (!addMoreMatch && !finishMatch) return null;
      return {
        ...cfg,
        ...(addMoreMatch ? { add_more_next_node_key: "" } : {}),
        ...(finishMatch ? { finish_next_node_key: "" } : {}),
      };
    }

    case "numeric_menu": {
      const options = Array.isArray((cfg as { options?: unknown }).options)
        ? (cfg as {
            options: Array<Record<string, unknown>>;
          }).options
        : [];
      if (!options.some((o) => o.next_node_key === deletedKey)) return null;
      return {
        ...cfg,
        options: options.map((o) =>
          o.next_node_key === deletedKey ? { ...o, next_node_key: "" } : o,
        ),
      };
    }

    case "handoff":
    case "end":
      return null;
  }
}

