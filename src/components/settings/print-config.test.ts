import { describe, it, expect, vi, afterEach } from "vitest";
import { isFresh } from "./print-config";

describe("isFresh", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is false when the agent has never polled", () => {
    expect(isFresh(null)).toBe(false);
  });

  it("is true just inside the freshness window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:09.000Z"));
    expect(isFresh("2026-01-01T00:00:00.000Z")).toBe(true);
  });

  it("is false once outside the freshness window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:11.000Z"));
    expect(isFresh("2026-01-01T00:00:00.000Z")).toBe(false);
  });
});
