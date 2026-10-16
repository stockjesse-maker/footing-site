import { formatRate, fromE4 } from "@/engine/fees";
import type { FeeBasis, FeeCategory, FeeMinimum, FeeRule, FeeScope, FeeUnresolvedReason } from "@/engine/fees/types";
import { dec } from "@/engine/money";

/**
 * Labels and small pure helpers shared by the fee-schedule screens (staff editor, customer view,
 * assignment card). No hooks and no I/O, so server and client components can both import it.
 */

export const CATEGORY_LABELS: Record<FeeCategory, string> = {
  pick_pack: "Pick & pack",
  packaging: "Packaging",
  kitting: "Kitting & assembly",
  labeling: "Labeling",
  receiving: "Receiving",
  storage: "Storage",
  returns: "Returns",
  account: "Account",
  other: "Other",
};

export const SCOPE_LABELS: Record<FeeScope, string> = {
  order: "Per order",
  monthly: "Per month",
};

/** The basis in the 3PL's words (editor lists and badges). */
export const BASIS_LABELS: Record<FeeBasis, string> = {
  order: "Per order",
  unit: "Per item",
  line: "Per order line",
  sku: "Per product",
  package: "Per package",
  shipment: "Per shipment",
  shipping_percent: "Percent of shipping",
  order_driver: "Per insert, kit or label",
  month: "Flat monthly fee",
  driver: "Per stated quantity",
  minimum: "Account minimum",
};

/** How a version rounds money (values are the database's `rounding` column). */
export const ROUNDING_OPTIONS = [
  { value: "invoice_line", label: "Invoice line: add up exactly, round to the cent once per charge (recommended)" },
  { value: "transaction", label: "Transaction: round the fee on every order to the cent" },
] as const;

export const UNRESOLVED_REASON_LABELS: Record<FeeUnresolvedReason, string> = {
  units_unknown: "needs the number of items",
  lines_unknown: "needs the number of order lines",
  skus_unknown: "needs the number of different products",
  packaging_unknown: "needs the packaging type of each package",
  packaging_unmatched: "no rule prices this packaging type",
  shipping_unknown: "needs the order's shipping cost",
  assumption_missing: "needs an answer the customer has not given (inserts, kits or a monthly volume)",
  replaced: "not charged because an alternative in its group applies",
};

export const WARNING_LABELS: Record<string, string> = {
  fee_base_excludes_exposure: "A percentage fee is taken of the shipping base, which leaves out conditional carrier charges that may be added after shipping.",
  packaging_defaulted: "Packaging was assumed for packages with no type, so packaging fees are estimates.",
};

/** Dollars with up to four decimals, at least two: 1.25 → "$1.25", 0.0125 → "$0.0125". Exact, no float arithmetic. */
export function moneyE4(e4: number): string {
  return `${e4 < 0 ? "−" : ""}$${formatRate(fromE4(Math.abs(e4)))}`;
}

/** A decimal string of dollars as "$2.50" (up to four decimals). */
export function dollars(value: string | null | undefined): string {
  if (value === null || value === undefined || value.trim() === "") return "—";
  try {
    return `$${formatRate(dec(value.trim()))}`;
  } catch {
    return value;
  }
}

/** "2.5000" → "2.5", "15.0000" → "15", "0" → "0". */
export function tidy(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

/** Text of a numeric value that jsonb may hold as a number or a string. */
export function textOf(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return tidy(Number.isFinite(value) ? String(value) : "");
  return typeof value === "string" ? tidy(value) : "";
}

/** The rules an account minimum is measured against, as `app.fee_version_problem` resolves them at activation. */
export function resolveMinimumMembers(rules: FeeRule[], minimum: FeeMinimum): FeeRule[] {
  const include = new Set(minimum.appliesTo.includeRuleKeys);
  const exclude = new Set(minimum.appliesTo.excludeRuleKeys);
  const categories = new Set(minimum.appliesTo.categories);
  return rules
    .filter((r) => r.basis !== "minimum" && r.basis !== "month" && (categories.size === 0 || categories.has(r.category) || include.has(r.key)) && !exclude.has(r.key))
    .sort((a, b) => a.position - b.position || a.key.localeCompare(b.key));
}

/** "Poly mailer", "Box" → a lower-case slug fit for a rule key: letters, digits and underscores, starting with a letter. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60)
    .replace(/_+$/g, "");
  if (!slug) return "";
  return /^[a-z]/.test(slug) ? slug : `r_${slug}`.slice(0, 61);
}

/** The few fields of a version that decide which one pricing uses on a day. */
export interface VersionDates {
  status: string;
  versionNumber: number;
  effectiveDate: string | null;
  expirationDate: string | null;
}

/**
 * The version pricing uses on a day (`today`, an ISO date), as `app.fee_version_on` resolves it: an active or an
 * archived version whose dates cover the day (archived versions keep resolving so past models stay explainable),
 * an active one first, then the newest. Archiving a version therefore does not stop it applying inside its dates;
 * ending it does.
 */
export function versionInEffect<T extends VersionDates>(versions: T[], today: string): T | null {
  const covering = versions.filter((v) => (v.status === "active" || v.status === "archived") && v.effectiveDate !== null && v.effectiveDate <= today && (v.expirationDate === null || v.expirationDate >= today));
  covering.sort((a, b) => Number(b.status === "active") - Number(a.status === "active") || b.versionNumber - a.versionNumber);
  return covering[0] ?? null;
}

/** A draft's stored rule count is only set at activation, so it would read "0 rules" on a draft full of rules. */
export const countsRules = (v: { status: string }): boolean => v.status === "active" || v.status === "archived";
