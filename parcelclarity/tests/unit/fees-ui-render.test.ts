import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { describeFeeRule } from "@/engine/fees";
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
const { TryOrderPanel, TryOrderOutcome } = await import("@/components/fees/try-order-panel");
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
    // Keys of fee rules reach customers through the run's fee dictionary and the API, so the editor must not call them private
    // (it used to say "Customers never see it").
    expect(t).toContain("Rule keys can be read by your customers through the API, so do not put customer names or margins in them.");
    expect(t).not.toContain("Customers never see it. It cannot change");
    // Labelled controls the e2e suite relies on.
    for (const label of ["Name", "Category", "Key", "Charged", "Charged per", "Pricing", "Description (optional)", "Where this number comes from (optional)"]) expect(t, label).toContain(label);
    // The key is not private (decision D7): the labels do not say it is staff only (the source note really is).
    expect(html).toMatch(/<label[^>]*>Key<\/label>/);
    expect(t).not.toContain("Key (staff only)");
    expect(t).not.toContain("Question key (staff only)");
    expect(t).not.toContain("Group name (staff only)");
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
    expect(t).toContain("Key: ");
    expect(t).not.toContain("Key (staff only)");
  });

  it("tags each move button with its rule so keyboard focus can return to it after the list re-renders", () => {
    const html = renderToStaticMarkup(createElement(RulesWorkspace, { versionId: "v", editable: true, rules, sources: {} }));
    expect(html).toContain('data-move="id-0:up"');
    expect(html).toContain('data-move="id-0:down"');
    expect(html).toContain(`data-move="id-${rules.length - 1}:down"`);
    // Nothing is open, so no rule is held back from Edit and the hint about finishing the open rule is absent.
    expect(text(html)).not.toContain("Save or cancel this rule before you open another one");
    expect(html).not.toMatch(/<button[^>]*aria-label="Edit: [^"]*"[^>]*\sdisabled=""|<button[^>]*\sdisabled=""[^>]*aria-label="Edit: /);
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

  it("tells a person who may not edit a draft that it is a draft, not that it was locked", () => {
    const html = renderToStaticMarkup(createElement(RulesWorkspace, { versionId: "v", editable: false, draft: true, rules, sources: {} }));
    const t = text(html);
    expect(t).not.toContain("no longer a draft");
    expect(t).toContain("This version is a draft");
    expect(t).toContain("Only administrators can change its rules");
    expect(t).not.toContain("Add rule");
    expect(html).not.toContain("Move up");
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

describe("try-an-order outcome", () => {
  type Result = Parameters<typeof TryOrderOutcome>[0]["priced"]["result"];
  const empty: Result = { status: "ok", lines: [], definiteE4: 0, estimatedE4: 0, unresolved: [], warnings: [] };
  const show = (result: Result) => text(renderToStaticMarkup(createElement(TryOrderOutcome, { priced: { result, versionNumber: 2 }, namesByKey: new Map([["pack_mailer", "Poly mailer"]]) })));

  it("never prints $0.00 for an order that nothing could be computed for", () => {
    const t = show({ ...empty, status: "no_content", unresolved: [{ ruleKey: "pick_additional", name: "Each additional item", reason: "units_unknown" }] });
    expect(t).toContain("Nothing could be computed from what you entered.");
    expect(t).toMatch(/Each additional item\s*: needs the number of items\./);
    expect(t).not.toContain("$0.00");
    expect(t).not.toContain("No fee produced a charge"); // that sentence is for an order whose fees were all computed
    expect(t.match(/Not computed/g)?.length).toBeGreaterThanOrEqual(4); // three figures and the list heading
  });

  it("calls a partial total a minimum, and says monthly charges are not in it", () => {
    const t = show({
      ...empty,
      status: "partial",
      lines: [{ ruleKey: "pick_order", name: "Pick & pack, per order", category: "pick_pack", basis: "order", quantity: "1", unitAmountE4: 25000, amountE4: 25000, chargeClass: "definite", explanation: "1 order at $2.50" }],
      definiteE4: 25000,
      unresolved: [{ ruleKey: "pick_additional", name: "Each additional item", reason: "units_unknown" }],
    });
    expect(t).toContain("At least, with the fees not computed left out $2.50");
    expect(t).not.toContain("Computed fees together");
    expect(t).toContain("not per order, so they are not in these amounts");
    expect(t).toContain("These are left out of the amounts above, not counted as $0.");
  });

  it("says when the order or the rules changed after pricing, so old amounts are not read as the current ones", () => {
    const render = (stale: boolean) => text(renderToStaticMarkup(createElement(TryOrderOutcome, { priced: { result: empty, versionNumber: 2 }, namesByKey: new Map(), stale })));
    expect(render(true)).toContain("You changed the order or the rules after pricing it");
    expect(render(true)).toContain("Price it again");
    expect(render(false)).not.toContain("You changed the order");
  });

  it("says when amounts are finer than a cent, and stays quiet when they are not", () => {
    const line = (amountE4: number) => ({ ruleKey: "scan", name: "Per-unit label scan", category: "pick_pack" as const, basis: "unit" as const, quantity: "7", unitAmountE4: 125, amountE4, chargeClass: "definite" as const, explanation: "7 items × $0.0125 = $0.0875." });
    const fine = show({ ...empty, lines: [line(875)], definiteE4: 875 });
    expect(fine).toContain("$0.0875");
    expect(fine).toContain("rounds an order's total to the cent once");
    expect(show({ ...empty, lines: [line(900)], definiteE4: 900 })).not.toContain("rounds an order's total to the cent once");
    expect(show({ ...empty, status: "no_content" })).not.toContain("rounds an order's total to the cent once");
  });

  it("shows a real zero as $0.00 when every applicable fee was computed", () => {
    const t = show(empty);
    expect(t).toContain("Every applicable fee was computed.");
    expect(t).toContain("$0.00");
    expect(t).not.toContain("Not computed");
  });

  it("does not offer to price an order on a version with no rules", () => {
    const t = text(renderToStaticMarkup(createElement(TryOrderPanel, { versionId: "v", rules: [], packagingTypes: [] })));
    expect(t).toContain("nothing to price");
    expect(t).not.toContain("Price this order");
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
    // A draft that this person may not change reads as a draft, not as a closed version.
    const viewerDraft = text(renderToStaticMarkup(createElement(RoundingSelect, { versionId: "v", value: "transaction", editable: false, draft: true })));
    expect(viewerDraft).toContain("Only administrators can change this while the version is a draft.");
    expect(viewerDraft).not.toContain("no longer a draft");
    const open = renderToStaticMarkup(createElement(RoundingSelect, { versionId: "v", value: "invoice_line", editable: true }));
    expect(open).not.toMatch(/<select[^>]*\sdisabled=""/);
    expect(text(renderToStaticMarkup(createElement(VersionNotesForm, { versionId: "v", notes: "Approved by Pat", editable: false })))).toContain("Approved by Pat");
    expect(text(renderToStaticMarkup(createElement(VersionNotesForm, { versionId: "v", notes: null, editable: false })))).toContain("No notes on this version.");
    const form = renderToStaticMarkup(createElement(VersionNotesForm, { versionId: "v", notes: "Approved by Pat", editable: true }));
    expect(form).toContain("Save notes");
    expect(text(form)).toContain("customers never see it");
  });
});

describe("customer wording of tiers", () => {
  const tiered = (upTo: string): FeeRule => ({
    key: "pick",
    name: "Pick fee",
    category: "pick_pack",
    scope: "order",
    basis: "unit",
    method: "tiered",
    amount: null,
    percent: null,
    position: 0,
    tiers: { on: "order_quantity", mode: "graduated", pricing: "rate", brackets: [{ upTo, amount: "3.00" }, { upTo: null, amount: "0.40" }] },
  });

  it("reads a one-unit bracket in the singular", () => {
    expect(describeFeeRule(tiered("1"))).toContain("1 item: $3.00 each; 2+ items: $0.40 each");
    expect(describeFeeRule(tiered("10"))).toContain("1–10 items: $3.00 each; 11+ items: $0.40 each");
  });
});
