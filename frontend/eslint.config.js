import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/",
      "node_modules/",
      "playwright-report/",
      "test-results/",
      "e2e/",
      "src/**/*.js",
      "src/**/*.jsx"
    ]
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      globals: {
        ...globals.browser,
        ...globals.node
      },
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        }
      }
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error"
    }
  }
);
