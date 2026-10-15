import Decimal from "decimal.js";
import type { WeightUnitInFile } from "./types";

/**
 * Strict cell parsers for order files. Every parser returns null for an empty cell and the tag
 * "invalid" for a non-empty cell it cannot read, so the caller reports the cell instead of
 * guessing. Nothing here rounds or reinterprets a value except where the design says so (metric
 * weights → pounds at six decimals, HALF_UP).
 */

const D = Decimal.clone({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

/** A calendar date as written, with an optional time and offset that are read past, never applied. */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|UTC|[+-]\d{2}:?\d{2})?)?$/i;
/** "3/2/2026", "02-03-26", "3.2.2026", optionally followed by a time. Which number is the month is the mapping's choice. */
const NUMERIC_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AP]M)?)?$/i;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function calendarDate(year: number, month: number, day: number): string | "invalid" {
  if (month < 1 || month > 12 || day < 1) return "invalid";
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const max = month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1]!;
  if (day > max || year < 1900 || year > 2200) return "invalid";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** What a date cell looks like, for format detection: the two leading numbers of a numeric date decide month-first vs day-first. */
export function classifyDateCell(raw: string): { kind: "iso" } | { kind: "numeric"; first: number; second: number } | null {
  const t = raw.trim();
  if (ISO_DATE.test(t)) return { kind: "iso" };
  const m = NUMERIC_DATE.exec(t);
  if (m) return { kind: "numeric", first: Number(m[1]), second: Number(m[2]) };
  return null;
}

/**
 * Reads a date cell as written under the chosen format and returns "YYYY-MM-DD". ISO values are
 * unambiguous and accepted under every format; a trailing time and offset are ignored rather than
 * shifted to UTC (the calendar date the file shows is the date that is priced). Two-digit years
 * are the spreadsheet convention for 2000–2099.
 */
export function parseOrderDate(raw: string, format: "iso" | "mdy" | "dmy"): string | null | "invalid" {
  const t = raw.trim();
  if (!t) return null;
  const iso = ISO_DATE.exec(t);
  if (iso) return calendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const num = NUMERIC_DATE.exec(t);
  if (!num || format === "iso") return "invalid";
  const a = Number(num[1]);
  const b = Number(num[2]);
  const year = num[3]!.length === 2 ? 2000 + Number(num[3]) : Number(num[3]);
  return format === "mdy" ? calendarDate(year, a, b) : calendarDate(year, b, a);
}

export type ZipRead = { status: "ok"; zip: string } | { status: "empty" } | { status: "short"; digits: string } | { status: "invalid" };

/**
 * Cleans a ZIP cell the way spreadsheets mangle it (quotes, apostrophes, a leading "=" from a
 * formula, stray spaces), accepts ZIP+4, and pads 3–4 digit values only when the mapping says the
 * file lost its leading zeros. Anything else is reported, never corrected.
 */
export function parseZip(raw: string, padShortZips: boolean): ZipRead {
  const cleaned = raw.trim().replace(/^=/, "").replace(/["'`]/g, "").replace(/\s+/g, "");
  if (!cleaned) return { status: "empty" };
  const plus4 = /^(\d{3,5})(?:-(\d{4}))?$/.exec(cleaned);
  const digits = plus4 ? plus4[1]! : /^\d{9}$/.test(cleaned) ? cleaned.slice(0, 5) : null;
  if (digits === null) return { status: "invalid" };
  if (digits.length === 5) return { status: "ok", zip: digits };
  return padShortZips ? { status: "ok", zip: digits.padStart(5, "0") } : { status: "short", digits };
}

export function parseResidential(raw: string): boolean | null | "invalid" {
  const t = raw.trim().toLowerCase();
  if (!t) return null;
  if (/^(yes|y|true|1|residential|res|home)$/.test(t)) return true;
  if (/^(no|n|false|0|commercial|com|business)$/.test(t)) return false;
  return "invalid";
}

const WEIGHT_UNITS: [RegExp, WeightUnitInFile][] = [
  [/^(lb|lbs|pound|pounds)$/, "lb"],
  [/^(oz|ozs|ounce|ounces)$/, "oz"],
  [/^(g|gm|gms|gram|grams)$/, "g"],
  [/^(kg|kgs|kilo|kilos|kilogram|kilograms)$/, "kg"],
];

export function parseWeightUnitCell(raw: string): WeightUnitInFile | null | "invalid" {
  const t = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!t) return null;
  for (const [re, unit] of WEIGHT_UNITS) if (re.test(t)) return unit;
  return "invalid";
}

/** "3", "3.5 lb", "12oz", "500 g", "1,250 g" → value and the unit the cell itself states, if any. */
export function parseWeightCell(raw: string): { value: string; unit: WeightUnitInFile | null } | null | "invalid" {
  const t = raw.trim().toLowerCase().replace(/,/g, "");
  if (!t) return null;
  const m = /^(\d+(?:\.\d+)?|\.\d+)\s*([a-z]+)?\.?$/.exec(t);
  if (!m) return "invalid";
  const unit = m[2] === undefined ? null : parseWeightUnitCell(m[2]);
  if (unit === "invalid") return "invalid";
  const value = m[1]!.startsWith(".") ? `0${m[1]}` : m[1]!;
  return { value, unit };
}

const LB_PER_KG = new D("2.20462262185");

/** Pounds for any unit; metric values are converted at six decimals HALF_UP. Pounds and ounces are returned exactly. */
export function weightToLb(value: string, unit: WeightUnitInFile): Decimal {
  const v = new D(value);
  if (unit === "lb") return v;
  if (unit === "oz") return v.div(16);
  if (unit === "kg") return v.times(LB_PER_KG).toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
  return v.div(1000).times(LB_PER_KG).toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
}

/** Fixed-point text with trailing zeros removed: "2.204623", "1". */
export function decimalText(value: Decimal, maxDp = 6): string {
  return value.toDecimalPlaces(maxDp, Decimal.ROUND_HALF_UP).toFixed(maxDp).replace(/\.?0+$/, "");
}

/** A positive length in inches: "10", "10.5", "10 in", '10"'. */
export function parseDimension(raw: string): string | null | "invalid" {
  const t = raw.trim().toLowerCase().replace(/\s*(in|inch|inches|")\.?$/, "");
  if (!t) return null;
  if (!/^(\d+(?:\.\d+)?|\.\d+)$/.test(t) || !/[1-9]/.test(t)) return "invalid";
  return t.startsWith(".") ? `0${t}` : t;
}

/** Money with at most two decimals (declared value), non-negative. */
export function parseDeclaredValue(raw: string): string | null | "invalid" {
  const t = raw.trim().replace(/^\$|usd/gi, "").replace(/,/g, "").trim();
  if (!t) return null;
  return /^\d+(\.\d{1,2})?$/.test(t) ? t : "invalid";
}

/** A whole, non-negative unit count ("2", "2.0"). */
export function parseUnits(raw: string): number | null | "invalid" {
  const t = raw.trim().replace(/,/g, "");
  if (!t) return null;
  const m = /^(\d+)(?:\.0+)?$/.exec(t);
  if (!m) return "invalid";
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : "invalid";
}

export function parseCountry(raw: string): "US" | null | "other" {
  const t = raw.trim().toLowerCase().replace(/\./g, "");
  if (!t) return null;
  return /^(us|usa|united states|united states of america)$/.test(t) ? "US" : "other";
}

/** A "cancelled at" timestamp, a yes/true flag or a status reading "cancelled" marks the order as cancelled. */
export function isCancelledCell(raw: string): boolean {
  const t = raw.trim().toLowerCase();
  if (!t) return false;
  if (/^(cancelled|canceled|cancel|yes|y|true)$/.test(t)) return true;
  return classifyDateCell(t) !== null;
}

/** Shopify's "Lineitem requires shipping": false means the line is sold but nothing is shipped for it. */
export function parseRequiresShipping(raw: string): boolean | null {
  const t = raw.trim().toLowerCase();
  if (!t) return null;
  if (/^(false|no|n|0)$/.test(t)) return false;
  if (/^(true|yes|y|1)$/.test(t)) return true;
  return null;
}
