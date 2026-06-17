// Minimal ESLint flat config for agent-browser-runtime.
// Catches common JS errors; does not enforce style (use Prettier for that).
import js from "@eslint/js";

export default [
  {
    ...js.configs.recommended,
    files: ["scripts/**/*.mjs", "src/**/*.ts"],
    ignores: [
      "node_modules/**",
      "dist/**",
      "**/*.test.mjs",
      "**/*.test.ts",
    ],
    rules: {
      // Relax rules that are impractical to enforce on the existing codebase
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "no-undef": "off",   // ES modules + Node globals handled by env
      "no-console": "off", // CLI tools legitimately use console
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        // Node.js globals
        process: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        fetch: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        console: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
      },
    },
  },
];
