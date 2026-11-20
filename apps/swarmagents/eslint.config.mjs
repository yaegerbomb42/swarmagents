import { FlatCompat } from "@eslint/eslintrc";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This app is on Next 15, whose eslint-config-next is still eslintrc-style
// (unlike the v16 configs the sibling apps spread directly). FlatCompat is
// the documented bridge for running it under ESLint 9's flat config; when
// the app moves to Next 16 this file can go back to the sibling pattern
// (`...nextCoreWebVitals` from "eslint-config-next/core-web-vitals").
const baseDirectory = path.dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory });

export default [
  ...compat.extends("next/core-web-vitals"),
  {
    // The two public pages still use a plain `<a href="/">` back-link.
    // They are owned by the in-flight quick-wins work (copy + mascot), so
    // this carve-out keeps lint green without editing those files: convert
    // the back-links to `next/link` there and delete this block.
    files: ["app/about/page.tsx", "app/status/page.tsx"],
    rules: {
      "@next/next/no-html-link-for-pages": "off",
    },
  },
  {
    ignores: [
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      // Generated / vendored trees: never linted, never shipped.
      "dist/**",
      "node_modules/**",
      "public/**",
      "vm-image/**",
      "vm-image-desktop/**",
      // Reference snapshots and standalone tools: not part of the app build.
      "vendor/**",
      "tools/**",
      "packages/mcp-swarm-board/**",
    ],
  },
];
