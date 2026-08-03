/**
 * Pure decision logic shared by the server-side runner (engine.ts,
 * which re-exports these) and the client-side flow simulator
 * (simulate.ts). Zero side-effecting imports on purpose — engine.ts
 * pulls in supabaseAdmin, Meta senders, and delivery order creation,
 * none of which may ever end up in a browser bundle. Anything that
 * needs to run identically in both places belongs here, not in
 * engine.ts.
 */

import type { ConditionOperator, NumericMenuNodeConfig } from "./types";

/**
 * Leading digit(s) in a customer's free-text reply, tolerating
 * trailing punctuation/whitespace ("1.", "1)", "1 - Financeiro").
 */
export function extractLeadingNumber(text: string): number | null {
  const match = text.trim().match(/^(\d+)/);
  return match ? Number(match[1]) : null;
}

/**
 * Match a customer's free-text reply against a numeric_menu's options:
 * a leading digit sequence wins by position, falling back to a
 * case-insensitive exact match against the option's label. Returns
 * `null` when neither resolves.
 */
export function matchNumericMenuReply(
  text: string,
  options: NumericMenuNodeConfig["options"],
): string | null {
  const trimmed = text.trim();
  if (!trimmed || options.length === 0) return null;

  const digitMatch = trimmed.match(/^(\d+)/);
  if (digitMatch) {
    const index = Number(digitMatch[1]) - 1;
    const option = options[index];
    if (option) return option.next_node_key;
  }

  const lower = trimmed.toLowerCase();
  const byLabel = options.find((o) => o.label.trim().toLowerCase() === lower);
  return byLabel?.next_node_key ?? null;
}

export interface KeywordTriggerLike {
  keywords: string[];
  match_type?: "exact" | "contains";
  case_sensitive?: boolean;
}

/** Case-insensitive contains/exact match against a list of keywords. */
export function matchesKeywordTrigger(
  text: string,
  cfg: KeywordTriggerLike,
): boolean {
  if (!text || !cfg.keywords?.length) return false;
  const matchType = cfg.match_type ?? "contains";
  const haystack = cfg.case_sensitive ? text : text.toLowerCase();
  for (const raw of cfg.keywords) {
    if (!raw) continue;
    const needle = cfg.case_sensitive ? raw : raw.toLowerCase();
    if (matchType === "exact" ? haystack === needle : haystack.includes(needle)) {
      return true;
    }
  }
  return false;
}

/** Nodes that advance to a next_node_key without waiting for input. */
export function isAutoAdvancing(node_type: string): boolean {
  return (
    node_type === "start" ||
    node_type === "send_message" ||
    node_type === "send_media" ||
    node_type === "condition" ||
    node_type === "set_tag"
  );
}

/** Nodes that send a prompt and suspend awaiting a customer reply. */
export function isSuspending(node_type: string): boolean {
  return (
    node_type === "collect_input" ||
    node_type === "add_order_item" ||
    node_type === "order_summary" ||
    node_type === "numeric_menu"
  );
}

/** Nodes that end the run. */
export function isTerminal(node_type: string): boolean {
  return node_type === "handoff" || node_type === "end";
}

/**
 * Evaluate a `condition` node's predicate against the current run
 * state. The engine wraps this with a DB lookup for `tag` /
 * `contact_field` subjects; the simulator resolves those against its
 * in-memory simulated contact instead.
 */
export function evaluateConditionPredicate(args: {
  operator: ConditionOperator;
  subjectValue: string | undefined;
  configValue: string | undefined;
}): boolean {
  switch (args.operator) {
    case "present":
      return args.subjectValue !== undefined && args.subjectValue !== "";
    case "absent":
      return args.subjectValue === undefined || args.subjectValue === "";
    case "equals":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue === (args.configValue ?? "");
    case "contains":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue.includes(args.configValue ?? "");
  }
}

/**
 * Tiny `{{vars.foo}}` interpolation. Missing vars render as empty
 * string.
 */
export function interpolateVars(template: string, vars: Record<string, unknown>): string {
  if (!template) return "";
  return template.replace(/\{\{vars\.([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}
