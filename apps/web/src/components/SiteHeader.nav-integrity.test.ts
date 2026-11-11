import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const appDir = path.resolve(__dirname, "../app");

/** Collect every route under app dir that produces a page (handles dynamic segments). */
function collectRoutes(dir: string, route = ""): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const routes: string[] = [];
  if (entries.some((e) => e.isFile() && /^page\.tsx?$/.test(e.name))) {
    routes.push(route === "" ? "/" : route);
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith("(") && e.name.endsWith(")")) {
      // route group: no path segment
      routes.push(...collectRoutes(path.join(dir, e.name), route));
    } else {
      routes.push(...collectRoutes(path.join(dir, e.name), `${route}/${e.name}`));
    }
  }
  return routes;
}

function normalizeHref(href: string): string {
  // strip query/hash
  const p = href.split(/[?#]/)[0];
  return p === "" ? "/" : p;
}

function routeExists(href: string, routes: string[]): boolean {
  const target = normalizeHref(href);
  return routes.some((route) => {
    const routeSegs = route.split("/").filter(Boolean);
    const targetSegs = target.split("/").filter(Boolean);
    if (routeSegs.length !== targetSegs.length) return false;
    return routeSegs.every(
      (seg, i) => seg.startsWith("[") || seg === targetSegs[i]
    );
  });
}

const headerSrc = fs.readFileSync(
  path.resolve(__dirname, "SiteHeader.tsx"),
  "utf8"
);
const consoleNavSrc = fs.readFileSync(
  path.resolve(__dirname, "ConsoleNav.tsx"),
  "utf8"
);

const hrefs = [
  ...Array.from(headerSrc.matchAll(/href="(\/[^"#]*)"/g)).map((m) => m[1]),
  ...Array.from(consoleNavSrc.matchAll(/href: "(\/[^"#]*)"/g)).map((m) => m[1]),
];

describe("SiteHeader nav integrity", () => {
  it("exposes at least one nav link", () => {
    expect(hrefs.length).toBeGreaterThan(0);
  });

  it.each(hrefs)("href %s resolves to an existing app route", (href) => {
    const routes = collectRoutes(appDir);
    expect(
      routeExists(href, routes),
      `SiteHeader href "${href}" has no matching app route`
    ).toBe(true);
  });
});
