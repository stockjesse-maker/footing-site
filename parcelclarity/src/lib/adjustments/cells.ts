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

/**
 * A package reference as the file wrote it: the apostrophe or ="..." wrapper spreadsheets use to keep a long number as text is removed.
 * { ref: null } for a blank cell; "invalid" for scientific notation or a reference over 120 characters.
 */
export function readPackageRef(raw: string): { ref: string | null } | "invalid" {
  let t = raw.trim();
  const wrapped = /^=\s*"(.*)"$/s.exec(t);
  if (wrapped) t = wrapped[1]!;
  else if (t.startsWith("'")) t = t.slice(1);
  const { text } = cleanText(t, 100_000);
  if (text === null) return { ref: null };
  if (SCIENTIFIC.test(text) || [...text].length > 120) return "invalid";
  return { ref: text };
}

/** The key under which a text is looked up in a value map: lower case, every run of non-alphanumerics one space. */
export const normalizeValue = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** A date cell as written, or null for a blank one, or "invalid". Reuses the orders importer's reader (no time-zone shifting). */
export function readDateCell(raw: string, format: "iso" | "mdy" | "dmy"): string | null | "invalid" {
  return parseOrderDate(raw, format);
}

/** The database refuses ship dates before 2015 and after tomorrow (tomorrow is allowed for time zones). */
export function shipDateInRange(iso: string, today: string): boolean {
  return iso >= EARLIEST_SHIP_DATE && iso <= addDays(today, 1);
}

/** Month-first or day-first: decided only when some value has a component above 12. */
export function detectDateFormat(cells: string[]): { format: "iso" | "mdy" | "dmy"; ambiguous: boolean } {
  let sawNumeric = false;
  for (const raw of cells) {
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
  let minus = 0;
  const paren = /^\((.*)\)$/s.exec(t);
  if (paren) {
    minus++;
    t = paren[1]!.trim();
  }
  const lead = /^(?:[\s$-]|usd)*/i.exec(t)![0];
  const trail = /(?:[\s-]|usd)*$/i.exec(t.slice(lead.length))![0];
  const body = t.slice(lead.length, t.length - trail.length);
  minus += (lead.match(/-/g) ?? []).length + (trail.match(/-/g) ?? []).length;
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

/** Adds two optional two-decimal amounts: unknown plus unknown stays unknown; unknown plus a value is that value. */
export function addMoney(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return new D(a).plus(b).toFixed(2);
}

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
  const lb = weightToLb(w.value, unit);
  if (lb.greaterThanOrEqualTo(MAX_WEIGHT_LB)) return { status: "invalid" };
  const text = decimalText(lb, 6);
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
  if (inches.greaterThanOrEqualTo(MAX_DIMENSION_IN)) return { status: "invalid" };
  const text = decimalText(inches, 4);
  if (!/[1-9]/.test(text)) return { status: "invalid" };
  return { status: "ok", inches: text };
}
