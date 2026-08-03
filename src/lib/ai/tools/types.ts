// ============================================================
// Provider-agnostic tool-calling types. `ToolDefinition.parameters` is
// intentionally a tiny JSON-Schema subset (just what the two provider
// adapters need to translate into their own `tools` payload shape) —
// not a general-purpose schema library.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export interface JsonSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'array' | 'boolean'
  description?: string
  items?: JsonSchemaProperty
  enum?: string[]
}

export interface JsonSchema {
  type: 'object'
  properties: Record<string, JsonSchemaProperty>
  required?: string[]
  additionalProperties?: false
}

/**
 * What a tool hands back after running. `content` is the only thing
 * the model ever sees (fed back as the tool_result for the next
 * round-trip). `data`, when present, is a structured payload for the
 * *loop itself* to act on (currently only `place_order`'s success
 * payload, used to short-circuit the loop — see generate.ts) — it is
 * never serialized into the model-facing transcript.
 */
export interface ToolExecutionResult {
  content: string
  data?: unknown
}

export interface ToolContext {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string | null
  /** Account's default currency, for formatting prices in tool output. */
  currency: string
  /** False in the draft/playground routes: nothing the agent hasn't
   *  sent yet should be able to mutate a cart or place a real order. */
  allowSideEffects: boolean
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: JsonSchema
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecutionResult>
}
