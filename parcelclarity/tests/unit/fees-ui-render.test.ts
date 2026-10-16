import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { FeeRule, FeeScheduleSnapshot } from "@/engine/fees/types";

// The editor's components call server actions on events only; rendering them needs no server.
vi.mock("@/app/actions/fee-schedules", () => ({
  saveFeeRule: vi.fn(),
  saveRuleSource: vi.fn(),
  deleteFeeRule: vi.fn(),
  reorderFeeRules: vi.fn(),
  tryFeeOrder: vi.fn(),
  createDraftVersion: vi.fn(),
  activateFeeVersion: vi.fn(),
  endFeeVersion: vi.fn(),
  updateDraftRounding: vi.fn(),
  saveVersionNotes: vi.fn(),
}));
// DateField lives beside the rate-card terms form, which imports that module's actions.
vi.mock("@/app/actions/rate-cards", () => ({ updateServiceTerms: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const { RuleForm } = await import("@/components/fees/rule-form");
const { RulesWorkspace } = await import("@/components/fees/rules-workspace");
const { TryOrderPanel } = await import("@/components/fees/try-order-panel");
const { ActivateVersionButton, EndVersionButton, NewDraftControl, RoundingSelect, VersionNotesForm } = await import("@/components/fees/version-controls");

/**
 * Server-renders every client component of the fee-schedule editor for every fixture rule, so a
 * render path that throws (a bad prop, a missing field, a hook misused) fails here rather than in the
 * browser. Interactions are covered by the e2e suite; this is the cheap net under it.
 */
const dir = new URL("../fixtures/fees/", import.meta.url);
const schedules = JSON.parse(readFileSync(new URL("schedules.json", dir), "utf8")) as Record<string, FeeScheduleSnapshot>;
const fixtureRules = Object.entries(schedules)
  .filter(([k]) => !k.startsWith("_"))
  .flatMap(([name, s]) => s.rules.map((rule, i) => ({ name, rule: { ...rule, id: `rule-${name}-${i}` } as FeeRule, siblings: s.rules.filter((r) => r.key !== rule.key).map((r, j) => ({ ...r, id: `sib-${name}-${j}` }) as FeeRule) })));

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const noop = () => undefined;

describe("rule editor renders", () => {
  it("for every fixture rule, filled in", () => {
    expect(fixtureRules.length).toBeGreaterThan(30);
    for (const { name, rule, siblings } of fixtureRules) {
      const html = renderToStaticMarkup(createElement(RuleForm, { versionId: "v", rule, source: "Contract clause 4.2", otherRules: siblings, onSaved: noop, onCancel: noop }));
      const t = text(html);
      expect(t, `${name}.${rule.key}`).toContain(`Edit rule: ${rule.name}`);
      expect(t).toContain("Save rule");
      expect(t).toContain("Preview");
      // The preview shows the customer's wording for the rule as saved.
      expect(t, `${name}.${rule.key} preview`).not.toContain("Fill in the fields above");
      // The staff-only source is in the form and labelled as staff only.
      expect(html).toContain("Contract clause 4.2");
      if (rule.method === "tiered") expect(t).toContain("Bracket 1: up to");
      if (rule.driver) expect(t).toContain("The question your customer answers");
      if (rule.basis === "minimum") expect(t).toMatch(/Counts \d+ fees?/);
      if (rule.driver?.longTerm) expect(t).toContain("Held longer than (days)");
      if (rule.scope === "order") expect(t).toContain("Only some orders (optional)");
      else expect(t).not.toContain("Only some orders (optional)");
      // The key of a saved rule cannot change.
      expect(html).toMatch(/readOnly=""|readonly=""/i);
    }
  });

  it("for a new rule: the presets, and no errors before anything is typed", () => {
    const html = renderToStaticMarkup(createElement(RuleForm, { versionId: "v", rule: null, source: null, otherRules: [], onSaved: noop, onCancel: noop }));
    const t = text(html);
    expect(t).toContain("Add a rule");
    for (const label of [
      "First pick included",
      "Additional units",
      "Per line, first unit of each line free",
      "Additional packages",
      "Percent of shipping",
      "Monthly storage per pallet",
      "Long-term storage",
      "Receiving per pallet",
      "Returns per order",
      "Account minimum",
      "Flat monthly fee",
    ]) {
      expect(t, label).toContain(label);
    }
    expect(t).toContain("Fill in the fields above to see the wording your customer will read.");
    expect(html).not.toContain('role="alert"');
    // Labelled controls the e2e suite relies on.
    for (const label of ["Name", "Category", "Key (staff only)", "Charged", "Charged per", "Pricing", "Description (optional)", "Where this number comes from (optional)"]) expect(t, label).toContain(label);
    expect(html).toContain(">Save rule<");
    expect(html).toContain(">Cancel<");
  });
});

describe("rules list renders", () => {
  const rules = schedules.standard!.rules.map((r, i) => ({ ...r, id: `id-${i}` }) as FeeRule);

  it("with controls for a draft", () => {
    const html = renderToStaticMarkup(createElement(RulesWorkspace, { versionId: "v", editable: true, rules, sources: { "id-0": "Pricing sheet, May" } }));
    const t = text(html);
    expect(t).toContain("Add rule");
    expect(html).toContain('aria-label="Move up: Pick &amp; pack, per order"');
    expect(html).toContain('aria-label="Move down: Pick &amp; pack, per order"');
    expect(html).toContain('aria-label="Edit: Pick &amp; pack, per order"');
    expect(html).toContain('aria-label="Delete: Pick &amp; pack, per order"');
    // The first rule cannot move up, the last cannot move down.
    expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*aria-label="Move up: Pick &amp; pack, per order"|<button[^>]*aria-label="Move up: Pick &amp; pack, per order"[^>]*\sdisabled=""/);
    expect(t).toContain("Source (staff only): Pricing sheet, May");
    expect(t).toContain("Key (staff only):");
  });

  it("read-only for any other version", () => {
    const html = renderToStaticMarkup(createElement(RulesWorkspace, { versionId: "v", editable: false, rules, sources: {} }));
    const t = text(html);
    expect(t).not.toContain("Add rule");
    expect(html).not.toContain("Move up");
    expect(html).not.toContain(">Delete<");
    expect(html).not.toContain(">Edit<");
    expect(t).toContain("no longer a draft");
    expect(t).toContain("$2.50 per order.");
  });

  it("with a prompt when there are no rules", () => {
    const t = text(renderToStaticMarkup(createElement(RulesWorkspace, { versionId: "v", editable: true, rules: [], sources: {} })));
    expect(t).toContain("No rules yet");
    expect(t).toContain("Add rule");
  });
});

describe("try-an-order panel renders", () => {
  it("only asks what the version reads", () => {
    const withShares = text(renderToStaticMarkup(createElement(TryOrderPanel, { versionId: "v", rules: schedules.standard!.rules as FeeRule[], packagingTypes: ["poly mailer", "box"] })));
    for (const label of ["Items", "Order lines", "Different products", "Package 1: packaging type", "Shipments", "Shipping cost of the order (USD)", "Base shipping rate (USD, optional)", "Price this order"]) expect(withShares, label).toContain(label);
    expect(withShares).toContain("Orders that get marketing inserts");
    expect(withShares).toContain("Share of orders (%)");
    expect(withShares).not.toContain("Orders a month");

    const withTiers = text(renderToStaticMarkup(createElement(TryOrderPanel, { versionId: "v", rules: schedules.tiers!.rules as FeeRule[], packagingTypes: [] })));
    expect(withTiers).toContain("Orders a month");
    expect(withTiers).not.toContain("Share of orders (%)");
    expect(withTiers).toContain("never as $0");
  });
});

describe("version controls render", () => {
  it("activate and end open dialogs on demand, with nothing mounted until then", () => {
    const activate = renderToStaticMarkup(createElement(ActivateVersionButton, { versionId: "v1", versionNumber: 3 }));
    expect(activate).toContain("Activate…");
    expect(activate).toContain("<dialog");
    expect(activate).not.toContain("Effective date");
    const end = renderToStaticMarkup(createElement(EndVersionButton, { versionId: "v1", versionNumber: 3, expirationDate: null }));
    expect(end).toContain("End…");
    expect(end).not.toContain("Last effective date");
  });

  it("new draft offers an empty draft or a copy, defaulting to the current version", () => {
    const html = renderToStaticMarkup(
      createElement(NewDraftControl, {
        scheduleId: "s",
        versions: [
          { id: "a", versionNumber: 1, status: "archived" },
          { id: "b", versionNumber: 2, status: "active" },
          { id: "c", versionNumber: 3, status: "discarded" },
        ],
      }),
    );
    const t = text(html);
    expect(t).toContain("An empty draft");
    expect(t).toContain("A copy of version 2 (active)");
    expect(html).toMatch(/<option value="b" selected="">/);
    expect(t).toContain("New draft");
  });

  it("rounding and notes are locked unless the version is a draft", () => {
    const locked = renderToStaticMarkup(createElement(RoundingSelect, { versionId: "v", value: "transaction", editable: false }));
    expect(locked).toMatch(/<select[^>]*\sdisabled=""/);
    expect(text(locked)).toContain("Locked because this version is no longer a draft.");
    const open = renderToStaticMarkup(createElement(RoundingSelect, { versionId: "v", value: "invoice_line", editable: true }));
    expect(open).not.toMatch(/<select[^>]*\sdisabled=""/);
    expect(text(renderToStaticMarkup(createElement(VersionNotesForm, { versionId: "v", notes: "Approved by Pat", editable: false })))).toContain("Approved by Pat");
    expect(text(renderToStaticMarkup(createElement(VersionNotesForm, { versionId: "v", notes: null, editable: false })))).toContain("No notes on this version.");
    const form = renderToStaticMarkup(createElement(VersionNotesForm, { versionId: "v", notes: "Approved by Pat", editable: true }));
    expect(form).toContain("Save notes");
    expect(text(form)).toContain("customers never see it");
  });
});
