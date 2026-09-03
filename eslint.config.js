import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The Node-targeted packages.
    files: ["packages/{core,cli,api,mcp}/**/*.ts"],
    languageOptions: { globals: globals.node },
  },
  {
    // The browser-targeted UI package.
    files: ["packages/ui/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
  },
  {
    rules: {
      // Allow an intentionally-unused parameter/variable when prefixed with
      // `_` (e.g. Express's `(_req, res) => ...`).
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  // Must stay last: turns off stylistic rules Prettier already owns.
  prettier,
);
