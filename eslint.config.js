import js from "@eslint/js";
import tseslint from "typescript-eslint";

const noConsoleVerbose = {
  selector:
    "CallExpression[callee.object.name='console'][callee.property.name=/^(log|info|debug|warn|trace)$/]",
  message:
    "Logging is forbidden: the server must never log. Only console.error for fatal startup errors is allowed.",
};

const noBrowserStorage = [
  {
    selector: "MemberExpression[object.name='document'][property.name='cookie']",
    message: "Cookies are forbidden. Nothing may be stored in the browser.",
  },
  {
    selector: "MemberExpression[property.name=/^(localStorage|sessionStorage|indexedDB)$/] ",
    message: "Browser storage is forbidden. Nothing may be stored in the browser.",
  },
  {
    selector: "Identifier[name=/^(localStorage|sessionStorage|indexedDB|cookieStore)$/]",
    message: "Browser storage is forbidden. Nothing may be stored in the browser.",
  },
];

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/*.d.ts",
      "e2e/test-results/**",
      "e2e/playwright-report/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "no-restricted-properties": [
        "error",
        {
          object: "console",
          property: "assert",
          message: "Use explicit error handling instead of console.assert.",
        },
      ],
    },
  },
  {
    files: ["apps/server/src/**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error", noConsoleVerbose],
    },
  },
  {
    files: ["apps/web/src/**/*.ts", "apps/web/src/**/*.tsx"],
    rules: {
      "no-restricted-syntax": ["error", ...noBrowserStorage],
    },
  },
);
