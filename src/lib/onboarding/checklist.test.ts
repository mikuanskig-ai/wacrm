import { describe, it, expect } from "vitest";
import { computeOnboardingSteps, isOnboardingComplete } from "./checklist";

describe("computeOnboardingSteps", () => {
  it("marks every step undone for a brand-new account", () => {
    const steps = computeOnboardingSteps({
      whatsappConnected: false,
      businessTypeDecidedAt: null,
      aiConfigured: false,
      aiTestedAt: null,
      teamSize: 1,
    });
    expect(steps.every((s) => !s.done)).toBe(true);
  });

  it("marks each step done independently from its own signal", () => {
    const steps = computeOnboardingSteps({
      whatsappConnected: true,
      businessTypeDecidedAt: "2026-01-01T00:00:00Z",
      aiConfigured: true,
      aiTestedAt: "2026-01-02T00:00:00Z",
      teamSize: 2,
    });
    expect(steps.find((s) => s.key === "whatsapp")?.done).toBe(true);
    expect(steps.find((s) => s.key === "businessType")?.done).toBe(true);
    expect(steps.find((s) => s.key === "aiAgent")?.done).toBe(true);
    expect(steps.find((s) => s.key === "aiTested")?.done).toBe(true);
    expect(steps.find((s) => s.key === "inviteTeam")?.done).toBe(true);
  });

  it("flags inviteTeam as optional", () => {
    const steps = computeOnboardingSteps({
      whatsappConnected: false,
      businessTypeDecidedAt: null,
      aiConfigured: false,
      aiTestedAt: null,
      teamSize: 1,
    });
    expect(steps.find((s) => s.key === "inviteTeam")?.optional).toBe(true);
  });
});

describe("isOnboardingComplete", () => {
  it("is false while any required step is undone, even if the optional one is done", () => {
    const steps = computeOnboardingSteps({
      whatsappConnected: true,
      businessTypeDecidedAt: "2026-01-01T00:00:00Z",
      aiConfigured: false,
      aiTestedAt: null,
      teamSize: 3,
    });
    expect(isOnboardingComplete(steps)).toBe(false);
  });

  it("is true once all required steps are done, regardless of the optional one", () => {
    const steps = computeOnboardingSteps({
      whatsappConnected: true,
      businessTypeDecidedAt: "2026-01-01T00:00:00Z",
      aiConfigured: true,
      aiTestedAt: "2026-01-02T00:00:00Z",
      teamSize: 1,
    });
    expect(isOnboardingComplete(steps)).toBe(true);
  });
});
