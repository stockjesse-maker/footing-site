import type { Table } from "../import/parse-table";
import { suggestService, type ServiceCatalogEntry } from "../import/rate-card-mapping";
import { cleanText, detectDateFormat, normalizeValue } from "./cells";
import { flaggedMappingMessage, guardHeader, isAutoMappableMoneyHeader, isMoneyLikeHeader, moneyFieldOfHeader, normalizeGuardHeader, refusalMessage } from "./header-guard";
import { sheetHeaders } from "./sheet";
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

/** The stored mapping may not exceed 8 KB in the database; this is the budget the library enforces (conservatively). */
export const MAPPING_MAX_BYTES = 7_000;
/** Distinct values listed for the value-map steps (the mapping cannot hold more than this many in total anyway). */
const MAX_DISTINCT = 500;
const SERVICE_CONFIDENCE = 0.75;

type PlainField = Exclude<AdjustmentField, MoneyField>;

/** Synonyms per field, normalised (lower case, non-alphanumerics to spaces). Exact matches only: a column is never guessed from a fragment. */
const SYNONYMS: Record<PlainField, string[]> = {
  shipDate: ["ship date", "shipped date", "shipped on", "date shipped", "shipment date", "shipped at", "ship dt"],
  adjustedOn: ["adjusted on", "adjustment date", "date adjusted", "adjusted date", "adjusted at", "adjustment posted", "adjustment posted date", "posted date", "correction date", "reweigh date"],
  carrier: ["carrier", "courier", "shipper", "shipping company"],
  service: ["service", "service name", "service level", "shipping method", "ship method", "shipping service", "method", "service type", "ship via"],
  brand: ["brand", "customer", "customer name", "client", "client name", "account", "account name", "merchant", "merchant name", "company"],
  adjustmentType: ["adjustment type", "type", "correction type", "adjustment kind", "adjustment category", "kind"],
  cause: ["cause", "root cause", "adjustment cause", "cause code"],
  reason: ["reason", "adjustment reason", "reason code", "reason for adjustment", "reweigh reason", "adjustment reason code"],
  packageRef: ["package ref", "package reference", "package id", "package number", "tracking number", "tracking no", "tracking id", "tracking", "parcel id", "parcel number", "pro number"],
  declaredWeight: ["declared weight", "original weight", "shipped weight", "entered weight", "weight declared", "declared wt"],
  actualWeight: ["actual weight", "corrected weight", "adjusted weight", "measured weight", "new weight", "reweigh weight", "weight actual"],
  weightUnit: ["weight unit", "weight units", "weight uom", "unit of weight"],
  originalLength: ["original length", "orig length", "declared length", "entered length", "length declared"],
  originalWidth: ["original width", "orig width", "declared width", "entered width", "width declared"],
  originalHeight: ["original height", "orig height", "declared height", "entered height", "height declared"],
  correctedLength: ["corrected length", "adjusted length", "new length", "actual length", "remeasured length"],
  correctedWidth: ["corrected width", "adjusted width", "new width", "actual width", "remeasured width"],
  correctedHeight: ["corrected height", "adjusted height", "new height", "actual height", "remeasured height"],
  dimensionUnit: ["dimension unit", "dimensions unit", "dim unit", "dimension uom", "unit of dimension"],
  handling: ["handling", "handling recorded", "who paid", "absorbed"],
};

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
  for (const c of carriersOf(catalog)) if (normalized === normalizeValue(c.code) || normalized === normalizeValue(c.name)) return c.code;
  return null;
}

/** Customers are matched by exact (normalised) name only: attributing history to the wrong customer is worse than asking. */
export function suggestBrand(normalized: string, brands: BrandOption[]): string | null {
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

/** Counts the non-blank values of a column, keyed by normalised text, keeping the first spelling seen. */
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

function toDistinct(map: Map<string, { text: string; rows: number }>, suggest: (normalized: string, text: string) => string | null): DistinctValue[] {
  return [...map]
    .map(([normalized, e]) => ({ text: e.text, normalized, rows: e.rows, suggested: suggest(normalized, e.text) }))
    .sort(byRowsThenText)
    .slice(0, MAX_DISTINCT);
}

export function detectAdjustmentFile(tables: Table[], ctx: Pick<AdjustmentContext, "catalog" | "brands">, sheetName?: string): AdjustmentDetection {
  const sheets: AdjustmentSheetInfo[] = tables.map((t) => {
    const { headerRow, headers } = sheetHeaders(t);
    return { name: t.name, headerRow, headers, rowCount: Math.max(0, t.rows.length - headerRow - 1) };
  });
  const chosen = Math.max(0, tables.findIndex((t) => t.name === sheetName));
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

  const headers = sheet.headers;
  const normalized = headers.map(normalizeGuardHeader);
  const mapping = emptyMapping(table.name, sheet.headerRow);
  const used = new Set<number>();
  const notes: string[] = [];
  let weightUnitFromHeader: WeightUnitInFile | null = null;
  let dimensionUnitFromHeader: DimensionUnit | null = null;

  // Plain fields: exact synonyms, headers the guard refuses are never claimed, amount-like headers never go to a plain field.
  for (const field of PLAIN_ORDER) {
    const idx = headers.findIndex((h, i) => {
      if (used.has(i) || !guardHeader(h).allowed || isMoneyLikeHeader(h)) return false;
      const { base } = stripUnit(normalized[i]!);
      return SYNONYMS[field].includes(normalized[i]!) || ((WEIGHT_FIELDS.includes(field) || DIMENSION_FIELDS.includes(field)) && SYNONYMS[field].includes(base));
    });
    if (idx === -1) continue;
    mapping.columns[field] = idx;
    used.add(idx);
    const unit = stripUnit(normalized[idx]!);
    if (WEIGHT_FIELDS.includes(field)) weightUnitFromHeader ??= unit.weightUnit;
    if (DIMENSION_FIELDS.includes(field)) dimensionUnitFromHeader ??= unit.dimensionUnit;
  }

  // Money fields: only customer-facing headers, and only when the header itself says which amount it is.
  const amountColumnsNeedingChoice: { index: number; header: string }[] = [];
  headers.forEach((h, i) => {
    if (used.has(i) || !isAutoMappableMoneyHeader(h)) return;
    const field = moneyFieldOfHeader(h);
    if (field && mapping.columns[field] === null) {
      mapping.columns[field] = i;
      used.add(i);
    } else amountColumnsNeedingChoice.push({ index: i, header: h });
  });
  const needing = new Set(amountColumnsNeedingChoice.map((c) => c.index));
  const ignoredColumns: IgnoredColumn[] = headers
    .map((h, i) => ({ index: i, header: h, moneyLike: isMoneyLikeHeader(h) }))
    .filter((c) => !used.has(c.index) && !needing.has(c.index));

  if (weightUnitFromHeader) mapping.weightUnit = weightUnitFromHeader;
  if (dimensionUnitFromHeader) mapping.dimensionUnit = dimensionUnitFromHeader;

  const dataRows = table.rows.slice(sheet.headerRow + 1);
  const cell = (r: string[], idx: number | null) => (idx === null ? "" : (r[idx] ?? "").trim());
  const dateCells = dataRows.flatMap((r) => [cell(r, mapping.columns.shipDate), cell(r, mapping.columns.adjustedOn)]).filter(Boolean).slice(0, 2000);
  const dates = detectDateFormat(dateCells);
  mapping.dateFormat = dates.format;

  const hasWeight = mapping.columns.declaredWeight !== null || mapping.columns.actualWeight !== null;
  const weightCellsStateUnit = dataRows.slice(0, 2000).some((r) => WEIGHT_FIELDS.some((f) => /[a-z]/i.test(cell(r, mapping.columns[f]))));
  const weightUnitMustBeChosen = hasWeight && mapping.columns.weightUnit === null && weightUnitFromHeader === null && !weightCellsStateUnit;

  // Value maps.
  const typeValues = toDistinct(countDistinct(dataRows, mapping.columns.adjustmentType), (n) => suggestType(n));
  const causeSource = mapping.columns.cause ?? mapping.columns.reason;
  const causeValues = toDistinct(countDistinct(dataRows, causeSource), (n) => suggestCause(n));
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

  if (mapping.columns.shipDate === null) notes.push("No ship date column was recognised; choose it below. Every row needs one.");
  if (mapping.columns.carrier === null && mapping.columns.service === null) notes.push("No carrier or service column was recognised; choose one. Every row needs a carrier.");
  if (mapping.columns.adjustmentType === null) notes.push("No adjustment type column was recognised; choose one type for the whole file (reweigh, remeasure, both, or another correction fee) or pick the column.");
  if (dates.ambiguous) notes.push("Dates could be month-first or day-first; confirm the format.");
  if (weightUnitMustBeChosen) notes.push("The weight columns do not state their unit; confirm pounds or ounces.");
  if (mapping.columns.originalCharge === null && mapping.columns.correctedCharge === null && mapping.columns.adjustmentFee === null) {
    notes.push("No customer charge column was recognised. Rows without amounts still count toward how often adjustments happen, but not toward how much they cost. Map a column only if it holds what the customer was charged.");
  }
  if (amountColumnsNeedingChoice.length) notes.push("Some amount columns look like what the customer was charged but do not say whether they are the original charge, the corrected charge or the adjustment fee; choose below.");
  if (ignoredColumns.some((c) => c.moneyLike)) notes.push("Amount-like columns that do not say they are charged to the customer are left out. Map one by hand only if you know it is what the customer was charged, never what a carrier billed you.");
  if (typeValues.length + causeValues.length + carrierValues.length + serviceValues.length + customerValues.length >= MAX_DISTINCT) notes.push("The file has very many different values; the mapping may be too large to save. Tidy the values or split the file.");

  return {
    sheets,
    suggestion: mapping,
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
// The stored form, and re-validation
// ---------------------------------------------------------------------------

/**
 * The mapping as stored in adjustment_imports.mapping: only the mapped columns, plus `fields`, which names the header each target
 * reads. The database re-runs its own forbidden-header test over `fields` (and over the detected header names), so a flagged
 * header can never be stored as mapped even if this library were bypassed.
 */
export type StoredAdjustmentMapping = Omit<AdjustmentMapping, "columns"> & {
  columns: Partial<Record<AdjustmentField, number>>;
  fields: Partial<Record<AdjustmentField, string>>;
};

export function toStoredMapping(mapping: AdjustmentMapping, headers: readonly string[]): StoredAdjustmentMapping {
  const columns: Partial<Record<AdjustmentField, number>> = {};
  const fields: Partial<Record<AdjustmentField, string>> = {};
  for (const f of ADJUSTMENT_FIELDS) {
    const idx = mapping.columns[f];
    if (idx === null) continue;
    columns[f] = idx;
    fields[f] = cleanText(headers[idx] ?? "", 120).text ?? "";
  }
  return { ...mapping, columns, fields };
}

export function fromStoredMapping(stored: StoredAdjustmentMapping): AdjustmentMapping {
  const columns = emptyColumns();
  for (const f of ADJUSTMENT_FIELDS) columns[f] = stored.columns[f] ?? null;
  const { fields: _fields, ...rest } = stored;
  return { ...rest, columns };
}

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/**
 * Re-validates a mapping against the file it will be applied to. Called on every save and again at commit, so a mapping
 * that was edited in the browser, or a file whose header row moved, cannot reach a money field: every header of the mapping's
 * header row is run through the guard again, and a column the guard refuses can never be mapped, not even by hand.
 */
export function validateMapping(mapping: AdjustmentMapping, tables: Table[], ctx: Pick<AdjustmentContext, "catalog" | "brands">): MappingIssue[] {
  const issues: MappingIssue[] = [];
  const table = tables.find((t) => t.name === mapping.sheet);
  if (!table) return [{ code: "sheet_missing", message: "The sheet in this mapping is not in the file." }];
  const headers = table.rows[mapping.headerRow];
  if (!Number.isInteger(mapping.headerRow) || mapping.headerRow < 0 || !headers) return [{ code: "header_row_invalid", message: "The header row in this mapping is not in the sheet." }];

  const flaggedRow = headers.find((h) => !guardHeader(h).allowed);
  if (flaggedRow !== undefined) issues.push({ code: "forbidden_header", message: refusalMessage(flaggedRow) });

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

  if (utf8Bytes(JSON.stringify(toStoredMapping(mapping, headers))) > MAPPING_MAX_BYTES) {
    issues.push({ code: "mapping_too_large", message: "This mapping has too many different customer, service, carrier or reason values to save (about 100 in total). Tidy the values or split the file." });
  }
  return issues;
}

/**
 * What goes into adjustment_imports.detected: the header names of the chosen sheet and at most 20 sample rows holding ONLY the
 * mapped columns (a column we ignore never has its values stored). Never produced for a refused file.
 */
export function buildDetected(tables: Table[], mapping: AdjustmentMapping): { sheet: string; headerRow: number; rowCount: number; headers: string[]; sampleRows: Record<string, string>[] } {
  const table = tables.find((t) => t.name === mapping.sheet) ?? tables[0]!;
  const headers = table.rows[mapping.headerRow] ?? [];
  const mapped = ADJUSTMENT_FIELDS.map((f) => mapping.columns[f]).filter((i): i is number => i !== null && i >= 0 && i < headers.length && guardHeader(headers[i] ?? "").allowed);
  const sampleRows = table.rows.slice(mapping.headerRow + 1, mapping.headerRow + 21).map((r) => {
    const o: Record<string, string> = {};
    for (const i of mapped) {
      const key = cleanText(headers[i] ?? "", 120).text;
      if (key && !(key in o)) o[key] = cleanText(r[i] ?? "", 120).text ?? "";
    }
    return o;
  });
  return { sheet: table.name, headerRow: mapping.headerRow, rowCount: Math.max(0, table.rows.length - mapping.headerRow - 1), headers: headers.slice(0, 200).map((h) => cleanText(h, 120).text ?? ""), sampleRows };
}
