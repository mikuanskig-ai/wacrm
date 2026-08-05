import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored minified opus-recorder encoder worker (served statically).
    "public/opus/**",
    // print-agent is a separate standalone package (own tsconfig/build
    // pipeline) — its CommonJS build output and Node-script tools use
    // require() on purpose and shouldn't be linted against the app's
    // ESM/Next.js rules.
    "print-agent/**",
    // Local, gitignored staging area for handing changes to the dev for
    // manual deploy — plain file copies, never meant to be linted/built.
    "Deploy/**",
  ]),
]);

export default eslintConfig;
