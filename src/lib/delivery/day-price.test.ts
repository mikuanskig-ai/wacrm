import { describe, expect, it } from "vitest";
import { effectivePrice, type DayPriceOverrides } from "./day-price";

// 2026-07-28 is a Tuesday, 2026-08-01 is a Saturday (both at UTC noon).
const TUESDAY_NOON_UTC = new Date("2026-07-28T12:00:00Z");
const SATURDAY_NOON_UTC = new Date("2026-08-01T12:00:00Z");

describe("effectivePrice", () => {
  const overrides: DayPriceOverrides = { sat: 45, sun: 45 };

  it("returns the base price on a day with no override", () => {
    expect(effectivePrice(30, overrides, "UTC", TUESDAY_NOON_UTC)).toBe(30);
  });

  it("returns the override price on a matching day", () => {
    expect(effectivePrice(30, overrides, "UTC", SATURDAY_NOON_UTC)).toBe(45);
  });

  it("returns the base price when there are no overrides at all", () => {
    expect(effectivePrice(30, {}, "UTC", SATURDAY_NOON_UTC)).toBe(30);
    expect(effectivePrice(30, null, "UTC", SATURDAY_NOON_UTC)).toBe(30);
    expect(effectivePrice(30, undefined, "UTC", SATURDAY_NOON_UTC)).toBe(30);
  });

  it("ignores a negative override rather than quoting a negative price", () => {
    expect(effectivePrice(30, { sat: -5 }, "UTC", SATURDAY_NOON_UTC)).toBe(30);
  });

  it("evaluates in the given timezone, not the server's", () => {
    // 2026-08-01T12:00:00Z is 09:00 in America/Sao_Paulo (UTC-3) — still Saturday there.
    expect(effectivePrice(30, overrides, "America/Sao_Paulo", SATURDAY_NOON_UTC)).toBe(45);
    // Same instant is 21:00 in Asia/Tokyo (UTC+9) — still Saturday there too.
    expect(effectivePrice(30, overrides, "Asia/Tokyo", SATURDAY_NOON_UTC)).toBe(45);
  });

  it("defaults to America/Sao_Paulo when no timezone is given", () => {
    // Same instant as SATURDAY_NOON_UTC, but right at the UTC/BRT boundary
    // for Friday->Saturday: 2026-08-01T02:00:00Z is 2026-07-31 23:00 in
    // America/Sao_Paulo (still Friday there), so the base price applies.
    const fridayLateUtc = new Date("2026-08-01T02:00:00Z");
    expect(effectivePrice(30, overrides, undefined, fridayLateUtc)).toBe(30);
  });
});
