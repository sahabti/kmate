import js from "@eslint/js";
import { plugin as shadcn } from "@shadcn/lint";
import stylistic from "@stylistic/eslint-plugin";
import vitest from "@vitest/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";
import unicorn from "eslint-plugin-unicorn";
import globals from "globals";
import tseslint from "typescript-eslint";

/*
 * Rules follow the pxkit conventions plus the design-system rules adopted from
 * Hirael. See AGENTS.md for the reasoning behind each one.
 */

// Entrance animations aren't a restyle.
const RESTYLE_ALLOW = ["layout", "motion"];

// Slots whose spacing the app may set, as in shadcn's own examples.
const LAYOUT_SLOTS = [
  { pattern: "^Field(Group|Set|Content)?$", allow: ["layout", "spacing"] },
  { pattern: "^PopoverContent$", allow: ["layout", "spacing"] },
  { pattern: "^(Dialog|Sheet)Content$", allow: ["layout", "spacing"] },
  { pattern: "^Sheet(Header|Footer)$", allow: ["layout", "spacing"] },
  { pattern: "^Table(Head|Cell)$", allow: ["layout", "spacing"] },
  // Breathing room between sidebar links, a KMate design decision.
  { pattern: "^SidebarMenu$", allow: ["layout", "spacing"] },
];

// Vendored from the Hirael registry: design-system source that styles its own
// parts, exempt as Hirael exempts its components. Refresh with the shadcn CLI.
const HIRAEL_COMPONENTS = ["callout", "code-block", "copy-button", "kbd", "password-input", "relative-time", "sparkline", "spinner", "stat-card", "timeline"].map(
  (name) => `src/components/${name}.tsx`,
);

export default tseslint.config(
  { ignores: ["dist/**", "src/gen/**", "public/**", "scripts/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks, shadcn, unicorn, "@stylistic": stylistic },
    settings: { shadcn: { ui: ["@/components/ui"] } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // className on a shadcn component carries layout only; restyle with a variant or a token.
      "shadcn/no-restyle": ["error", { allow: RESTYLE_ALLOW, contracts: LAYOUT_SLOTS }],
      // pxkit: kebab-case files, named exports, arrow components, no enums, no any.
      "unicorn/filename-case": ["error", { case: "kebabCase" }],
      "no-restricted-exports": ["error", { restrictDefaultExports: { direct: true, named: true, defaultFrom: true, namedFrom: true, namespaceFrom: true } }],
      "func-style": ["warn", "expression"],
      "no-restricted-syntax": [
        "error",
        { selector: "TSEnumDeclaration", message: "Use a string-literal union or `as const` instead of enum." },
        // Type scale (AGENTS.md): text-2xl / text-base / text-sm / text-xs, nothing smaller than 12px.
        { selector: "Literal[value=/text-[[][0-9]/]", message: "Use the type scale (text-xs … text-2xl), not an arbitrary font size." },
        { selector: "TemplateElement[value.raw=/text-[[][0-9]/]", message: "Use the type scale (text-xs … text-2xl), not an arbitrary font size." },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/consistent-type-definitions": ["error", "interface"],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true }],
      "@stylistic/padding-line-between-statements": ["error", { blankLine: "always", prev: "*", next: "return" }],
      // React Compiler rules land as warnings while existing effects are migrated.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
    },
  },
  {
    files: HIRAEL_COMPONENTS,
    rules: { "shadcn/no-restyle": "off", "no-restricted-syntax": "off" },
  },
  {
    // ui/ mirrors shadcn verbatim; keep it diffable against upstream.
    files: ["src/components/ui/**"],
    rules: {
      "shadcn/no-restyle": "off",
      "no-restricted-syntax": "off",
      "func-style": "off",
      "@stylistic/padding-line-between-statements": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "react-hooks/purity": "off",
    },
  },
  {
    files: ["src/**/*.test.ts"],
    ...vitest.configs.recommended,
    rules: {
      ...vitest.configs.recommended.rules,
      "vitest/valid-title": ["error", { mustMatch: { it: ["^should ", 'Test titles start with "should "'] } }],
    },
  },
);
