import type { Table } from "../import/parse-table";
import { cleanText } from "./cells";
import { NOTHING_SAVED, REFUSAL_TITLE } from "./copy";
import { FOLD_WINDOW, MAX_HEADER_CHARS, codePointCountAtMost, foldHeader, hasUnreadableCharacters, isBlankHeader, normalizeFolded, normalizeGuardHeader } from "./header-text";
import { detectHeaderRow, headerCandidateRows, isHeaderLikeRow, scannedRows } from "./sheet";
import type { MoneyField } from "./types";

export { normalizeGuardHeader } from "./header-text";

/**
 * The header guard (Milestone 5, design v2 section 5 and amendment A4; hardened by review findings F1, F2, F4 and F13).
 *
 * ParcelClarity models what customers are CHARGED. A file whose columns look like carrier cost data is refused
 * before anything is stored: no uploaded_files row, no adjustment_imports row, and the refusal names the
 * headers and never echoes a cell value. The guard is a pure function over the header rows of every sheet.
 *
 * Rule for one header (tests/fixtures/adjustments/header-guard.json is the table of outcomes; the database's
 * `app.adjustment_header_forbidden` is the backstop with the same steps):
 *   1. a blank header passes; one longer than 200 characters is refused;
 *   2. fold it (header-text.ts: compatibility decomposition, invisible characters and combining marks removed, look-alike letters mapped to
 *      the Latin letter they imitate) and normalise it (split camelCase, lower-case, every run of other characters one space);
 *   3. a header equal to a template header always passes ("carrier" is a template header, "Carrier Name" is not);
 *   4. a header that still holds a letter outside the readable set after the fold (another script, a mix of scripts, the replacement
 *      character) or that normalises to nothing ("#", "$", an invisible character) is refused: a header we cannot read is a header we cannot check;
 *   5. a header is refused when it contains a whole word of the strict list (optional plural s; a number on either end of a word does not
 *      make it another word): cost, rate, postage, label, carrier, net, wholesale, negotiated, paid, invoice, buy; or one of the long stems
 *      wholesale, negotiated, postage, invoice inside a longer word ("PostageCost");
 *   6. a carrier's brand name (ups, usps, fedex, dhl, ontrac, lasership) beside an amount word (charge, fee, amount, price, total, billed)
 *      is refused unless the header says it is the customer's ("customer", "charged to", "billed to").
 * The strict list deliberately refuses "Carrier Name", "Net Weight" and "Label ID": the 3PL renames the column and the refusal says how.
 * It is a best-effort filter. No guard can prove that a number is customer-facing: the mapping step, the stored attestation and the
 * documentation say so.
 *
 * Which cells are tested: every cell of every row, among the first fifty non-blank rows of a sheet, that could be a header (sheet.ts: the first
 * row, every header-like row, and every row above the header row that reads like column names; a row under the header row is data). The
 * first row and every header-like row (the row the importer will read as the header, a second header block) get every step above; a title or
 * preamble row gets the word rules (step 5 and 6) only, as the database does for the first lines of a stored CSV file.
 *
 * Money columns are mapped automatically only by an exact template header or a header that says the customer was
 * charged (it contains "charged to" or "billed to" together with a money word or the word "customer", or the word "customer" beside
 * charge, amount, fee, price or total). Any other amount-like column is left unmapped and listed as a column we will ignore. A 3PL
 * may still map one by hand after attesting, but a header this guard refuses can never be mapped to anything.
 */

/** The headers of the downloadable template, in order. */
export const ADJUSTMENT_TEMPLATE_HEADERS = [
  "ship_date", "adjusted_on", "carrier", "service", "brand", "adjustment_type", "cause", "reason", "package_ref", "declared_weight", "actual_weight", "weight_unit",
  "original_length", "original_width", "original_height", "corrected_length", "corrected_width", "corrected_height", "dimension_unit",
  "customer_charge_original", "customer_charge_corrected", "customer_adjustment_fee", "handling",
] as const;

const TEMPLATE_NORMALIZED: ReadonlySet<string> = new Set(ADJUSTMENT_TEMPLATE_HEADERS.map(normalizeGuardHeader));

const STEMS = ["cost", "rate", "postage", "label", "carrier", "net", "wholesale", "negotiated", "paid", "invoice", "buy"] as const;
/** The strict list with its plurals, plus "invoiced" (the database backstop refuses it too). */
const FORBIDDEN_WORDS: ReadonlySet<string> = new Set([...STEMS, ...STEMS.map((s) => `${s}s`), "invoiced"]);
/** Stems unambiguous enough to refuse inside a longer unseparated word ("postagecost", "invoicenumber"). */
const LONG_STEMS = ["wholesale", "negotiated", "postage", "invoice"] as const;

/** Carriers' brand names; "fed ex", "on trac" and "laser ship" are what camelCase splitting makes of FedEx, OnTrac and LaserShip. */
const BRAND_WORDS: ReadonlySet<string> = new Set(["ups", "usps", "dhl", "fedex", "ontrac", "lasership"]);
const BRAND_PAIRS: readonly (readonly [string, string])[] = [["fed", "ex"], ["on", "trac"], ["laser", "ship"]];
/** Words that make a carrier's brand name a carrier's money column ("UPS Charge"). */
const BRAND_MONEY_WORDS: ReadonlySet<string> = new Set(["charge", "charges", "fee", "fees", "amount", "amounts", "price", "prices", "total", "totals", "billed", "billeds"]);

/** A token without the digits on either end ("cost2", "1cost"). A loop, not a pattern with repeats. */
function stripEdgeDigits(token: string): string {
  let a = 0;
  let b = token.length;
  while (a < b && token.charCodeAt(a) >= 48 && token.charCodeAt(a) <= 57) a++;
  while (b > a && token.charCodeAt(b - 1) >= 48 && token.charCodeAt(b - 1) <= 57) b--;
  return token.slice(a, b);
}

/** The token without its trailing digits ("ups2" is "ups"); null when nothing is left. */
function lettersThenDigits(token: string): string | null {
  let b = token.length;
  while (b > 0 && token.charCodeAt(b - 1) >= 48 && token.charCodeAt(b - 1) <= 57) b--;
  return b > 0 ? token.slice(0, b) : null;
}

function hasCarrierBrand(tokens: readonly string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const t = lettersThenDigits(tokens[i]!);
    if (t !== null && BRAND_WORDS.has(t)) return true;
    for (const [a, b] of BRAND_PAIRS) {
      if (tokens[i] === a && i + 1 < tokens.length && lettersThenDigits(tokens[i + 1]!) === b) return true;
    }
  }
  return false;
}

export type RefusalReason = "word" | "brand_money" | "empty" | "characters" | "encoding" | "too_long";

export interface HeaderVerdict {
  header: string;
  allowed: boolean;
  /** The word that caused a refusal (a stem, its plural, or the long stem found inside a word); null for the other reasons. */
  word: string | null;
  reason: RefusalReason | null;
}

const allowed = (header: string): HeaderVerdict => ({ header, allowed: true, word: null, reason: null });
const refused = (header: string, reason: RefusalReason, word: string | null = null): HeaderVerdict => ({ header, allowed: false, word, reason });

/** The word rules (5 and 6) on an already normalised header (only a-z, 0-9 and single spaces). */
function wordVerdict(header: string, norm: string): HeaderVerdict {
  const tokens = norm.split(" ");
  let brandMoney = false;
  for (const token of tokens) {
    // "Cost1" and "Rate_2" are still cost and rate: a number on either end of a word does not make it another word.
    const word = stripEdgeDigits(token);
    if (FORBIDDEN_WORDS.has(word)) return refused(header, "word", word);
    const inside = LONG_STEMS.find((stem) => token.includes(stem));
    if (inside) return refused(header, "word", inside);
    if (BRAND_MONEY_WORDS.has(word)) brandMoney = true;
  }
  if (brandMoney && hasCarrierBrand(tokens) && !sayCustomer(tokens)) return refused(header, "brand_money");
  return allowed(header);
}

/** True when the header says the amount is the customer's own: the word "customer", or "charged to" / "billed to". */
function sayCustomer(tokens: readonly string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "customer") return true;
    if ((tokens[i] === "charged" || tokens[i] === "billed") && tokens[i + 1] === "to") return true;
  }
  return false;
}

/** A column name, checked in full: every step of the rule. */
export function guardHeader(header: string): HeaderVerdict {
  if (isBlankHeader(header)) return allowed(header);
  if (!codePointCountAtMost(header, MAX_HEADER_CHARS)) return refused(header, "too_long");
  // A text that could not be decoded: the file was not saved as UTF-8. Stricter than the database, which refuses it as an unreadable character.
  if (header.includes("�")) return refused(header, "encoding");
  const folded = foldHeader(header);
  const norm = normalizeFolded(folded);
  if (TEMPLATE_NORMALIZED.has(norm)) return allowed(header);
  if (hasUnreadableCharacters(folded)) return refused(header, "characters");
  if (norm === "") return refused(header, "empty");
  return wordVerdict(header, norm);
}

/** A cell of a row that is not the header row but could be one (a title row, a second header block): the word rules only, like the database scan. */
export function guardCandidateCell(cell: string): HeaderVerdict {
  if (cell === "") return allowed(cell);
  const norm = normalizeGuardHeader(cell);
  if (norm === "" || TEMPLATE_NORMALIZED.has(norm)) return allowed(cell);
  return wordVerdict(cell, norm);
}

export function isTemplateHeader(header: string): boolean {
  return TEMPLATE_NORMALIZED.has(normalizeGuardHeader(header));
}

// ---------------------------------------------------------------------------
// Refusal messages
// ---------------------------------------------------------------------------
const shown = (header: string): string => cleanText(header, 80).text ?? "(blank)";

const MONEYISH = new Set(["charge", "charges", "charged", "amount", "fee", "fees", "price", "total", "cost", "costs", "rate", "rates", "postage", "paid", "billed", "buy", "net", "wholesale", "negotiated", "invoice", "invoiced"]);

/** What the 3PL can do about one refused header, from the words in its name. Never claims what the column holds. */
function renameHint(norm: string, reason: RefusalReason, word: string | null): string {
  switch (reason) {
    case "too_long":
      return `the name is longer than ${MAX_HEADER_CHARS} characters; shorten it`;
    case "empty":
      return "the name has no letters or digits; give the column a plain name, or remove it";
    case "characters":
      return "the name uses characters we cannot check; use plain letters and numbers";
    case "encoding":
      return 'the name has characters that could not be read; save the file as "CSV UTF-8" and upload again';
    case "brand_money":
      return 'the name has a carrier\'s name and an amount word; if it is what your customer was charged, say so in the name (for example "UPS charge to customer"), otherwise remove the column';
    default:
      break;
  }
  const tokens = new Set(norm.split(" ").map(stripEdgeDigits));
  const has = (...words: string[]) => words.some((w) => tokens.has(w));
  const lead = word ? `its name has the word "${word}"; ` : "";
  if (has("weight", "wt")) return `${lead}if it holds a weight, rename it "declared_weight" or "actual_weight"`;
  if (has("date", "dt", "created", "posted")) return `${lead}if it holds a date, rename it "ship_date" or "adjusted_on"`;
  if ([...tokens].some((t) => MONEYISH.has(t))) return `${lead}if it is what your customer was charged, rename it "customer_charge_original", "customer_charge_corrected" or "customer_adjustment_fee"; if it is what a carrier bills you, remove the column`;
  if (has("id", "number", "no", "ref", "reference", "tracking", "label")) return `${lead}if it holds a package or tracking number, rename it "package_ref"`;
  if (has("name", "code", "service", "method", "carrier", "carriers")) return `${lead}if it names the carrier or the service, rename it "carrier" or "service"`;
  return lead ? `${lead}rename the column so the name does not use that word, or remove it` : "rename or remove the column";
}

export interface RefusedHeader {
  header: string;
  sheet: string | null;
  reason: RefusalReason;
  word: string | null;
}

/** At most this many refused headers are listed in a message (the rest are counted). */
export const MAX_LISTED_REFUSALS = 20;

/**
 * The refusal, in one message for every refused header (up to 20), each with what to do about it. It names columns, never cell values, and it
 * does not claim what a column holds: a name like "Net Weight" is refused for its name, and the message says how to rename it.
 */
export function refusalMessage(refusals: string | readonly (string | Pick<RefusedHeader, "header" | "reason" | "word">)[]): string {
  const list = (typeof refusals === "string" ? [refusals] : refusals).map((r) => {
    if (typeof r !== "string") return r;
    const v = guardHeader(r);
    return v.allowed ? { header: r, reason: "word" as const, word: null } : { header: r, reason: v.reason!, word: v.word };
  });
  if (!list.length) return "";
  const costLike = list.some((r) => r.reason === "word" || r.reason === "brand_money");
  const items = list.slice(0, MAX_LISTED_REFUSALS).map((r) => `"${shown(r.header)}" (${renameHint(normalizeGuardHeader(r.header), r.reason, r.word)})`);
  const more = list.length > MAX_LISTED_REFUSALS ? ` and ${list.length - MAX_LISTED_REFUSALS} more` : "";
  const lead = costLike
    ? `${REFUSAL_TITLE}. ${NOTHING_SAVED} ParcelClarity only accepts what your customer was, or would be, charged, never what a carrier bills you, so ${list.length === 1 ? "a column" : "columns"} named like a carrier cost cannot be imported: `
    : `Some column names in this file cannot be accepted. ${NOTHING_SAVED} `;
  return `${lead}${items.join("; ")}${more}. Rename or remove ${list.length === 1 ? "that column" : "those columns"} and upload again.`;
}

/** The message when a header the guard refuses is chosen for a field by hand (the manual-mapping variant). */
export function flaggedMappingMessage(header: string, money: boolean): string {
  return `The column "${shown(header)}" cannot be used for ${money ? "a charge" : "this field"}: its name looks like a carrier cost column. Rename it in your file if it is not one.`;
}

// ---------------------------------------------------------------------------
// The guard over lists and sheets
// ---------------------------------------------------------------------------
export interface HeaderGuardResult {
  allowed: boolean;
  /** Every refused header in file order (first sheet first), at most 20, each as written (cleaned and shortened). */
  refusedHeaders: string[];
  /** The refused headers with why (the same at most 20). */
  refused: RefusedHeader[];
  /** How many headers were refused in all. */
  refusedCount: number;
  /** The first refused header in file order. */
  firstRefusedHeader: string | null;
  sheet: string | null;
  /** Plain sentence for the person who uploaded the file; null when the file passes. Names the headers, never a cell value. */
  message: string | null;
}

const PASS: HeaderGuardResult = { allowed: true, refusedHeaders: [], refused: [], refusedCount: 0, firstRefusedHeader: null, sheet: null, message: null };

function resultOf(found: { header: string; sheet: string | null; reason: RefusalReason; word: string | null }[]): HeaderGuardResult {
  if (!found.length) return PASS;
  const listed = found.slice(0, MAX_LISTED_REFUSALS).map((f) => ({ header: shown(f.header), sheet: f.sheet, reason: f.reason, word: f.word }));
  return {
    allowed: false,
    refusedHeaders: listed.map((f) => f.header),
    refused: listed,
    refusedCount: found.length,
    firstRefusedHeader: shown(found[0]!.header),
    sheet: found[0]!.sheet,
    message: refusalMessage(found),
  };
}

/** The guard over a list of headers (every step). Every refused header is listed, up to 20, in one message. */
export function guardHeaders(headers: readonly string[]): HeaderGuardResult {
  const found: { header: string; sheet: string | null; reason: RefusalReason; word: string | null }[] = [];
  for (const h of headers) {
    const v = guardHeader(h);
    if (!v.allowed) found.push({ header: h, sheet: null, reason: v.reason!, word: v.word });
  }
  return resultOf(found);
}

/**
 * The guard over every sheet of a workbook: every cell of every row, among the first fifty non-blank rows of the sheet, that could be a
 * header (the first row, the row read as the header, and any other row of mostly text). Every refused header of every sheet is reported
 * (the first sheet first), up to 20 in the message.
 */
export function guardTables(tables: readonly Table[]): HeaderGuardResult {
  const found: { header: string; sheet: string | null; reason: RefusalReason; word: string | null }[] = [];
  for (const t of tables) {
    const first = scannedRows(t.rows)[0];
    const seen = new Map<string, HeaderVerdict>();
    for (const r of headerCandidateRows(t.rows)) {
      const full = r === first || isHeaderLikeRow(t.rows[r]!);
      for (const cell of t.rows[r]!) {
        if (cell === "") continue;
        const memo = cell.length <= MAX_HEADER_CHARS ? `${full ? "f" : "c"}\u0000${cell}` : null;
        let v = memo === null ? undefined : seen.get(memo);
        if (!v) {
          v = full ? guardHeader(cell) : guardCandidateCell(cell.length > FOLD_WINDOW ? cell.slice(0, FOLD_WINDOW) : cell);
          if (memo !== null) seen.set(memo, v);
        }
        if (!v.allowed) found.push({ header: cell.length > 400 ? cell.slice(0, 400) : cell, sheet: t.name, reason: v.reason!, word: v.word });
      }
    }
  }
  return resultOf(found);
}

/** True when at least one sheet has a row the importer can read as the column names (a ship date and a carrier, service or type column). */
export function hasHeaderRow(tables: readonly Table[]): boolean {
  return tables.some((t) => detectHeaderRow(t.rows) !== null);
}

// ---------------------------------------------------------------------------
// Money columns
// ---------------------------------------------------------------------------

const MONEY_WORDS: ReadonlySet<string> = new Set([
  "charge", "charges", "charged", "amount", "amounts", "fee", "fees", "price", "prices", "total", "totals", "bill", "billed", "billing", "surcharge", "surcharges",
  "credit", "credits", "debit", "debits", "payment", "payments", "balance", "fare", "fares", "dollar", "dollars", "usd", "value", "refund", "refunds", "revenue", "discount", "discounts",
]);
const CUSTOMER_MONEY_WORDS: ReadonlySet<string> = new Set(["charge", "charges", "charged", "amount", "fee", "price", "total"]);
/** The money word a "charged to" / "billed to" header needs besides the word "customer": "Billed To Account" is an identifier, not an amount. */
const CHARGED_TO_MONEY_WORDS: ReadonlySet<string> = new Set(["charge", "charges", "fee", "fees", "amount", "amounts", "price", "prices", "total", "totals"]);
const TEMPLATE_MONEY_HEADERS: Readonly<Record<string, MoneyField>> = {
  customer_charge_original: "originalCharge",
  customer_charge_corrected: "correctedCharge",
  customer_adjustment_fee: "adjustmentFee",
};
const TEMPLATE_MONEY_NORMALIZED = new Map(Object.entries(TEMPLATE_MONEY_HEADERS).map(([h, f]) => [normalizeGuardHeader(h), f]));

export interface HeaderInfo {
  /** The normalised header (header-text.ts). */
  normalized: string;
  /** The guard lets the header through. */
  allowed: boolean;
  /** The header reads like an amount of money (whether or not it is allowed). */
  moneyLike: boolean;
  /** The header may be mapped to a money field automatically (allowed, and customer-facing by its words). */
  autoMappable: boolean;
  /** Which money field the words say it is, when they say. */
  moneyField: MoneyField | null;
}

/** Everything the detection needs to know about one header, from one pass (the guard and the normalisation run once). */
export function classifyHeader(header: string): HeaderInfo {
  const normalized = normalizeGuardHeader(header);
  const words = normalized.split(" ");
  const moneyLike = words.some((w) => MONEY_WORDS.has(w));
  const ok = guardHeader(header).allowed;
  let autoMappable = false;
  if (ok) {
    if (TEMPLATE_MONEY_NORMALIZED.has(normalized)) autoMappable = true;
    else {
      const customer = words.includes("customer");
      const chargedTo = words.some((w, i) => (w === "charged" || w === "billed") && words[i + 1] === "to");
      autoMappable = (customer && words.some((w) => CUSTOMER_MONEY_WORDS.has(w))) || (chargedTo && (customer || words.some((w) => CHARGED_TO_MONEY_WORDS.has(w))));
    }
  }
  let moneyField: MoneyField | null = null;
  if (autoMappable) {
    const exact = TEMPLATE_MONEY_NORMALIZED.get(normalized);
    if (exact) moneyField = exact;
    else {
      const set = new Set(words);
      if (set.has("fee") || set.has("fees")) moneyField = "adjustmentFee";
      else if (["original", "declared", "before"].some((w) => set.has(w))) moneyField = "originalCharge";
      else if (["corrected", "adjusted", "revised", "after"].some((w) => set.has(w))) moneyField = "correctedCharge";
    }
  }
  return { normalized, allowed: ok, moneyLike, autoMappable, moneyField };
}

/** True when the header reads like an amount of money (whether or not it is allowed). */
export const isMoneyLikeHeader = (header: string): boolean => classifyHeader(header).moneyLike;

/**
 * True when a header that passed the guard may be mapped to a money field automatically: an exact template money header, or one that says
 * the customer was charged: the word "customer" beside charge, amount, fee, price or total, or "charged to" / "billed to" together with
 * such a money word or the word "customer" ("Charged to Customer", "Amount Billed To Account"; not "Billed To Account", which names an account).
 */
export const isAutoMappableMoneyHeader = (header: string): boolean => classifyHeader(header).autoMappable;

/**
 * Which money field an auto-mappable header is, when its words say so ("customer charge original", "corrected charge to
 * customer", "customer adjustment fee"). A header like "Customer Charge" or "Charged to Customer" is customer-facing but could
 * be the original charge, the corrected charge or the fee: null, and the 3PL chooses.
 */
export const moneyFieldOfHeader = (header: string): MoneyField | null => classifyHeader(header).moneyField;
