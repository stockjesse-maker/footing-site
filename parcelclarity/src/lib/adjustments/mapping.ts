import type { Table } from "../import/parse-table";
import { suggestService, type ServiceCatalogEntry } from "../import/rate-card-mapping";
import { cleanText, detectDateFormat, enumValue, normalizeValue } from "./cells";
import { NO_HEADER_ROW_MESSAGE } from "./copy";
import { classifyHeader, flaggedMappingMessage, guardHeader, normalizeGuardHeader, refusalMessage, type HeaderInfo } from "./header-guard";
import { jsonbSizeEstimate } from "./jsonb-size";
import { detectHeaderRow, isBlankRow, sheetHeaders } from "./sheet";
import { SYNONYMS, type PlainField } from "./synonyms";
import {
  ADJUSTMENT_CAUSES,
  ADJUSTMENT_FIELDS,
  ADJUSTMENT_TYPES,
  MONEY_FIELDS,
  type AdjustmentCause,
  type AdjustmentContext,
  type AdjustmentDetection,
  type AdjustmentField,
  type AdjustmentMapping,
  type AdjustmentSheetInfo,
  type AdjustmentType,
  type BrandOption,
  type DimensionUnit,
  type DistinctValue,
  type IgnoredColumn,
  type MappingIssue,
  type MoneyField,
  type WeightUnitInFile,
} from "./types";

/**
 * Detects the layout of an uploaded history file and proposes a mapping the 3PL confirms. Heuristics only (header
 * synonyms, an exact-name look at values); nothing is decided silently: where the file cannot settle a question
 * (month-first or day-first dates, pounds or ounces, which amount column is which) the detection says so.
 *
 * Money columns are mapped automatically only when the header is an exact template header or says the customer was
 * charged (header-guard.ts). A header the guard refuses is never mapped to anything. Every other amount-like column is
 * left unmapped and listed under "Columns we will ignore".
 */

/** The stored mapping may not exceed 8 KB (as jsonb) in the database; this is the budget the library enforces on its jsonb size estimate (conservatively). */
export const MAPPING_MAX_BYTES = 7_000;
/** Distinct values listed for the value-map steps. */
const MAX_DISTINCT = 500;
/** Distinct cause (or reason) texts that get an entry of their own; the rest are stored under the default cause. */
export const MAX_CAUSE_VALUES = 50;
/** Columns listed under "Columns we will ignore" and "choose which amount this is" (the report is stored, so its lists are bounded). */
export const MAX_LISTED_COLUMNS = 50;
/** A header shown in a report is cut to this many characters. */
export const REPORTED_HEADER_CHARS = 80;
const SERVICE_CONFIDENCE = 0.75;

/** Fields in the order they claim columns. */
const PLAIN_ORDER: PlainField[] = [
  "shipDate", "adjustedOn", "carrier", "service", "brand", "adjustmentType", "cause", "reason", "packageRef", "declaredWeight", "actualWeight", "weightUnit",
  "originalLength", "originalWidth", "originalHeight", "correctedLength", "correctedWidth", "correctedHeight", "dimensionUnit", "handling",
];

const WEIGHT_FIELDS: AdjustmentField[] = ["declaredWeight", "actualWeight"];
const DIMENSION_FIELDS: AdjustmentField[] = ["originalLength", "originalWidth", "originalHeight", "correctedLength", "correctedWidth", "correctedHeight"];

const WEIGHT_UNIT_SUFFIX: [RegExp, WeightUnitInFile][] = [
  [/ (lb|lbs|pound|pounds)$/, "lb"],
  [/ (oz|ounce|ounces)$/, "oz"],
  [/ (kg|kgs|kilogram|kilograms)$/, "kg"],
  [/ (g|gram|grams)$/, "g"],
];

/** "declared weight oz" to the base "declared weight" and the unit its suffix states. */
function stripUnit(normalized: string): { base: string; weightUnit: WeightUnitInFile | null; dimensionUnit: DimensionUnit | null } {
  for (const [re, unit] of WEIGHT_UNIT_SUFFIX) if (re.test(normalized)) return { base: normalized.replace(re, ""), weightUnit: unit, dimensionUnit: null };
  const dim = /^(.*) (in|inch|inches|cm|centimeters?|centimetres?)$/.exec(normalized);
  if (dim) return { base: dim[1]!, weightUnit: null, dimensionUnit: /^c/.test(dim[2]!) ? "cm" : "in" };
  return { base: normalized, weightUnit: null, dimensionUnit: null };
}

/** The key of a service text in `serviceMap`: carrier and service together, normalised (the carrier is not repeated when the service already starts with it). */
export function serviceKeyOf(carrierText: string | null, serviceText: string): string {
  const s = normalizeValue(serviceText);
  const c = carrierText ? normalizeValue(carrierText) : "";
  if (!c || s === c || s.startsWith(`${c} `)) return s;
  return `${c} ${s}`;
}

export function suggestType(normalized: string): AdjustmentType | null {
  const asEnum = normalized.replace(/ /g, "_");
  if ((ADJUSTMENT_TYPES as readonly string[]).includes(asEnum)) return asEnum as AdjustmentType;
  const weight = /\b(re ?weigh\w*|reweight\w*|weigh\w*|weight\w*)\b/.test(normalized);
  const dims = /\b(re ?measure\w*|dimension\w*|dimensional|dim)\b/.test(normalized);
  if (/\b(both|combined|combo)\b/.test(normalized) || (weight && dims)) return "combined";
  if (dims) return "remeasure";
  if (weight) return "reweight";
  if (/\b(correction|address|other)\b/.test(normalized)) return "correction";
  return null;
}

/** A cause suggestion for a cause or reason text. An unrecognised text is "other" (a cause that is not one of the named ones), never one of the named causes. */
export function suggestCause(normalized: string): AdjustmentCause {
  const asEnum = normalized.replace(/ /g, "_");
  if ((ADJUSTMENT_CAUSES as readonly string[]).includes(asEnum)) return asEnum as AdjustmentCause;
  if (/\b(wms|no weight|missing weight|weight (was )?(missing|not sent)|did not send weight|zero weight)\b/.test(normalized)) return "wms_no_weight";
  if (/\bscale\b/.test(normalized)) return "scale_error";
  if (/\b(re ?measure\w*|dimension\w*|dimensional|dim)\b/.test(normalized)) return "carrier_remeasure";
  if (/\b(re ?weigh\w*|reweight\w*|weigh\w*|weight)\b/.test(normalized)) return "carrier_reweigh";
  if (/\b(packag\w*|box|carton)\b/.test(normalized)) return "packaging_change";
  return "other";
}

/** The carriers present in the service catalog. */
export function carriersOf(catalog: ServiceCatalogEntry[]): { code: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const s of catalog) if (!seen.has(s.carrierCode)) seen.set(s.carrierCode, s.carrierName);
  return [...seen].map(([code, name]) => ({ code, name }));
}

export function suggestCarrier(normalized: string, catalog: ServiceCatalogEntry[]): string | null {
  // An empty key (a text with no letter or digit) matches nothing: it would match any carrier whose name normalises to nothing.
  if (!normalized) return null;
  for (const c of carriersOf(catalog)) if (normalized === normalizeValue(c.code) || normalized === normalizeValue(c.name)) return c.code;
  return null;
}

/**
 * Customers are matched by exact (normalised) name only: attributing history to the wrong customer is worse than asking. An empty key (a
 * name written with no letter or digit we can read) matches nobody, however many customers' names normalise to nothing.
 */
export function suggestBrand(normalized: string, brands: BrandOption[]): string | null {
  if (!normalized) return null;
  const hits = brands.filter((b) => normalizeValue(b.name) === normalized);
  return hits.length === 1 ? hits[0]!.id : null;
}

function emptyColumns(): Record<AdjustmentField, number | null> {
  return Object.fromEntries(ADJUSTMENT_FIELDS.map((f) => [f, null])) as Record<AdjustmentField, number | null>;
}

export function emptyMapping(sheet: string, headerRow = 0): AdjustmentMapping {
  return {
    v: 1,
    sheet,
    headerRow,
    columns: emptyColumns(),
    dateFormat: "iso",
    weightUnit: "lb",
    dimensionUnit: "in",
    duplicateHandling: "refuse",
    defaults: { adjustmentType: null, cause: "other", brandId: null },
    typeMap: {},
    causeMap: {},
    carrierMap: {},
    serviceMap: {},
    brandMap: {},
  };
}

/** Counts the non-blank values of a column, keyed by normalised text, keeping the first spelling seen. A text with no letter or digit has no key and is not listed. */
function countDistinct(rows: string[][], index: number | null): Map<string, { text: string; rows: number }> {
  const out = new Map<string, { text: string; rows: number }>();
  if (index === null) return out;
  for (const r of rows) {
    const raw = (r[index] ?? "").trim();
    if (!raw) continue;
    const key = normalizeValue(raw);
    if (!key) continue;
    const e = out.get(key) ?? { text: cleanText(raw, 120).text ?? raw, rows: 0 };
    e.rows++;
    out.set(key, e);
  }
  return out;
}

const byRowsThenText = (a: DistinctValue, b: DistinctValue) => b.rows - a.rows || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0);

function toDistinct(map: Map<string, { text: string; rows: number }>, suggest: (normalized: string, text: string) => string | null, limit = MAX_DISTINCT): DistinctValue[] {
  return [...map]
    .map(([normalized, e]) => ({ text: e.text, normalized, rows: e.rows, suggested: suggest(normalized, e.text) }))
    .sort(byRowsThenText)
    .slice(0, limit);
}

/** A header as a report shows it: no control characters, at most 80 characters. */
export const reportedHeader = (header: string): string => cleanText(header, REPORTED_HEADER_CHARS).text ?? "";

/** The "Columns we will ignore" list: money-like columns first (they are the ones worth a look), then the rest, in file order, at most 50, headers cleaned and cut. */
export function listIgnoredColumns(candidates: { index: number; header: string; moneyLike: boolean }[]): IgnoredColumn[] {
  const ordered = [...candidates.filter((c) => c.moneyLike), ...candidates.filter((c) => !c.moneyLike)];
  return ordered.slice(0, MAX_LISTED_COLUMNS).map((c) => ({ index: c.index, header: reportedHeader(c.header), moneyLike: c.moneyLike }));
}

export function detectAdjustmentFile(tables: Table[], ctx: Pick<AdjustmentContext, "catalog" | "brands">, sheetName?: string): AdjustmentDetection {
  const sheets: AdjustmentSheetInfo[] = tables.map((t) => {
    const { headerRow, headers, recognised } = sheetHeaders(t);
    let rowCount = 0;
    if (recognised) for (let r = headerRow + 1; r < t.rows.length; r++) if (!isBlankRow(t.rows[r]!)) rowCount++;
    return { name: t.name, headerRow, headers, rowCount, recognised };
  });
  // The sheet asked for, else the first one with column names we can find (a workbook may start with a notes sheet).
  const named = sheetName === undefined ? -1 : tables.findIndex((t) => t.name === sheetName);
  const chosen = named >= 0 ? named : Math.max(0, sheets.findIndex((s) => s.recognised));
  const table = tables[chosen];
  const sheet = sheets[chosen];
  const noRows = (note: string): AdjustmentDetection => ({
    sheets,
    suggestion: emptyMapping(table?.name ?? "Sheet1"),
    dateFormatAmbiguous: false,
    weightUnitFromHeader: null,
    weightUnitMustBeChosen: false,
    distinct: { types: [], causes: [], carriers: [], services: [], customers: [] },
    ignoredColumns: [],
    amountColumnsNeedingChoice: [],
    notes: [note],
  });
  if (!table || !sheet) return noRows("The file has no rows.");
  if (!sheet.recognised) return noRows(NO_HEADER_ROW_MESSAGE);

  const headers = sheet.headers;
  // One pass per header: the normalisation and the guard run once, whatever the number of fields that look at it.
  const infos: HeaderInfo[] = headers.map((h) => classifyHeader(h));
  const normalized = infos.map((i) => i.normalized);
  const mapping = emptyMapping(table.name, sheet.headerRow);
  const used = new Set<number>();
  const notes: string[] = [];
  let weightUnitFromHeader: WeightUnitInFile | null = null;
  let dimensionUnitFromHeader: DimensionUnit | null = null;

  // Plain fields: exact synonyms, headers the guard refuses are never claimed, amount-like headers never go to a plain field.
  for (const field of PLAIN_ORDER) {
    const idx = infos.findIndex((info, i) => {
      if (used.has(i) || !info.allowed || info.moneyLike) return false;
      const { base } = stripUnit(info.normalized);
      return SYNONYMS[field].includes(info.normalized) || ((WEIGHT_FIELDS.includes(field) || DIMENSION_FIELDS.includes(field)) && SYNONYMS[field].includes(base));
    });
    if (idx === -1) continue;
    mapping.columns[field] = idx;
    used.add(idx);
    const unit = stripUnit(normalized[idx]!);
    if (WEIGHT_FIELDS.includes(field)) weightUnitFromHeader ??= unit.weightUnit;
    if (DIMENSION_FIELDS.includes(field)) dimensionUnitFromHeader ??= unit.dimensionUnit;
  }

  // Money fields: only customer-facing headers, and only when the header itself says which amount it is.
  const needingAll: { index: number; header: string }[] = [];
  infos.forEach((info, i) => {
    if (used.has(i) || !info.autoMappable) return;
    const field = info.moneyField;
    if (field && mapping.columns[field] === null) {
      mapping.columns[field] = i;
      used.add(i);
    } else needingAll.push({ index: i, header: headers[i]! });
  });
  const needing = new Set(needingAll.map((c) => c.index));
  const amountColumnsNeedingChoice = needingAll.slice(0, MAX_LISTED_COLUMNS).map((c) => ({ index: c.index, header: reportedHeader(c.header) }));
  const ignoredColumns = listIgnoredColumns(headers.map((h, i) => ({ index: i, header: h, moneyLike: infos[i]!.moneyLike })).filter((c) => !used.has(c.index) && !needing.has(c.index)));

  if (weightUnitFromHeader) mapping.weightUnit = weightUnitFromHeader;
  if (dimensionUnitFromHeader) mapping.dimensionUnit = dimensionUnitFromHeader;

  const dataRows = table.rows.slice(sheet.headerRow + 1).filter((r) => !isBlankRow(r));
  const cell = (r: string[], idx: number | null) => (idx === null ? "" : (r[idx] ?? "").trim());
  const dateCells = dataRows.flatMap((r) => [cell(r, mapping.columns.shipDate), cell(r, mapping.columns.adjustedOn)]).filter(Boolean).slice(0, 2000);
  const dates = detectDateFormat(dateCells);
  mapping.dateFormat = dates.format;

  const hasWeight = mapping.columns.declaredWeight !== null || mapping.columns.actualWeight !== null;
  const weightCellsStateUnit = dataRows.slice(0, 2000).some((r) => WEIGHT_FIELDS.some((f) => /[a-z]/i.test(cell(r, mapping.columns[f]))));
  const weightUnitMustBeChosen = hasWeight && mapping.columns.weightUnit === null && weightUnitFromHeader === null && !weightCellsStateUnit;

  // Value maps. The lists show every distinct value with what we would map it to; the suggested mapping keeps only the entries that
  // apply would not work out by itself (compactMapping), so a file with hundreds of customers or reasons still fits the stored mapping.
  const typeValues = toDistinct(countDistinct(dataRows, mapping.columns.adjustmentType), (n) => suggestType(n));
  const causeSource = mapping.columns.cause ?? mapping.columns.reason;
  const causeCounts = countDistinct(dataRows, causeSource);
  const causeValues = toDistinct(causeCounts, (n) => suggestCause(n), MAX_CAUSE_VALUES);
  const carrierValues = toDistinct(countDistinct(dataRows, mapping.columns.carrier), (n) => suggestCarrier(n, ctx.catalog));
  const customerValues = toDistinct(countDistinct(dataRows, mapping.columns.brand), (n) => suggestBrand(n, ctx.brands));

  // Services are keyed together with the carrier text of the row ("UPS" + "Ground" is not "FedEx" + "Ground").
  const serviceCounts = new Map<string, { text: string; rows: number; carrier: string | null }>();
  if (mapping.columns.service !== null) {
    for (const r of dataRows) {
      const text = cell(r, mapping.columns.service);
      if (!text) continue;
      const carrier = cell(r, mapping.columns.carrier) || null;
      const key = serviceKeyOf(carrier, text);
      if (!key) continue;
      const entry = serviceCounts.get(key) ?? { text: cleanText(carrier && !key.startsWith(normalizeValue(carrier)) ? `${carrier} ${text}` : text, 120).text ?? text, rows: 0, carrier };
      entry.rows++;
      serviceCounts.set(key, entry);
    }
  }
  const serviceValues: DistinctValue[] = [...serviceCounts]
    .map(([key, e]) => {
      const s = suggestService(e.text, ctx.catalog, e.carrier);
      return { text: e.text, normalized: key, rows: e.rows, suggested: s.confidence >= SERVICE_CONFIDENCE ? s.serviceId : null };
    })
    .sort(byRowsThenText)
    .slice(0, MAX_DISTINCT);

  for (const v of typeValues) mapping.typeMap[v.normalized] = v.suggested as AdjustmentType | null;
  for (const v of causeValues) mapping.causeMap[v.normalized] = (v.suggested ?? "other") as AdjustmentCause;
  for (const v of carrierValues) mapping.carrierMap[v.normalized] = v.suggested;
  for (const v of serviceValues) mapping.serviceMap[v.normalized] = v.suggested;
  for (const v of customerValues) mapping.brandMap[v.normalized] = v.suggested;
  const suggestion = compactMapping(mapping, ctx);

  if (mapping.columns.shipDate === null) notes.push("No ship date column was recognised; choose it below. Every row needs one.");
  if (mapping.columns.carrier === null && mapping.columns.service === null) notes.push("No carrier or service column was recognised; choose one. Every row needs a carrier.");
  if (mapping.columns.adjustmentType === null) notes.push("No adjustment type column was recognised; choose one type for the whole file (reweigh, remeasure, both, or another correction fee) or pick the column.");
  if (dates.ambiguous) notes.push("Dates could be month-first or day-first; confirm the format.");
  if (weightUnitMustBeChosen) notes.push("The weight columns do not state their unit; confirm pounds or ounces.");
  if (mapping.columns.originalCharge === null && mapping.columns.correctedCharge === null && mapping.columns.adjustmentFee === null) {
    notes.push("No customer charge column was recognised. Rows without amounts still count toward how often adjustments happen, but not toward how much they cost. Map a column only if it holds what the customer was charged.");
  }
  if (needingAll.length) notes.push("Some amount columns look like what the customer was charged but do not say whether they are the original charge, the corrected charge or the adjustment fee; choose below.");
  if (ignoredColumns.some((c) => c.moneyLike)) notes.push("Amount-like columns that do not say they are charged to the customer are left out. Map one by hand only if you know it is what the customer was charged, never what a carrier billed you.");
  if (causeCounts.size > MAX_CAUSE_VALUES) notes.push(`The file has ${causeCounts.size.toLocaleString("en-US")} different causes or reasons. The ${MAX_CAUSE_VALUES} most common are matched to a cause; the others are stored under the default cause.`);
  if (typeValues.length >= MAX_DISTINCT || carrierValues.length >= MAX_DISTINCT || serviceValues.length >= MAX_DISTINCT || customerValues.length >= MAX_DISTINCT) {
    notes.push("The file has very many different values, so only the most common are listed here. Values that are not listed are matched automatically or left unassigned.");
  }

  return {
    sheets,
    suggestion,
    dateFormatAmbiguous: dates.ambiguous,
    weightUnitFromHeader,
    weightUnitMustBeChosen,
    distinct: { types: typeValues, causes: causeValues, carriers: carrierValues, services: serviceValues, customers: customerValues },
    ignoredColumns,
    amountColumnsNeedingChoice,
    notes,
  };
}

// ---------------------------------------------------------------------------
// The stored form, compaction, and re-validation
// ---------------------------------------------------------------------------

/**
 * The mapping without the value-map entries that applying it works out by itself (review finding F8). A value map entry is only needed
 * where the 3PL's choice differs from what `applyAdjustmentMapping` does for a text that has no entry:
 *   - types: the text spells an adjustment type ("scale error" is not one; "reweight" is);
 *   - carriers: an exact match with a carrier's code or name, from the catalog;
 *   - customers: an exact match with exactly one customer's name;
 *   - services: none (without an entry the service stays unknown, so a null entry says nothing);
 *   - causes: the text spells a cause, and "other" when the default cause is "other" (an unmatched text is stored under the default cause).
 * The result applies identically (the entries it drops would have been recomputed to the same value), so a file with 400 customers
 * or 500 distinct reasons stores a few entries, not hundreds. It is idempotent.
 */
export function compactMapping(mapping: AdjustmentMapping, ctx: Pick<AdjustmentContext, "catalog" | "brands">): AdjustmentMapping {
  const keep = <T>(map: Record<string, T>, recomputed: (key: string) => T | null | undefined): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const [key, value] of Object.entries(map)) {
      const same = recomputed(key);
      if (same !== undefined && same === value) continue;
      out[key] = value;
    }
    return out;
  };
  return {
    ...mapping,
    typeMap: keep(mapping.typeMap, (k) => enumValue(ADJUSTMENT_TYPES, k)),
    causeMap: keep(mapping.causeMap, (k) => {
      const spelled = enumValue(ADJUSTMENT_CAUSES, k);
      if (spelled !== null) return spelled;
      return mapping.defaults.cause === "other" ? "other" : undefined;
    }),
    carrierMap: keep(mapping.carrierMap, (k) => suggestCarrier(k, ctx.catalog)),
    serviceMap: keep(mapping.serviceMap, () => null),
    brandMap: keep(mapping.brandMap, (k) => suggestBrand(k, ctx.brands)),
  };
}

/**
 * The mapping as stored in adjustment_imports.mapping: only the mapped columns, plus `fields`, which names the header each target
 * reads. The database re-runs its own forbidden-header test over `fields` (and over the detected header names), so a flagged
 * header can never be stored as mapped even if this library were bypassed. With `ctx`, the value maps are compacted (compactMapping).
 */
export type StoredAdjustmentMapping = Omit<AdjustmentMapping, "columns"> & {
  columns: Partial<Record<AdjustmentField, number>>;
  fields: Partial<Record<AdjustmentField, string>>;
};

export function toStoredMapping(mapping: AdjustmentMapping, headers: readonly string[], ctx?: Pick<AdjustmentContext, "catalog" | "brands">): StoredAdjustmentMapping {
  const columns: Partial<Record<AdjustmentField, number>> = {};
  const fields: Partial<Record<AdjustmentField, string>> = {};
  for (const f of ADJUSTMENT_FIELDS) {
    const idx = mapping.columns[f];
    if (idx === null) continue;
    columns[f] = idx;
    fields[f] = cleanText(headers[idx] ?? "", 120).text ?? "";
  }
  return { ...(ctx ? compactMapping(mapping, ctx) : mapping), columns, fields };
}

export function fromStoredMapping(stored: StoredAdjustmentMapping): AdjustmentMapping {
  const columns = emptyColumns();
  for (const f of ADJUSTMENT_FIELDS) columns[f] = stored.columns[f] ?? null;
  const { fields: _fields, ...rest } = stored;
  return { ...rest, columns };
}

/**
 * Re-validates a mapping against the file it will be applied to. Called on every save and again at commit, so a mapping
 * that was edited in the browser, or a file whose header row moved, cannot reach a money field: the mapping's header row must be the
 * row the importer reads as the column names, every header of that row is run through the guard again, and a column the guard refuses
 * can never be mapped, not even by hand.
 */
export function validateMapping(mapping: AdjustmentMapping, tables: Table[], ctx: Pick<AdjustmentContext, "catalog" | "brands">): MappingIssue[] {
  const issues: MappingIssue[] = [];
  const table = tables.find((t) => t.name === mapping.sheet);
  if (!table) return [{ code: "sheet_missing", message: "The sheet in this mapping is not in the file." }];
  const headers = table.rows[mapping.headerRow];
  if (!Number.isInteger(mapping.headerRow) || mapping.headerRow < 0 || !headers) return [{ code: "header_row_invalid", message: "The header row in this mapping is not in the sheet." }];
  // Only the row the importer finds is a header row: a mapping cannot point at a title row or at a data row (whose values would then be stored as column names).
  const found = detectHeaderRow(table.rows);
  if (found === null) return [{ code: "header_row_missing", message: NO_HEADER_ROW_MESSAGE }];
  if (found !== mapping.headerRow) return [{ code: "header_row_invalid", message: "The header row in this mapping is not the row that holds the column names." }];

  const flagged = headers.filter((h) => !guardHeader(h).allowed);
  if (flagged.length) issues.push({ code: "forbidden_header", message: refusalMessage(flagged) });

  const claimed = new Map<number, AdjustmentField>();
  for (const f of ADJUSTMENT_FIELDS) {
    const idx = mapping.columns[f];
    if (idx === null) continue;
    if (!Number.isInteger(idx) || idx < 0 || idx >= headers.length) {
      issues.push({ code: "column_out_of_range", message: "A column in this mapping is not in the sheet.", field: f });
      continue;
    }
    const header = headers[idx]!;
    if (!guardHeader(header).allowed) {
      issues.push({ code: "flagged_header_mapped", message: flaggedMappingMessage(header, MONEY_FIELDS.includes(f as MoneyField)), field: f });
    }
    const other = claimed.get(idx);
    if (other) issues.push({ code: "column_mapped_twice", message: "One column cannot be read as two different fields.", field: f });
    else claimed.set(idx, f);
  }

  if (mapping.columns.shipDate === null) issues.push({ code: "ship_date_missing", message: "Choose the ship date column; every row needs one.", field: "shipDate" });
  if (mapping.columns.carrier === null && mapping.columns.service === null) issues.push({ code: "carrier_missing", message: "Choose a carrier or a service column; every row needs a carrier.", field: "carrier" });
  if (mapping.columns.adjustmentType === null && mapping.defaults.adjustmentType === null) issues.push({ code: "type_missing", message: "Choose the adjustment type column, or one type for the whole file.", field: "adjustmentType" });

  const brandIds = new Set(ctx.brands.map((b) => b.id));
  const serviceIds = new Set(ctx.catalog.map((s) => s.id));
  const carrierCodes = new Set(carriersOf(ctx.catalog).map((c) => c.code));
  if (mapping.defaults.brandId !== null && !brandIds.has(mapping.defaults.brandId)) issues.push({ code: "unknown_customer_in_map", message: "The default customer is not one of your customers." });
  if (Object.values(mapping.brandMap).some((id) => id !== null && !brandIds.has(id))) issues.push({ code: "unknown_customer_in_map", message: "A customer in this mapping is not one of your customers." });
  if (Object.values(mapping.carrierMap).some((c) => c !== null && !carrierCodes.has(c))) issues.push({ code: "unknown_carrier_in_map", message: "A carrier in this mapping is not in the carrier list." });
  if (Object.values(mapping.serviceMap).some((id) => id !== null && !serviceIds.has(id))) issues.push({ code: "unknown_service_in_map", message: "A service in this mapping is not one of the active services." });

  if (jsonbSizeEstimate(toStoredMapping(mapping, headers, ctx)) > MAPPING_MAX_BYTES) {
    issues.push({ code: "mapping_too_large", message: "This mapping has too many customer, service, carrier or reason values that you chose by hand to save (about 60 in total). Values that match automatically are not counted. Tidy the values or split the file." });
  }
  return issues;
}

/**
 * What goes into adjustment_imports.detected: the header names of the chosen sheet and at most 20 sample rows holding ONLY the
 * mapped columns (a column we ignore never has its values stored). Never produced for a refused file. The header row is the one the
 * importer found (never a data row); rowCount counts the rows under it that are not blank.
 */
export function buildDetected(tables: Table[], mapping: AdjustmentMapping): { sheet: string; headerRow: number; rowCount: number; headers: string[]; sampleRows: Record<string, string>[] } {
  const table = tables.find((t) => t.name === mapping.sheet) ?? tables[0]!;
  const headers = table.rows[mapping.headerRow] ?? [];
  const mapped = ADJUSTMENT_FIELDS.map((f) => mapping.columns[f]).filter((i): i is number => i !== null && i >= 0 && i < headers.length && guardHeader(headers[i] ?? "").allowed);
  const below = table.rows.slice(mapping.headerRow + 1).filter((r) => !isBlankRow(r));
  const sampleRows = below.slice(0, 20).map((r) => {
    const o: Record<string, string> = {};
    for (const i of mapped) {
      const key = cleanText(headers[i] ?? "", 120).text;
      if (key && !(key in o)) o[key] = cleanText(r[i] ?? "", 120).text ?? "";
    }
    return o;
  });
  return { sheet: table.name, headerRow: mapping.headerRow, rowCount: below.length, headers: headers.slice(0, 200).map((h) => cleanText(h, 120).text ?? ""), sampleRows };
}
