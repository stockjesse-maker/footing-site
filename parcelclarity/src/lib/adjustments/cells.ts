import Decimal from "decimal.js";
import { classifyDateCell, decimalText, parseOrderDate, parseWeightCell, parseWeightUnitCell, weightToLb } from "../orders/cells";
import type { DimensionUnit, WeightUnitInFile } from "./types";

/**
 * Strict cell parsers for adjustment history files. Like the orders importer's, every parser reports a
 * blank cell as blank and a cell it cannot read as invalid, so the caller counts the row instead of
 * guessing. Nothing is rounded or reinterpreted except where the design says so (metric weights to pounds
 * at six decimals, centimetres to inches at four, HALF_UP). Money is never converted to a number type:
 * it stays a two-decimal string until the database parses it.
 */

const D = Decimal.clone({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

/** The lowest ship date the database accepts. */
export const EARLIEST_SHIP_DATE = "2015-01-01";

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Control characters (a NUL would make the whole database call fail), bidirectional overrides and line separators. */
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** A half of a surrogate pair on its own (PostgreSQL's jsonb refuses it, so one such character would fail a whole chunk). */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Cleans a free-text cell: control characters and lone surrogates become spaces, runs of spaces collapse, the result is trimmed and cut to `max` characters. */
export function cleanText(raw: string, max: number): { text: string | null; truncated: boolean } {
  const t = raw.replace(UNSAFE_TEXT, " ").replace(LONE_SURROGATE, " ").replace(/\s+/g, " ").trim();
  if (!t) return { text: null, truncated: false };
  const chars = [...t];
  if (chars.length <= max) return { text: t, truncated: false };
  return { text: chars.slice(0, max).join("").trimEnd(), truncated: true };
}

/** A tracking number a spreadsheet shortened to scientific notation ("9.40011E+21"): the digits are gone, and different packages would collide. */
const SCIENTIFIC = /^\d+(\.\d+)?e[+-]?\d+$/i;

/** The longest text a weight, dimension, amount or date cell may hold before it is read at all (the longest real value is under 20 characters). */
export const MAX_VALUE_CELL_CHARS = 64;

/** The replacement character: what a decoder puts where the bytes were not valid text (a file saved in a legacy encoding). */
const REPLACEMENT_CHAR = "\ufffd";

/**
 * Whitespace and invisible format characters that never belong to a package reference: removed by the canonical form. The same set as
 * `app.canon_package_ref` (the database's one definition of "the same package"): every whitespace character that survives Unicode
 * compatibility normalisation (U+0085, U+1680, U+2028, U+2029 and the ASCII ones; the others become a plain space first) and the
 * format characters (soft hyphen, Arabic number signs, zero-width space and joiners, bidi marks, word joiner, invisible operators, byte
 * order mark, interlinear annotation, tag characters and a few others).
 */
const REF_STRIP =
  /[ \t\n\r\f\v\u0085\u1680\u2028\u2029\u00ad\u0600-\u0605\u061c\u06dd\u070f\u0890\u0891\u08e2\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb\u{110bd}\u{110cd}\u{13430}-\u{1343f}\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0001}\u{e0020}-\u{e007f}]/gu;

/**
 * The canonical form of a package reference: Unicode compatibility normalisation (NFKC), every whitespace and invisible format character
 * removed, the ASCII letters a-z upper-cased (other letters keep their case, so the answer never depends on a locale). Null for null, for a
 * text with the replacement character U+FFFD in it, and for a text with nothing left. It is the TypeScript twin of
 * `app.canon_package_ref`; tests/fixtures/adjustments/package-refs.json is the shared list of {input, canonical} pairs and
 * tests/db/adjustments-header-parity.test.ts runs both implementations over it.
 */
export function canonicalPackageRef(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw.includes(REPLACEMENT_CHAR)) return null;
  const t = raw.normalize("NFKC").replace(REF_STRIP, "");
  if (!t) return null;
  let out = "";
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    out += c >= 97 && c <= 122 ? String.fromCharCode(c - 32) : t[i]!;
  }
  return out;
}

/** The text of a spreadsheet's "keep this long number as text" wrapper: ="1Z999" or '1Z999. */
function unwrapRef(raw: string): string {
  const t = raw.trim();
  if (t.startsWith("=")) {
    const rest = t.slice(1).trimStart();
    if (rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"')) return rest.slice(1, -1);
    return t;
  }
  return t.startsWith("'") ? t.slice(1) : t;
}

/**
 * A package reference as the file wrote it, in its canonical form (see canonicalPackageRef): the apostrophe or ="..." wrapper spreadsheets use
 * to keep a long number as text is removed first. { ref: null } for a blank cell (or one with only invisible characters); "invalid" for
 * scientific notation (a spreadsheet shortened the number), a reference over 120 characters, and any text with the replacement character in it
 * (the file was not saved as UTF-8: the reference cannot be trusted).
 */
export function readPackageRef(raw: string): { ref: string | null } | "invalid" {
  if (raw.includes(REPLACEMENT_CHAR)) return "invalid";
  const { text } = cleanText(unwrapRef(raw), MAX_TEXT_SCAN);
  if (text === null) return { ref: null };
  const ref = canonicalPackageRef(text);
  if (ref === null) return { ref: null };
  if (SCIENTIFIC.test(ref) || [...ref].length > 120) return "invalid";
  return { ref };
}

/** cleanText works on at most this many characters of a cell that is read for a reference (the importer refuses longer cells before this point). */
const MAX_TEXT_SCAN = 100_000;

/** The enum member a normalised text spells ("reweight", "scale error" for "scale_error"), or null. */
export const enumValue = <T extends string>(list: readonly T[], normalized: string): T | null => ((list as readonly string[]).includes(normalized.replace(/ /g, "_")) ? (normalized.replace(/ /g, "_") as T) : null);

/**
 * The key under which a text is looked up in a value map: Unicode compatibility normalisation (NFKC), invisible format characters removed,
 * lower case, every run of anything that is not a letter, a digit or a combining mark one space. Letters of every script count, so a customer
 * written in Cyrillic or Chinese has a key; a text with no letter or digit at all has the empty key, and the lookups refuse the empty key.
 */
export const normalizeValue = (s: string): string =>
  s.normalize("NFKC").replace(/\p{Cf}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim();

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** A date cell as written, or null for a blank one, or "invalid". Reuses the orders importer's reader (no time-zone shifting). */
export function readDateCell(raw: string, format: "iso" | "mdy" | "dmy"): string | null | "invalid" {
  const t = raw.trim();
  if (t.length > MAX_VALUE_CELL_CHARS) return "invalid";
  return parseOrderDate(t, format);
}

/** The database refuses ship dates before 2015 and after tomorrow (tomorrow is allowed for time zones). */
export function shipDateInRange(iso: string, today: string): boolean {
  return iso >= EARLIEST_SHIP_DATE && iso <= addDays(today, 1);
}

/** Month-first or day-first: decided only when some value has a component above 12. */
export function detectDateFormat(cells: string[]): { format: "iso" | "mdy" | "dmy"; ambiguous: boolean } {
  let sawNumeric = false;
  for (const raw of cells) {
    if (raw.length > MAX_VALUE_CELL_CHARS) continue;
    const c = classifyDateCell(raw);
    if (!c || c.kind === "iso") continue;
    sawNumeric = true;
    if (c.first > 12) return { format: "dmy", ambiguous: false };
    if (c.second > 12) return { format: "mdy", ambiguous: false };
  }
  return sawNumeric ? { format: "mdy", ambiguous: true } : { format: "iso", ambiguous: false };
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export interface MoneyRead {
  /** The absolute value with exactly two decimals ("1234.50"). */
  amount: string;
  /** Written as a negative: "-5.00", "(3.20)", "$-5.00". Never true for zero. */
  negative: boolean;
}

/**
 * Money as a person writes it: "13.35", "$1,234.50", "(3.20)" (accounting negative), "-5.00", "USD 12". Commas are
 * accepted as thousands separators only ("1,250.00"); a decimal comma ("12,50") or a European "1.234,50" is refused,
 * never read as 12.50, because a silent 100x error is worse than an unreadable cell (the orders importer does the same).
 * More than two decimals is refused unless the extra digits are zeros or the cell is floating-point noise from a
 * spreadsheet formula ("16.610000000000003", nine or more decimals within a millionth of a cent value).
 */
export function parseMoneyCell(raw: string): MoneyRead | null | "invalid" {
  let t = raw.trim().replace(/\u2212/g, "-");
  if (!t) return null;
  // No amount is longer than this: anything longer is refused before any pattern sees it.
  if (t.length > MAX_VALUE_CELL_CHARS) return "invalid";
  let minus = 0;
  if (t.startsWith("(") && t.endsWith(")")) {
    minus++;
    t = t.slice(1, -1).trim();
  }
  // Strip what may stand in front of the number ($, minus signs, spaces, "USD") and behind it (minus signs, spaces, "USD"): two scans, no backtracking.
  let start = 0;
  while (start < t.length) {
    const ch = t[start]!;
    if (ch === "$" || ch === "-" || /\s/.test(ch)) start++;
    else if (t.slice(start, start + 3).toLowerCase() === "usd") start += 3;
    else break;
  }
  let end = t.length;
  while (end > start) {
    const ch = t[end - 1]!;
    if (ch === "-" || /\s/.test(ch)) end--;
    else if (end - 3 >= start && t.slice(end - 3, end).toLowerCase() === "usd") end -= 3;
    else break;
  }
  const body = t.slice(start, end);
  for (const ch of t.slice(0, start) + t.slice(end)) if (ch === "-") minus++;
  if (minus > 1 || !body) return "invalid";
  if (!(/^\d+(\.\d+)?$/.test(body) || /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(body) || /^\.\d+$/.test(body))) return "invalid";
  const plain = body.replace(/,/g, "");
  const [intPart = "", frac = ""] = plain.split(".");
  if (intPart.replace(/^0+(?=\d)/, "").length > 10) return "invalid";
  let value = new D(plain.startsWith(".") ? `0${plain}` : plain);
  if (frac.length > 2 && !/^0+$/.test(frac.slice(2))) {
    const rounded = value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    if (frac.length >= 9 && value.minus(rounded).abs().lessThan("0.000001")) value = rounded;
    else return "invalid";
  }
  const amount = value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  return { amount, negative: minus === 1 && amount !== "0.00" };
}

/** Cents as an exact integer-valued Decimal, for comparisons and sums. */
export const cents = (amount: string): Decimal => new D(amount).times(100);

/** The largest amount the database stores (numeric(12,2)). */
export const MAX_MONEY = "9999999999.99";
export const moneyFits = (amount: string | null): boolean => amount === null || new D(amount).lessThanOrEqualTo(MAX_MONEY);

/** Adds two-decimal amounts exactly. Both are known: the caller decides what an unknown amount means (it is never treated as zero). */
export const addMoney = (a: string, b: string): string => new D(a).plus(b).toFixed(2);

/** Subtracts two-decimal amounts exactly (a minus b). */
export const subtractMoney = (a: string, b: string): string => new D(a).minus(b).toFixed(2);

/** True when the amount is below zero (an exact comparison of cents). */
export const isNegativeMoney = (amount: string): boolean => new D(amount).isNegative() && !new D(amount).isZero();

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

export type WeightRead = { status: "blank" } | { status: "invalid" } | { status: "non_positive" } | { status: "ok"; lb: string };

/** Weights above this cannot be stored (numeric(12,6): six integer digits). */
const MAX_WEIGHT_LB = new D("1000000");

/**
 * A weight in pounds at up to six decimals. The unit is the cell's own ("3.5 lb", "8 oz"), else the row's unit
 * column, else the mapping's default. A leading minus is read as such so the row can be reported as "zero or less"
 * rather than "unreadable". Metric values are converted with the shared factors (weightToLb).
 */
export function readWeight(raw: string, unitCell: string, defaultUnit: WeightUnitInFile): WeightRead {
  let t = raw.trim();
  if (!t) return { status: "blank" };
  // No weight is longer than this: anything longer is refused before any pattern sees it.
  if (t.length > MAX_VALUE_CELL_CHARS || unitCell.length > MAX_VALUE_CELL_CHARS) return { status: "invalid" };
  let negative = false;
  if (t.startsWith("-")) {
    negative = true;
    t = t.slice(1).trim();
  }
  const w = parseWeightCell(t);
  if (w === null || w === "invalid") return { status: "invalid" };
  let unit: WeightUnitInFile;
  if (w.unit) unit = w.unit;
  else if (unitCell.trim()) {
    const u = parseWeightUnitCell(unitCell);
    if (u === "invalid" || u === null) return { status: "invalid" };
    unit = u;
  } else unit = defaultUnit;
  if (negative || !/[1-9]/.test(w.value)) return { status: "non_positive" };
  const text = decimalText(weightToLb(w.value, unit), 6);
  // The bound is tested on the ROUNDED value: 999999.9999996 lb is stored as 1000000, which the database refuses (numeric(12,6)).
  if (new D(text).greaterThanOrEqualTo(MAX_WEIGHT_LB)) return { status: "invalid" };
  if (!/[1-9]/.test(text)) return { status: "non_positive" };
  return { status: "ok", lb: text };
}

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

export type DimensionRead = { status: "blank" } | { status: "invalid" } | { status: "ok"; inches: string };

const CM_PER_INCH = new D("2.54");
const MAX_DIMENSION_IN = new D("1000000");

export function parseDimensionUnitCell(raw: string): DimensionUnit | null | "invalid" {
  const t = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!t) return null;
  if (/^(in|inch|inches|")$/.test(t)) return "in";
  if (/^(cm|centimeter|centimeters|centimetre|centimetres)$/.test(t)) return "cm";
  return "invalid";
}

/** A positive length in inches at up to four decimals: "10", "10.5 in", '10"', "25.4 cm" (converted at four decimals). */
export function readDimension(raw: string, unitCell: string, defaultUnit: DimensionUnit): DimensionRead {
  const t0 = raw.trim().toLowerCase();
  if (!t0) return { status: "blank" };
  if (t0.length > MAX_VALUE_CELL_CHARS || unitCell.length > MAX_VALUE_CELL_CHARS) return { status: "invalid" };
  const m = /^(\d+(?:\.\d+)?|\.\d+)\s*(in|inch|inches|"|cm|centimeters?|centimetres?)?\.?$/.exec(t0);
  if (!m) return { status: "invalid" };
  let unit: DimensionUnit;
  if (m[2]) unit = parseDimensionUnitCell(m[2]) as DimensionUnit;
  else if (unitCell.trim()) {
    const u = parseDimensionUnitCell(unitCell);
    if (u === "invalid" || u === null) return { status: "invalid" };
    unit = u;
  } else unit = defaultUnit;
  const n = new D(m[1]!.startsWith(".") ? `0${m[1]}` : m[1]!);
  const inches = unit === "cm" ? n.div(CM_PER_INCH) : n;
  const text = decimalText(inches, 4);
  // Tested after rounding, like the weight: 999999.99995 in is stored as 1000000, which the database refuses.
  if (new D(text).greaterThanOrEqualTo(MAX_DIMENSION_IN)) return { status: "invalid" };
  if (!/[1-9]/.test(text)) return { status: "invalid" };
  return { status: "ok", inches: text };
}
