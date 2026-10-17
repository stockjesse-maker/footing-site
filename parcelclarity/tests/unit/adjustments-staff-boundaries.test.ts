import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Source-level guards for the 3PL's adjustment screens: what they are allowed to import, which of them may be a server-action module, and that
 * every route of the area checks the permission itself. These read the files; they run no code.
 */
const root = path.resolve(__dirname, "../..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(path.join(root, dir))) {
    const rel = path.join(dir, name);
    if (statSync(path.join(root, rel)).isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

/** The files of the 3PL staff side owned by this part of the module (not the examples and risk screens, built separately). */
const staffFiles = (): string[] => [
  ...walk("src/components/adjustments/staff").filter((f) => !/staff\/(examples|risk)\//.test(f)),
  "src/lib/adjustments/staff-copy.ts",
  ...walk("src/app/(tenant)/app/adjustments").filter((f) => !/adjustments\/(examples|risk)\//.test(f)),
];

describe("the 3PL screens stay on the 3PL's side", () => {
  it("nothing a customer sees imports a staff module or the staff wording", () => {
    const customerFiles = [...walk("src/app/(brand)"), ...walk("src/components/adjustments/customer"), "src/lib/adjustments/customer-copy.ts"];
    expect(customerFiles.length).toBeGreaterThan(5);
    const offenders = customerFiles.filter((f) => /from "@\/components\/adjustments\/staff|from "@\/lib\/adjustments\/staff-copy|components\/adjustments\/staff\//.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it("the shared customer-facing components do not pull in the staff area either", () => {
    for (const f of ["src/components/modeling/views.tsx", "src/components/modeling/run-results.tsx", "src/components/pricing/calculation-result.tsx"]) {
      expect(read(f), f).not.toContain("components/adjustments/staff");
      expect(read(f), f).not.toContain("staff-copy");
    }
  });

  it("none of these files is a server-action module: they export components, models and constants (the actions live in one 'use server' file)", () => {
    for (const f of staffFiles()) expect(read(f), f).not.toMatch(/^["']use server["']/m);
  });

  it("no file mentions a carrier buy rate as something the product holds or reads", () => {
    for (const f of staffFiles()) expect(read(f), f).not.toMatch(/buy_rate|buyRate|carrier_cost|carrierCost|net_rate|netRate|negotiated_rate/);
  });

  it("only client components call an action, and only the adjustments actions", () => {
    for (const f of staffFiles().filter((x) => x.endsWith(".tsx"))) {
      const src = read(f);
      const imports = [...src.matchAll(/from "(@\/app\/actions\/[^"]+)"/g)].map((m) => m[1]);
      for (const i of imports) expect(i, f).toBe("@/app/actions/adjustments");
      if (imports.length) expect(src, f).toMatch(/^"use client";/);
    }
  });

  it("every route of the area checks the permission itself before it reads anything (a layout does not protect its pages)", () => {
    const pages = walk("src/app/(tenant)/app/adjustments").filter((f) => /\/page\.tsx$/.test(f) && !/adjustments\/(examples|risk)\//.test(f));
    expect(pages.map((p) => p.replace("src/app/(tenant)/app/adjustments", "")).sort()).toEqual(["/history/[importId]/page.tsx", "/history/baselines/page.tsx", "/history/page.tsx", "/history/statistics/page.tsx", "/page.tsx", "/policies/page.tsx"]);
    for (const f of pages) {
      const src = read(f);
      expect(src, f).toContain("adjustmentAccess()");
      expect(src.indexOf("if (!access.canView)"), f).toBeGreaterThan(-1);
      expect(src.indexOf("if (!access.canView)"), `${f}: the check comes before any load`).toBeLessThan(src.indexOf("createClient()") === -1 ? Infinity : src.indexOf("createClient()"));
    }
  });

  it("the layout shows the notice in place of the area for a member without the permission", () => {
    const src = read("src/app/(tenant)/app/adjustments/layout.tsx");
    expect(src).toContain("AdjustmentsRestricted");
    expect(src).toContain("access.canView");
    expect(src).not.toContain("notFound");
  });

  it("the account overview and the customer page show the adjustments pieces only to people who hold adjustment.view", () => {
    expect(read("src/app/(tenant)/app/page.tsx")).toMatch(/can\(ctx\.active\.role, "adjustment\.view"\) \? <AdjustmentsTile \/>/);
    expect(read("src/app/(tenant)/app/customers/[brandId]/page.tsx")).toMatch(/can\(role, "adjustment\.view"\)/);
    expect(read("src/app/(tenant)/app/layout.tsx")).toMatch(/can\(role, "adjustment\.view"\) \? \[\{ href: "\/app\/adjustments"/);
  });

  it("the page for one import validates the id from the URL before it loads anything", () => {
    const src = read("src/app/(tenant)/app/adjustments/history/[importId]/page.tsx");
    expect(src.indexOf("uuidSchema.safeParse(importId)")).toBeGreaterThan(-1);
    expect(src.indexOf("uuidSchema.safeParse(importId)")).toBeLessThan(src.indexOf("loadImportWizard("));
    expect(src).toContain("access.tenantId");
  });
});
