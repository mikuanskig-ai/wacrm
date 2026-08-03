import { describe, it, expect } from "vitest";
import { estimateCostUsd, usdToBrl, isKnownModel } from "./pricing";

describe("estimateCostUsd", () => {
  it("computes input+output cost separately for a known model", () => {
    // claude-sonnet-5: $3/M input, $15/M output.
    const cost = estimateCostUsd("claude-sonnet-5", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(18, 5);
  });

  it("returns null for a model with no price entry", () => {
    expect(estimateCostUsd("some/unlisted-model", 1000, 1000)).toBeNull();
  });

  it("returns 0 for zero usage on a known model", () => {
    expect(estimateCostUsd("gpt-5.4-mini", 0, 0)).toBe(0);
  });
});

describe("usdToBrl", () => {
  it("scales by the fixed approximate rate", () => {
    expect(usdToBrl(1)).toBeGreaterThan(1);
    expect(usdToBrl(0)).toBe(0);
  });
});

describe("isKnownModel", () => {
  it("is true for a priced model and false for an unlisted one", () => {
    expect(isKnownModel("claude-opus-5")).toBe(true);
    expect(isKnownModel("totally-made-up-model")).toBe(false);
  });
});
