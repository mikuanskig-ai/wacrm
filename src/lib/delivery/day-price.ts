// ============================================================
// Resolves a product's price for "today" — a per-weekday override
// (delivery_products.day_price_overrides) if one is set for the
// current day, otherwise the base `price` column.
//
// Pure and timezone-aware so every place that quotes a product's
// price (public ordering menu, the WhatsApp Flow engine, the AI
// ordering assistant) agrees on the answer — none of them may read
// the raw base `price` directly once a product has overrides, or a
// customer could be quoted a different price depending on which
// channel they order through.
//
// Same 3-letter lowercase DayKey convention as business-hours.ts
// (mon/tue/wed/thu/fri/sat/sun), reused rather than reinvented.
// ============================================================

import type { DayKey } from './business-hours';

export type DayPriceOverrides = Partial<Record<DayKey, number>>;

/** Matches delivery_business_hours.timezone's own default — see 047_delivery_business_hours.sql. */
const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

function currentDayKey(timezone: string, now: Date): DayKey {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' })
    .format(now)
    .toLowerCase()
    .slice(0, 3) as DayKey;
}

export function effectivePrice(
  basePrice: number,
  overrides: DayPriceOverrides | null | undefined,
  timezone: string = DEFAULT_TIMEZONE,
  now: Date = new Date(),
): number {
  if (!overrides) return basePrice;
  const override = overrides[currentDayKey(timezone, now)];
  return typeof override === 'number' && override >= 0 ? override : basePrice;
}
