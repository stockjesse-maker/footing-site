import type { Table } from "../import/parse-table";
import { cleanText } from "./cells";
import { REFUSAL_TITLE } from "./copy";
import { sheetHeaders } from "./sheet";
import type { MoneyField } from "./types";

/**
 * The header guard (Milestone 5, design v2 section 5 and amendment A4).
 *
 * ParcelClarity models what customers are CHARGED. A file whose columns look like carrier cost data is refused
 * before anything is stored: no uploaded_files row, no adjustment_imports row, and the refusal names the
 * header and never echoes a cell value. The guard is a pure function over every header of every sheet.
 *
 * Rule (tests/fixtures/adjustments/header-guard.json is the table of outcomes):
 *   1. normalise a header: split camelCase, lower-case, every run of non-alphanumerics becomes one space;
 *   2. a header equal to a template header always passes ("carrier" is a template header, "Carrier Name" is not);
 *   3. otherwise it is refused when it contains a whole word of the strict list (optional plural s):
 *      cost, rate, postage, label, carrier, net, wholesale, negotiated, paid, invoice, buy.
 * The list deliberately refuses "Carrier Name", "Net Weight", "Label ID" and "Rate Card": the 3PL renames the column and
 * the refusal says how. Beyond the table the guard also refuses "invoiced" and a few unambiguous long stems inside a
 * longer word ("PostageCost"). It is a best-effort filter. No guard can prove that a number is customer-facing: the
 * mapping step, the stored attestation and the documentation say so.
 *
 * Money columns are mapped automatically only by an exact template header or a header that says the customer was
 * charged (it contains "charged to" or "billed to", or the word "customer" beside charge, amount, fee, price or total).
 * Any other amount-like column is left unmapped and listed as a column we will ignore. A 3PL may still map one by
 * hand after attesting, but a header this guard refuses can never be mapped to anything.
 */

/** The headers of the downloadable template, in order. */
export const ADJUSTMENT_TEMPLATE_HEADERS = [
  "ship_date", "adjusted_on", "carrier", "service", "brand", "adjustment_type", "cause", "reason", "package_ref", "declared_weight", "actual_weight", "weight_unit",
  "original_length", "original_width", "original_height", "corrected_length", "corrected_width", "corrected_height", "dimension_unit",
  "customer_charge_original", "customer_charge_corrected", "customer_adjustment_fee", "handling",
] as const;

/** Splits camelCase and PascalCase ("CarrierCost", "UPSCost"), lower-cases, and turns every run of non-alphanumerics into one space. */
export function normalizeGuardHeader(h: string): string {
  return h
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const TEMPLATE_NORMALIZED: ReadonlySet<string> = new Set(ADJUSTMENT_TEMPLATE_HEADERS.map(normalizeGuardHeader));

const STEMS = ["cost", "rate", "postage", "label", "carrier", "net", "wholesale", "negotiated", "paid", "invoice", "buy"] as const;
/** The strict list with its plurals, plus "invoiced" (the database backstop refuses it too). */
const FORBIDDEN_WORDS: ReadonlySet<string> = new Set([...STEMS, ...STEMS.map((s) => `${s}s`), "invoiced"]);
/** Stems unambiguous enough to refuse inside a longer unseparated word ("postagecost", "invoicenumber"). */
const LONG_STEMS = ["wholesale", "negotiated", "postage", "invoice"] as const;

export function isTemplateHeader(header: string): boolean {
  return TEMPLATE_NORMALIZED.has(normalizeGuardHeader(header));
}

export interface HeaderVerdict {
  header: string;
  allowed: boolean;
  /** The word that caused a refusal (a stem, its plural, or the long stem found inside a word). */
  word: string | null;
}

export function guardHeader(header: string): HeaderVerdict {
  const normalized = normalizeGuardHeader(header);
  if (!normalized || TEMPLATE_NORMALIZED.has(normalized)) return { header, allowed: true, word: null };
  for (const token of normalized.split(" ")) {
    // "Cost1" and "Rate_2" are still cost and rate: a number on either end of a word does not make it another word.
    const word = token.replace(/^\d+|\d+$/g, "");
    if (FORBIDDEN_WORDS.has(word)) return { header, allowed: false, word };
    const inside = LONG_STEMS.find((stem) => token.includes(stem));
    if (inside) return { header, allowed: false, word: inside };
  }
  return { header, allowed: true, word: null };
}

export interface HeaderGuardResult {
  allowed: boolean;
  /** Every refused header in file order (first sheet first), at most 20, each as written (cleaned and shortened). */
  refusedHeaders: string[];
  /** The first refused header in file order. */
  firstRefusedHeader: string | null;
  sheet: string | null;
  /** Plain sentence for the person who uploaded the file; null when the file passes. Names the header, never a cell value. */
  message: string | null;
}

const shown = (header: string): string => cleanText(header, 80).text ?? "(blank)";

export function refusalMessage(header: string): string {
  return (
    `${REFUSAL_TITLE}. The column "${shown(header)}" looks like what a carrier bills you. ParcelClarity only accepts what your customer was, or would be, charged. ` +
    `Nothing from this file was saved. Remove that column, or export the customer charge instead, then upload again. ` +
    `If the column holds something else, rename it and upload again: "carrier" for the carrier's name, "declared_weight" or "actual_weight" for weights, ` +
    `"customer_charge_original", "customer_charge_corrected" or "customer_adjustment_fee" for what the customer was charged.`
  );
}

/** The message when a header the guard refuses is chosen for a field by hand (the manual-mapping variant). */
export function flaggedMappingMessage(header: string, money: boolean): string {
  return `The column "${shown(header)}" cannot be used for ${money ? "a charge" : "this field"}. It looks like carrier cost data.`;
}

/** The guard over a list of headers. */
export function guardHeaders(headers: readonly string[]): HeaderGuardResult {
  const refused = headers.filter((h) => !guardHeader(h).allowed);
  if (!refused.length) return { allowed: true, refusedHeaders: [], firstRefusedHeader: null, sheet: null, message: null };
  return { allowed: false, refusedHeaders: refused.slice(0, 20).map(shown), firstRefusedHeader: shown(refused[0]!), sheet: null, message: refusalMessage(refused[0]!) };
}

/** The guard over every sheet of a workbook, each at its own header row. The first refused header in sheet order wins. */
export function guardTables(tables: readonly Table[]): HeaderGuardResult {
  const refusedHeaders: string[] = [];
  let first: { header: string; sheet: string } | null = null;
  for (const t of tables) {
    const { headers } = sheetHeaders(t);
    for (const h of headers) {
      if (guardHeader(h).allowed) continue;
      first ??= { header: h, sheet: t.name };
      if (refusedHeaders.length < 20) refusedHeaders.push(shown(h));
    }
  }
  if (!first) return { allowed: true, refusedHeaders: [], firstRefusedHeader: null, sheet: null, message: null };
  return { allowed: false, refusedHeaders, firstRefusedHeader: shown(first.header), sheet: first.sheet, message: refusalMessage(first.header) };
}

// ---------------------------------------------------------------------------
// Money columns
// ---------------------------------------------------------------------------

const MONEY_WORDS: ReadonlySet<string> = new Set([
  "charge", "charges", "charged", "amount", "amounts", "fee", "fees", "price", "prices", "total", "totals", "bill", "billed", "billing", "surcharge", "surcharges",
  "credit", "credits", "debit", "debits", "payment", "payments", "balance", "fare", "fares", "dollar", "dollars", "usd", "value", "refund", "refunds", "revenue", "discount", "discounts",
]);
const CUSTOMER_MONEY_WORDS: ReadonlySet<string> = new Set(["charge", "charges", "charged", "amount", "fee", "price", "total"]);
const TEMPLATE_MONEY_HEADERS: Readonly<Record<string, MoneyField>> = {
  customer_charge_original: "originalCharge",
  customer_charge_corrected: "correctedCharge",
  customer_adjustment_fee: "adjustmentFee",
};
const TEMPLATE_MONEY_NORMALIZED = new Map(Object.entries(TEMPLATE_MONEY_HEADERS).map(([h, f]) => [normalizeGuardHeader(h), f]));

/** True when the header reads like an amount of money (whether or not it is allowed). */
export function isMoneyLikeHeader(header: string): boolean {
  return normalizeGuardHeader(header).split(" ").some((w) => MONEY_WORDS.has(w));
}

/**
 * True when a header that passed the guard may be mapped to a money field automatically: an exact template money header,
 * or one that says the customer was charged ("charged to", "billed to", or "customer" beside charge, amount, fee, price or total).
 */
export function isAutoMappableMoneyHeader(header: string): boolean {
  if (!guardHeader(header).allowed) return false;
  const n = normalizeGuardHeader(header);
  if (TEMPLATE_MONEY_NORMALIZED.has(n)) return true;
  if (/\b(charged|billed) to\b/.test(n)) return true;
  const words = n.split(" ");
  return words.includes("customer") && words.some((w) => CUSTOMER_MONEY_WORDS.has(w));
}

/**
 * Which money field an auto-mappable header is, when its words say so ("customer charge original", "corrected charge to
 * customer", "customer adjustment fee"). A header like "Customer Charge" or "Charged to Customer" is customer-facing but could
 * be the original charge, the corrected charge or the fee: null, and the 3PL chooses.
 */
export function moneyFieldOfHeader(header: string): MoneyField | null {
  if (!isAutoMappableMoneyHeader(header)) return null;
  const n = normalizeGuardHeader(header);
  const exact = TEMPLATE_MONEY_NORMALIZED.get(n);
  if (exact) return exact;
  const words = new Set(n.split(" "));
  if (words.has("fee") || words.has("fees")) return "adjustmentFee";
  if (["original", "declared", "before"].some((w) => words.has(w))) return "originalCharge";
  if (["corrected", "adjusted", "revised", "after"].some((w) => words.has(w))) return "correctedCharge";
  return null;
}
