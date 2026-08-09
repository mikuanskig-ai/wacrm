import type { SupabaseClient } from '@supabase/supabase-js'

// Despite the folder, the pure time-window check here
// (isWithinBusinessHours) is schema-agnostic and reused beyond
// Delivery — see getAiBusinessHours below, which gates the AI
// auto-reply bot's own (separate, optional) schedule, independent of
// delivery_business_hours / the Delivery module.

export interface DayHours {
  open: string // "HH:mm", 24h
  close: string // "HH:mm", 24h — no overnight-crossing spans (close must be > open)
}

export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'

/** Missing key or null value = closed that day. */
export type BusinessHoursWeek = Partial<Record<DayKey, DayHours | null>>

export interface BusinessHoursConfig {
  enabled: boolean
  timezone: string
  hours: BusinessHoursWeek
}

const DAY_KEYS: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * Validates a caller-supplied `hours` shape — every present day is
 * either null (closed) or a { open, close } pair where close > open
 * (no overnight-crossing spans, see the Fase 5 plan). Shared by both
 * /api/delivery/business-hours and /api/ai/config so the two
 * schedules (order-taking vs the AI bot's own) can never silently
 * drift apart on what counts as a valid week.
 */
export function parseBusinessHoursWeek(input: unknown): BusinessHoursWeek | null {
  if (typeof input !== 'object' || input === null) return null
  const out: BusinessHoursWeek = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!DAY_KEYS.includes(key as DayKey)) return null
    if (value === null) {
      out[key as DayKey] = null
      continue
    }
    if (typeof value !== 'object') return null
    const { open, close } = value as Partial<DayHours>
    if (typeof open !== 'string' || typeof close !== 'string') return null
    if (!HHMM.test(open) || !HHMM.test(close)) return null
    if (close <= open) return null
    out[key as DayKey] = { open, close }
  }
  return out
}

/**
 * Loads the account's business-hours config. Returns null when no row
 * exists — callers treat that the same as `enabled: false` (always
 * open), matching payment_configs' "no row = feature off" convention.
 */
export async function getBusinessHours(
  db: SupabaseClient,
  accountId: string,
): Promise<BusinessHoursConfig | null> {
  const { data } = await db
    .from('delivery_business_hours')
    .select('enabled, timezone, hours')
    .eq('account_id', accountId)
    .maybeSingle()

  if (!data) return null
  return {
    enabled: data.enabled,
    timezone: data.timezone,
    hours: (data.hours ?? {}) as BusinessHoursWeek,
  }
}

/**
 * Loads the account's AI-assistant business-hours config (migration
 * 070) — independent of delivery_business_hours: an account may run
 * the AI bot with no Delivery module at all, or want a different
 * schedule for "does the bot reply" than "do we take orders" (the
 * same WhatsApp number is often used for things other than orders
 * outside those hours). Same "no row = disabled" convention.
 */
export async function getAiBusinessHours(
  db: SupabaseClient,
  accountId: string,
): Promise<BusinessHoursConfig | null> {
  const { data } = await db
    .from('ai_configs')
    .select('hours_enabled, hours_timezone, hours')
    .eq('account_id', accountId)
    .maybeSingle()

  if (!data) return null
  return {
    enabled: data.hours_enabled,
    timezone: data.hours_timezone,
    hours: (data.hours ?? {}) as BusinessHoursWeek,
  }
}

function currentDayAndMinutes(timezone: string, now: Date): { day: DayKey; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)

  const weekday = parts
    .find((p) => p.type === 'weekday')!
    .value.toLowerCase()
    .slice(0, 3) as DayKey
  // hour12: false can render midnight as "24" in some ICU builds —
  // normalize so 24:xx doesn't overflow a day's worth of minutes.
  const hour = Number(parts.find((p) => p.type === 'hour')!.value) % 24
  const minute = Number(parts.find((p) => p.type === 'minute')!.value)
  return { day: weekday, minutes: hour * 60 + minute }
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/**
 * Pure — true when `now` (default: current time) falls inside the
 * open/close window configured for that weekday, evaluated in
 * `timezone`. A missing/null day entry means closed all day. No
 * overnight-crossing spans (close < open) — deliberately out of scope
 * for this pass, see the Fase 5 plan.
 */
export function isWithinBusinessHours(
  hours: BusinessHoursWeek,
  timezone: string,
  now: Date = new Date(),
): boolean {
  const { day, minutes } = currentDayAndMinutes(timezone, now)
  const today = hours[day]
  if (!today) return false
  return minutes >= toMinutes(today.open) && minutes < toMinutes(today.close)
}

const DAY_LABELS_PT: Record<DayKey, string> = {
  mon: 'Segunda',
  tue: 'Terça',
  wed: 'Quarta',
  thu: 'Quinta',
  fri: 'Sexta',
  sat: 'Sábado',
  sun: 'Domingo',
}

const DAY_ORDER: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

/**
 * Deterministic template — same reasoning as create-order.ts's
 * formatPaymentLinkMessage: a message telling the customer we're
 * closed must never depend on an LLM paraphrase.
 */
export function closedMessage(hours: BusinessHoursWeek): string {
  const lines = DAY_ORDER.filter((day) => hours[day]).map(
    (day) => `${DAY_LABELS_PT[day]}: ${hours[day]!.open}–${hours[day]!.close}`,
  )
  const schedule = lines.length > 0 ? `\n\nNosso horário de funcionamento:\n${lines.join('\n')}` : ''
  return `No momento estamos fechados e não conseguimos receber pedidos.${schedule}`
}
