import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { calculateShipment } from "@/engine";
import type { ShipmentInput } from "@/engine/types";
import { fixtureContext, loadFixtureRateCard } from "../fixtures/pricing/load";

/**
 * Golden dataset: expected results were derived independently of src/engine (two separate
 * computations from the design document and the fixture files, reconciled; see
 * tests/fixtures/pricing/expected.json "_comment"). All data is FICTIONAL.
 */
const dir = path.resolve(__dirname, "../fixtures/pricing");
const scenarios = (JSON.parse(readFileSync(path.join(dir, "scenarios.json"), "utf8")) as { scenarios: Scenario[] }).scenarios;
const expected = JSON.parse(readFileSync(path.join(dir, "expected.json"), "utf8")) as Record<string, Expected>;

interface Scenario {
  id: string;
  description: string;
  context: { withOverrides?: boolean; withZipLists?: boolean; rateCard?: { effectiveDate?: string; expirationDate?: string | null } };
  input: ShipmentInput;
}

interface Expected {
  status: "ok" | "unavailable";
  unavailableReason: string | null;
  zone: string | null;
  packages: { index: number; billableLb: string; basis: string }[];
  lines: { label: string; packageIndex: number | null; amount: string; counted: boolean; chargeClass: string }[];
  totals: { definite: string; estimated: string; expected: string; conditionalExposure: string };
  warnings: string[];
}

const lineKey = (l: { label: string; packageIndex: number | null }) => `${l.packageIndex ?? "shipment"}:${l.label}`;

describe("pricing engine golden dataset", () => {
  it("has an expectation for every scenario", () => {
    for (const s of scenarios) expect(expected[s.id], s.id).toBeDefined();
  });

  for (const s of scenarios) {
    it(`${s.id}: ${s.description}`, () => {
      const exp = expected[s.id]!;
      const ctx = fixtureContext({
        withOverrides: s.context.withOverrides,
        withZipLists: s.context.withZipLists,
        rateCard: s.context.rateCard ? loadFixtureRateCard(s.context.rateCard) : undefined,
      });
      const result = calculateShipment(s.input, ctx);

      expect(result.status).toBe(exp.status);
      expect(result.unavailableReason).toBe(exp.unavailableReason);
      if (exp.status === "unavailable") return;

      expect(result.zone?.zone ?? null).toBe(exp.zone);
      expect(result.packages.map((p) => ({ index: p.packageIndex, billableLb: p.billableLb, basis: p.basis }))).toEqual(exp.packages);

      const got = Object.fromEntries(result.lines.map((l) => [lineKey(l), { amount: l.amount.amount, counted: l.counted, chargeClass: l.chargeClass }]));
      const want = Object.fromEntries(exp.lines.map((l) => [lineKey(l), { amount: l.amount, counted: l.counted, chargeClass: l.chargeClass }]));
      expect(got).toEqual(want);

      expect({ definite: result.totals.definite.amount, estimated: result.totals.estimated.amount, expected: result.totals.expected.amount, conditionalExposure: result.totals.conditionalExposure.amount }).toEqual(exp.totals);
      expect([...new Set(result.warnings.map((w) => w.code))].sort()).toEqual([...new Set(exp.warnings)].sort());
    });
  }
});
