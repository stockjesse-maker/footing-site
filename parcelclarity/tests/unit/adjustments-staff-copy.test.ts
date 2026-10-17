import { describe, expect, it } from "vitest";
import {
  ADJUSTMENT_TABS,
  ATTESTATION_TEXT,
  BANNED_OWN_AMOUNT_WORDS,
  BASELINES_EMPTY,
  BASIS_LABELS,
  CAUSE_LABELS,
  CAUSE_OPTIONS,
  DUPLICATE_OPTIONS,
  HANDLING_BADGES,
  HANDLING_CHOICES,
  HANDLING_HELP,
  HANDLING_LABELS,
  HISTORY_EMPTY_BODY,
  HISTORY_EMPTY_TITLE,
  IMPORT_LIMITS,
  IMPORT_STATUS_LABELS,
  IMPORT_STATUS_TONES,
  INHERIT_LABEL,
  MONEY_FIELD_HINT,
  MONEY_FIELD_LABELS,
  POLICIES_EMPTY,
  POLICY_COMPONENT_LABELS,
  POLICY_TYPE_LABELS,
  PRIVATE_NOTICE,
  RANGE_SENTENCE,
  REFUSAL_TITLE,
  STATS_EMPTY,
  STATS_NO_BASELINE,
  TEMPLATE_HREF,
  UNDECIDED_TEXT,
  formatCount,
  formatDateRange,
  formatE4,
  formatE4Words,
  formatIsoDate,
  isImportOpen,
  isTabActive,
  pluralize,
  type ImportStatusKey,
} from "@/lib/adjustments/staff-copy";
import * as staffCopy from "@/lib/adjustments/staff-copy";
import { HISTORY_EMPTY } from "@/lib/adjustments/copy";
import { bannedIn } from "./adjustments-staff-support";

/** The 3PL-side wording and small pure helpers: the exact strings the design and the customer review prescribe, and the words they ban. */

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === "object" && !(value instanceof RegExp)) for (const v of Object.values(value)) strings(v, out);
  return out;
}

describe("exact strings of the 3PL screens", () => {
  it("the statement before a file is checked, the money rule and the three money labels", () => {
    expect(ATTESTATION_TEXT).toBe("These charge columns hold what my customer was or would be charged. They do not hold what the carrier billed me.");
    expect(MONEY_FIELD_HINT).toBe("Enter what your customer is charged, never what the carrier bills you.");
    expect(MONEY_FIELD_LABELS).toEqual({
      originalCharge: "Original charge to your customer",
      correctedCharge: "Corrected charge to your customer",
      adjustmentFee: "Separate adjustment fee charged to your customer",
    });
    expect(REFUSAL_TITLE).toBe("This file looks like carrier cost data");
  });

  it("the private-data notice, the limits sentence and the template link", () => {
    expect(PRIVATE_NOTICE).toBe("Only your team can see this. Customers never do.");
    expect(IMPORT_LIMITS).toBe("5 MB, 20,000 rows; split by month");
    expect(TEMPLATE_HREF).toBe("/api/templates/adjustments.csv");
  });

  it("the four policy rows and two columns are named as the design says", () => {
    expect(POLICY_TYPE_LABELS).toEqual({ reweight: "Reweigh", remeasure: "Remeasure", combined: "Both together", correction: "Other correction fee" });
    expect(POLICY_COMPONENT_LABELS).toEqual({ postage_difference: "Shipping charge difference", separate_fee: "Separate adjustment fee" });
  });

  it("the three handling choices keep one name everywhere, and the first has the agreement help", () => {
    expect(HANDLING_CHOICES).toEqual(["pass_through", "manual_approval", "absorbed"]);
    expect(HANDLING_LABELS).toEqual({
      pass_through: "Passed through under the customer agreement",
      manual_approval: "Decided case by case",
      absorbed: "Not billed to the customer (at your customer rates)",
    });
    expect(HANDLING_HELP.pass_through).toBe("Choose this only if your agreement with this customer lets you charge it.");
    expect(UNDECIDED_TEXT).toBe("Not decided");
    expect(INHERIT_LABEL).toBe("Use the all-customers decision");
    expect(HANDLING_BADGES.unconfigured).toBe("Not decided");
  });

  it("empty states say what to do next", () => {
    expect(POLICIES_EMPTY).toBe("No decisions yet. Choose who pays for each kind of adjustment. Until you do, nothing can be shared with a customer.");
    expect(`${HISTORY_EMPTY_TITLE}. ${HISTORY_EMPTY_BODY}`).toBe(HISTORY_EMPTY);
    expect(STATS_EMPTY).toMatch(/^No history yet\. Import a file/);
    expect(BASELINES_EMPTY).toMatch(/Add how many packages you shipped in a period/);
    expect(STATS_NO_BASELINE).toBe("Add how many packages you shipped in this period to see how often adjustments happen");
    expect(RANGE_SENTENCE.toLowerCase()).toContain("range reflects incidence uncertainty only");
  });

  it("an unknown duplicate handling cannot be chosen by accident: refuse is listed first and is the safe one", () => {
    expect(DUPLICATE_OPTIONS.map((o) => o.value)).toEqual(["refuse", "sum", "first"]);
    expect(DUPLICATE_OPTIONS[0]!.help).toContain("safe");
    for (const o of DUPLICATE_OPTIONS) expect(o.label.length).toBeGreaterThan(0);
  });

  it("every cause has a plain label, and the basis names are the risk form's", () => {
    expect(CAUSE_OPTIONS).toHaveLength(6);
    for (const c of CAUSE_OPTIONS) expect(CAUSE_LABELS[c]).toBeTruthy();
    expect(BASIS_LABELS).toEqual({ declared_weights: "Declared weights", actual_weights: "Actual weights" });
  });
});

describe("the five tabs", () => {
  it("are Overview, Policies, History, Examples and Risk, in that order, under /app/adjustments", () => {
    expect(ADJUSTMENT_TABS.map((t) => t.label)).toEqual(["Overview", "Policies", "History", "Examples", "Risk"]);
    expect(ADJUSTMENT_TABS.map((t) => t.href)).toEqual(["/app/adjustments", "/app/adjustments/policies", "/app/adjustments/history", "/app/adjustments/examples", "/app/adjustments/risk"]);
  });

  it("mark the current one: Overview only on its own path, the others on their subpages too", () => {
    const [overview, policies, history] = ADJUSTMENT_TABS as [(typeof ADJUSTMENT_TABS)[number], (typeof ADJUSTMENT_TABS)[number], (typeof ADJUSTMENT_TABS)[number]];
    expect(isTabActive("/app/adjustments", overview)).toBe(true);
    expect(isTabActive("/app/adjustments/history", overview)).toBe(false);
    expect(isTabActive("/app/adjustments/history", history)).toBe(true);
    expect(isTabActive("/app/adjustments/history/abc", history)).toBe(true);
    expect(isTabActive("/app/adjustments/history-other", history)).toBe(false);
    expect(isTabActive("/app/adjustments/policies", policies)).toBe(true);
  });
});

describe("import statuses", () => {
  const all: ImportStatusKey[] = ["uploaded", "mapped", "validated", "committing", "committed", "discarded", "withdrawn"];
  it("have a plain label and a tone each, and four of them are open", () => {
    for (const s of all) {
      expect(IMPORT_STATUS_LABELS[s]).toBeTruthy();
      expect(IMPORT_STATUS_TONES[s]).toBeTruthy();
    }
    expect(all.filter(isImportOpen)).toEqual(["uploaded", "mapped", "validated", "committing"]);
  });
});

describe("money and date display", () => {
  it("rounds an amount once, HALF_UP, to the cent, from ten-thousandths of a dollar", () => {
    expect(formatE4(0)).toBe("$0.00");
    expect(formatE4(49)).toBe("$0.00");
    expect(formatE4(50)).toBe("$0.01");
    expect(formatE4(53000)).toBe("$5.30");
    expect(formatE4(14_600_000)).toBe("$1,460.00");
    expect(formatE4(1_234_567)).toBe("$123.46");
  });

  it("says a credit in words, never by colour or sign alone, and never writes -$0.00", () => {
    expect(formatE4Words(-12_000)).toBe("-$1.20 credit");
    expect(formatE4Words(12_000)).toBe("$1.20");
    expect(formatE4(-10)).toBe("$0.00");
  });

  it("formats counts, plurals and dates without a clock", () => {
    expect(formatCount(20000)).toBe("20,000");
    expect(pluralize(1, "row")).toBe("1 row");
    expect(pluralize(2, "row")).toBe("2 rows");
    expect(pluralize(2, "adjustment record")).toBe("2 adjustment records");
    expect(formatIsoDate("2026-10-16")).toBe("Oct 16, 2026");
    expect(formatIsoDate("not a date")).toBe("not a date");
    expect(formatDateRange("2026-03-01", "2026-03-31")).toBe("Mar 1, 2026 to Mar 31, 2026");
    expect(formatDateRange("2026-03-01", "2026-03-01")).toBe("Mar 1, 2026");
    expect(formatDateRange(null, "2026-03-01")).toBeNull();
  });
});

describe("banned wording for the 3PL's own amounts", () => {
  it("is exported as one list and every string of staff-copy passes it", () => {
    expect(BANNED_OWN_AMOUNT_WORDS.length).toBeGreaterThanOrEqual(5);
    const offenders = strings(Object.values(staffCopy).filter((v) => typeof v !== "function" && !(Array.isArray(v) && v.every((x) => x instanceof RegExp)))).filter((s) => bannedIn(s).length > 0);
    expect(offenders).toEqual([]);
  });

  it("the helper itself catches each banned word, and lets the refusal title through", () => {
    for (const w of ["cost", "loss", "margin", "profit", "buy rate", "Costs", "losses"]) expect(bannedIn(`This is a ${w} figure`).length, w).toBeGreaterThan(0);
    expect(bannedIn(REFUSAL_TITLE)).toEqual([]);
    expect(bannedIn("Not billed to the customer (at your customer rates)")).toEqual([]);
  });
});
