import { BASIS_LABELS, FEE_CATEGORY_WORDS, formatCount, pluralize } from "@/lib/adjustments/staff-copy";

/**
 * The Overview checklist, computed from what `loadOverview` returns (src/lib/adjustments/queries.ts). Nothing is stored: each step is "done"
 * or "not done" from the data of today. Pure (no React, no I/O) so the screen and its tests share one source.
 *
 * What `loadOverview` provides for step 1 is a COUNT of the reweigh, remeasure and correction fee rules in force. It cannot say "I do not
 * charge a separate fee": nothing stores that choice, so the screen explains it in help text and the step stays open until a rule exists.
 */
export interface OverviewInput {
  feeRules: { count: number; byCategory: Record<string, number> };
  policies: { cells: number; decided: number; undecided: number; exceptions: number };
  scenarios: { active: number };
  examples: { live: number; current: number; underReview: number; expired: number };
  customersSeeingUndecidedRule: { brandId: string; brandName: string; categories: string[] }[];
  /** For "where things stand" and the /app tile; optional so the checklist alone can be computed from the first six. */
  estimates?: { active: number; latest: { name: string; basis: "declared_weights" | "actual_weights" | null; createdAt: string } | null };
  imports?: { committed: number; records: number };
}

export interface ChecklistStep {
  n: 1 | 2 | 3 | 4;
  id: "fee-rule" | "who-pays" | "example" | "share";
  title: string;
  done: boolean;
  /** One plain sentence about where this step stands today. */
  detail: string;
  /** Help text that does not depend on the data. */
  help: string | null;
  action: { label: string; href: string } | null;
}

function ruleWords(byCategory: Record<string, number>): string {
  const parts = Object.entries(byCategory)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([category, n]) => `${formatCount(n)} ${FEE_CATEGORY_WORDS[category] ?? "correction"}`);
  return parts.join(", ");
}

export function checklistSteps(o: OverviewInput, help: { noSeparateFee: string }): ChecklistStep[] {
  const ruleCount = o.feeRules.count;
  const { cells, decided, undecided, exceptions } = o.policies;
  const e = o.examples;
  return [
    {
      n: 1,
      id: "fee-rule",
      title: "Add a fee rule for corrections",
      done: ruleCount > 0,
      detail: ruleCount > 0 ? `${pluralize(ruleCount, "fee rule")} in force: ${ruleWords(o.feeRules.byCategory)}.` : "No reweigh, remeasure or correction fee rule is in force.",
      help: ruleCount > 0 ? null : help.noSeparateFee,
      action: ruleCount > 0 ? { label: "See surcharge rules", href: "/app/surcharges" } : { label: "Add a surcharge rule", href: "/app/surcharges/new" },
    },
    {
      n: 2,
      id: "who-pays",
      title: "Decide who pays",
      done: undecided === 0,
      detail:
        undecided === 0
          ? `All ${formatCount(cells)} decisions are made for all customers.${exceptions > 0 ? ` ${pluralize(exceptions, "decision")} ${exceptions === 1 ? "is" : "are"} set for individual customers.` : ""}`
          : `${formatCount(decided)} of ${formatCount(cells)} decisions are made for all customers. ${formatCount(undecided)} still ${undecided === 1 ? "reads" : "read"} Not decided.${exceptions > 0 ? ` ${pluralize(exceptions, "decision")} ${exceptions === 1 ? "is" : "are"} set for individual customers.` : ""}`,
      help: "Decide for all customers first, then add exceptions for the customers whose agreement differs.",
      action: { label: undecided === 0 ? "Review decisions" : "Decide who pays", href: "/app/adjustments/policies" },
    },
    {
      n: 3,
      id: "example",
      title: "Build an example",
      done: o.scenarios.active > 0 || e.live > 0,
      detail: o.scenarios.active > 0 ? `${pluralize(o.scenarios.active, "saved example")}.` : e.live > 0 ? "No saved examples, but examples are shared with customers." : "No example yet. Price a package that is corrected after labelling.",
      help: null,
      action: { label: o.scenarios.active > 0 ? "Open examples" : "Build an example", href: "/app/adjustments/examples" },
    },
    {
      n: 4,
      id: "share",
      title: "Share it with a customer",
      done: e.current > 0,
      detail:
        e.live === 0
          ? "Nothing is shared yet."
          : `${pluralize(e.live, "example")} shared: ${formatCount(e.current)} current${e.underReview > 0 ? `, ${formatCount(e.underReview)} under review` : ""}${e.expired > 0 ? `, ${formatCount(e.expired)} expired` : ""}.`,
      help: null,
      action: { label: e.underReview + e.expired > 0 ? "Review shared examples" : "Share an example", href: "/app/adjustments/examples" },
    },
  ];
}

export interface UndecidedRuleWarning {
  customers: { brandId: string; brandName: string; words: string }[];
  /** How many customers are not listed because the list is capped. */
  more: number;
}

const MAX_LISTED = 10;

/** The warning for customers who can read a fee rule that nobody has decided who pays (design D8). Null when there are none. */
export function undecidedRuleWarning(o: Pick<OverviewInput, "customersSeeingUndecidedRule">): UndecidedRuleWarning | null {
  const list = o.customersSeeingUndecidedRule;
  if (!list.length) return null;
  return {
    customers: list.slice(0, MAX_LISTED).map((c) => ({ brandId: c.brandId, brandName: c.brandName, words: c.categories.map((k) => FEE_CATEGORY_WORDS[k] ?? "correction").join(", ") })),
    more: Math.max(0, list.length - MAX_LISTED),
  };
}

/** A published fee rule that is not a conditional charge (`adjustment_legacy_fee_rules`): it predates the rule that makes these fees conditional. */
export interface LegacyFeeRule {
  ruleName: string;
  versionNumber: number;
}

/** Reads the answer of `adjustment_legacy_fee_rules` defensively; anything that is not the promised shape is "could not be read" (null), never "none". */
export function parseLegacyFeeRules(raw: unknown): LegacyFeeRule[] | null {
  if (!Array.isArray(raw)) return null;
  const out: LegacyFeeRule[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const { ruleName, versionNumber } = item as Record<string, unknown>;
    if (typeof ruleName !== "string" || typeof versionNumber !== "number" || !Number.isInteger(versionNumber)) return null;
    out.push({ ruleName, versionNumber });
  }
  return out;
}

/** One line of "where things stand": a label, the value in words, and where to go. */
export interface GlanceRow {
  id: string;
  label: string;
  value: string;
  detail: string | null;
  href: string;
  linkLabel: string;
}

/** The figures the Overview shows under the checklist. Counts of things the account holds; never a money figure and never a rate. */
export function glanceRows(o: OverviewInput): GlanceRow[] {
  const { cells, decided, exceptions } = o.policies;
  const e = o.examples;
  const rows: GlanceRow[] = [
    {
      id: "decisions",
      label: "Decisions for all customers",
      value: `${formatCount(decided)} of ${formatCount(cells)} made`,
      detail: exceptions > 0 ? `${pluralize(exceptions, "decision")} set for individual customers` : null,
      href: "/app/adjustments/policies",
      linkLabel: "Open policies",
    },
  ];
  if (o.imports) {
    rows.push({
      id: "history",
      label: "History imported",
      value: o.imports.committed === 0 ? "None yet" : `${pluralize(o.imports.records, "record")} from ${pluralize(o.imports.committed, "import")}`,
      detail: null,
      href: "/app/adjustments/history",
      linkLabel: "Open history",
    });
  }
  rows.push({
    id: "examples",
    label: "Examples shared with customers",
    value: e.live === 0 ? "None shared" : `${formatCount(e.live)} shared`,
    detail: e.live === 0 ? null : `${formatCount(e.current)} current${e.underReview > 0 ? `, ${formatCount(e.underReview)} under review` : ""}${e.expired > 0 ? `, ${formatCount(e.expired)} expired` : ""}`,
    href: "/app/adjustments/examples",
    linkLabel: "Open examples",
  });
  if (o.estimates) {
    const latest = o.estimates.latest;
    rows.push({
      id: "estimates",
      label: "Saved estimates",
      value: o.estimates.active === 0 ? "None saved" : `${formatCount(o.estimates.active)} saved`,
      detail: latest ? `Latest: ${latest.name}, ${latest.basis ? (BASIS_LABELS[latest.basis] ?? "basis not recorded") : "basis not recorded"}` : null,
      href: "/app/adjustments/risk",
      linkLabel: "Open risk estimates",
    });
  }
  return rows;
}
