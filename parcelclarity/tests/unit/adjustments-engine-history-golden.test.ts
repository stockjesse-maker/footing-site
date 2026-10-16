import { describe, expect, it } from "vitest";
import { summariseHistory, type HistoryBaseline, type HistoryFilters, type HistoryRecord } from "@/engine/adjustments";
import { fixture, mismatches } from "./adjustments-engine-support";

/**
 * History goldens: all 39 cases of scenarios.json "historyCases" against expected.json "history". Expected values
 * come from the hand derivation (and a second Fraction-based implementation) of RULES.md part C; Wilson values compare
 * exactly at 4 dp and to 1e-9 percent at 10 dp.
 */
interface HistoryCase {
  id: string;
  description: string;
  records: string;
  baselines: string;
  filters: HistoryFilters;
}
const { historyCases } = fixture<{ historyCases: HistoryCase[] }>("scenarios.json");
const recordSets = fixture<{ recordSets: Record<string, HistoryRecord[]> }>("history-records.json").recordSets;
const baselineSets = fixture<{ baselineSets: Record<string, HistoryBaseline[]> }>("history-baselines.json").baselineSets;
const expected = fixture<{ history: Record<string, Record<string, unknown>> }>("expected.json").history;

/** Removes the 10-dp Wilson references from a comparison and checks them with a tolerance instead. */
function split(exp: Record<string, unknown>): { exact: Record<string, unknown>; tolerance: { path: string; value: string }[] } {
  const tolerance: { path: string; value: string }[] = [];
  const strip = (v: unknown, at: string): unknown => {
    if (Array.isArray(v)) return v.map((x, i) => strip(x, `${at}[${i}]`));
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => {
          if (/Pct10dp$/.test(k)) {
            tolerance.push({ path: `${at}.${k}`, value: x as string });
            return [];
          }
          return [[k, strip(x, `${at}.${k}`)]];
        }),
      );
    }
    return v;
  };
  return { exact: strip(exp, "$") as Record<string, unknown>, tolerance };
}

const at = (obj: unknown, path: string): unknown => path.replace(/^\$\.?/, "").split(".").filter(Boolean).reduce<unknown>((o, k) => {
  const m = /^(.*?)\[(\d+)\]$/.exec(k);
  return m ? (o as Record<string, unknown[]>)[m[1]!]![Number(m[2])] : (o as Record<string, unknown>)[k];
}, obj);

describe("history statistics goldens", () => {
  it("covers every case (39) with an expectation", () => {
    expect(historyCases).toHaveLength(39);
    expect(Object.keys(expected).sort()).toEqual(historyCases.map((c) => c.id).sort());
  });

  for (const c of historyCases) {
    it(`${c.id}: ${c.description}`, () => {
      const result = summariseHistory(recordSets[c.records]!, baselineSets[c.baselines]!, c.filters);
      expect(JSON.parse(JSON.stringify(result)), `${c.id}: plain JSON (no Decimal, no negative zero)`).toEqual(result);
      const { exact, tolerance } = split(expected[c.id]!);
      expect(mismatches(result, exact)).toEqual([]);
      for (const t of tolerance) {
        const got = at(result, t.path);
        expect(typeof got, `${c.id} ${t.path}`).toBe("string");
        expect(Math.abs(Number(got) - Number(t.value)), `${c.id} ${t.path}: ${got} vs ${t.value}`).toBeLessThan(1e-9);
      }
    });
  }
});
