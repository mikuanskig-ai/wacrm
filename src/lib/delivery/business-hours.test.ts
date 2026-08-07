import { describe, expect, it } from "vitest";
import {
  isWithinBusinessHours,
  closedMessage,
  parseBusinessHoursWeek,
  type BusinessHoursWeek,
} from "./business-hours";

// 2026-07-28 is a Tuesday.
const TUESDAY_NOON_UTC = new Date("2026-07-28T12:00:00Z");

describe("isWithinBusinessHours", () => {
  const hours: BusinessHoursWeek = {
    tue: { open: "09:00", close: "22:00" },
    wed: null,
  };

  it("returns true inside the configured window", () => {
    expect(isWithinBusinessHours(hours, "UTC", TUESDAY_NOON_UTC)).toBe(true);
  });

  it("returns false before opening", () => {
    const early = new Date("2026-07-28T08:00:00Z");
    expect(isWithinBusinessHours(hours, "UTC", early)).toBe(false);
  });

  it("returns false at/after closing (close is exclusive)", () => {
    const atClose = new Date("2026-07-28T22:00:00Z");
    expect(isWithinBusinessHours(hours, "UTC", atClose)).toBe(false);
  });

  it("returns false on a day explicitly marked closed", () => {
    const wednesday = new Date("2026-07-29T12:00:00Z");
    expect(isWithinBusinessHours(hours, "UTC", wednesday)).toBe(false);
  });

  it("returns false on a day missing from the config entirely", () => {
    const thursday = new Date("2026-07-30T12:00:00Z");
    expect(isWithinBusinessHours(hours, "UTC", thursday)).toBe(false);
  });

  it("evaluates in the given timezone, not the server's", () => {
    // 2026-07-28T12:00:00Z is 09:00 in America/Sao_Paulo (UTC-3, no DST
    // since 2019) — exactly at opening, still Tuesday there too.
    expect(isWithinBusinessHours(hours, "America/Sao_Paulo", TUESDAY_NOON_UTC)).toBe(true);

    // Same instant is 21:00 in Asia/Tokyo (UTC+9, no DST) — still open (close 22:00).
    expect(isWithinBusinessHours(hours, "Asia/Tokyo", TUESDAY_NOON_UTC)).toBe(true);

    // Etc/GMT-10 is a fixed UTC+10 offset (no DST, no named-zone
    // ambiguity) — same instant is 22:00 there, exactly at close
    // (exclusive), so already past opening hours.
    expect(isWithinBusinessHours(hours, "Etc/GMT-10", TUESDAY_NOON_UTC)).toBe(false);
  });

  it("treats an empty config as always closed", () => {
    expect(isWithinBusinessHours({}, "UTC", TUESDAY_NOON_UTC)).toBe(false);
  });
});

describe("closedMessage", () => {
  it("lists only the open days, in week order", () => {
    const hours: BusinessHoursWeek = {
      fri: { open: "18:00", close: "23:00" },
      mon: { open: "09:00", close: "18:00" },
      wed: null,
    };
    const msg = closedMessage(hours);
    const monIdx = msg.indexOf("Segunda");
    const friIdx = msg.indexOf("Sexta");
    expect(monIdx).toBeGreaterThan(-1);
    expect(friIdx).toBeGreaterThan(monIdx);
    expect(msg).not.toContain("Quarta");
  });

  it("still returns a message with no schedule to show", () => {
    expect(closedMessage({})).toContain("fechados");
  });
});

describe("parseBusinessHoursWeek", () => {
  it("accepts a valid week with a mix of open/closed days", () => {
    const input = {
      mon: { open: "09:00", close: "18:00" },
      tue: null,
    };
    expect(parseBusinessHoursWeek(input)).toEqual(input);
  });

  it("accepts an empty object (all days closed)", () => {
    expect(parseBusinessHoursWeek({})).toEqual({});
  });

  it("rejects a non-object input", () => {
    expect(parseBusinessHoursWeek(null)).toBeNull();
    expect(parseBusinessHoursWeek("mon")).toBeNull();
    expect(parseBusinessHoursWeek(42)).toBeNull();
  });

  it("rejects an unknown day key", () => {
    expect(parseBusinessHoursWeek({ someday: { open: "09:00", close: "18:00" } })).toBeNull();
  });

  it("rejects a malformed HH:mm value", () => {
    expect(parseBusinessHoursWeek({ mon: { open: "9:00", close: "18:00" } })).toBeNull();
    expect(parseBusinessHoursWeek({ mon: { open: "09:00", close: "25:00" } })).toBeNull();
  });

  it("rejects close <= open (no overnight-crossing spans)", () => {
    expect(parseBusinessHoursWeek({ mon: { open: "18:00", close: "18:00" } })).toBeNull();
    expect(parseBusinessHoursWeek({ mon: { open: "18:00", close: "09:00" } })).toBeNull();
  });
});
