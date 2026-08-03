// ============================================================
// Interactive message payload — shared shape for HISTORICAL data only.
//
// WhatsApp interactive messages (reply buttons / lists) were a Meta
// Cloud API feature with no whatsmeow/WuzAPI equivalent, so nothing
// can compose or send one anymore (see the removed send_buttons/
// send_list node types and the removed interactive builder UI). This
// file only keeps the read-side shape so old `messages.interactive_payload`
// rows (sent back when Meta was still supported) keep rendering
// correctly in the inbox thread instead of crashing on unknown data.
// ============================================================

export interface InteractiveButton {
  id: string
  title: string
}

export interface InteractiveButtonsPayload {
  kind: 'buttons'
  body: string
  header?: string
  footer?: string
  buttons: InteractiveButton[]
}

export interface InteractiveListRow {
  id: string
  title: string
  description?: string
}

export interface InteractiveListSection {
  title?: string
  rows: InteractiveListRow[]
}

export interface InteractiveListPayload {
  kind: 'list'
  body: string
  header?: string
  footer?: string
  button_label: string
  sections: InteractiveListSection[]
}

export type InteractiveMessagePayload =
  | InteractiveButtonsPayload
  | InteractiveListPayload

/**
 * Short single-line summary used for `conversations.last_message_text`
 * and historical display — the body, trimmed, or a sensible fallback.
 */
export function interactivePayloadPreviewText(
  payload: InteractiveMessagePayload,
): string {
  const body = payload.body?.trim()
  if (body) return body
  return payload.kind === 'buttons' ? '[buttons]' : '[list]'
}
