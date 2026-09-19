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
    // Python ML experiments (see ml/README.md) - the virtualenv's site-packages ships assorted
    // third-party JS (e.g. pandas' HTML templates) that isn't this project's code.
    "ml/**",
  ]),
]);

export default eslintConfig;
