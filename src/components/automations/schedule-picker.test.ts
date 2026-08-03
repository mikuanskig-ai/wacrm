import { describe, it, expect } from "vitest";
import { parseSchedule, buildCron } from "./schedule-picker";

describe("parseSchedule", () => {
  it("parses the audit's own example (a day-of-week range)", () => {
    expect(parseSchedule("0 9 * * 1-5")).toEqual({
      hour: 9,
      minute: 0,
      days: new Set([1, 2, 3, 4, 5]),
    });
  });

  it("parses a comma list of days", () => {
    expect(parseSchedule("30 14 * * 0,6")).toEqual({
      hour: 14,
      minute: 30,
      days: new Set([0, 6]),
    });
  });

  it("parses a wildcard day-of-week as every day", () => {
    expect(parseSchedule("0 8 * * *")).toEqual({
      hour: 8,
      minute: 0,
      days: new Set([0, 1, 2, 3, 4, 5, 6]),
    });
  });

  it("parses a bare HH:mm as every day (legacy format)", () => {
    expect(parseSchedule("09:00")).toEqual({
      hour: 9,
      minute: 0,
      days: new Set([0, 1, 2, 3, 4, 5, 6]),
    });
  });

  it("returns null for an out-of-range time", () => {
    expect(parseSchedule("99 9 * * *")).toBeNull();
    expect(parseSchedule("25:00")).toBeNull();
  });

  it("returns null for anything it can't confidently parse (falls back to advanced mode)", () => {
    expect(parseSchedule("*/15 * * * *")).toBeNull();
    expect(parseSchedule("not a schedule")).toBeNull();
    expect(parseSchedule("")).toBeNull();
  });
});

describe("buildCron", () => {
  it("collapses all 7 days to a wildcard", () => {
    expect(buildCron(9, 0, new Set([0, 1, 2, 3, 4, 5, 6]))).toBe("0 9 * * *");
  });

  it("emits a sorted comma list for a partial selection", () => {
    expect(buildCron(9, 0, new Set([5, 1, 3]))).toBe("0 9 * * 1,3,5");
  });

  it("round-trips through parseSchedule", () => {
    const cron = buildCron(14, 30, new Set([1, 2, 3, 4, 5]));
    expect(parseSchedule(cron)).toEqual({ hour: 14, minute: 30, days: new Set([1, 2, 3, 4, 5]) });
  });
});
