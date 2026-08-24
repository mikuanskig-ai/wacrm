import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Dummy secrets — encryption.ts / webhook-signature.ts read these
    // at module load. Tests never hit a real Meta/Supabase service, so
    // any 32-byte hex / non-empty string will do; keep them lexically
    // identical to the CI build env so behaviour matches.
    env: {
      ENCRYPTION_KEY:
        "0000000000000000000000000000000000000000000000000000000000000000",
      META_APP_SECRET: "test-meta-app-secret",
      // date-utils tests construct dates from bare "YYYY-MM-DD" strings,
      // which parse as UTC midnight (spec) but get read back with
      // local-time getters (getDay() etc). Outside UTC that silently
      // shifts to the previous calendar day — confirmed failing on a
      // America/Sao_Paulo (UTC-3) machine. Pinning TZ makes the suite
      // deterministic regardless of the host's configured timezone.
      TZ: "UTC",
    },
    clearMocks: true,
  },
});
