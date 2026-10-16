import type { Table } from "../import/parse-table";
import { addMoney, cents, cleanText, moneyFits, normalizeValue, parseMoneyCell, readDateCell, readDimension, readPackageRef, readWeight, shipDateInRange } from "./cells";
import { IMPORT_LIMITS, IMPORT_NOTICE } from "./copy";
import { isMoneyLikeHeader } from "./header-guard";
import { suggestBrand, suggestCarrier, serviceKeyOf, validateMapping } from "./mapping";
import {
  ADJUSTMENT_CAUSES,
  ADJUSTMENT_FIELDS,
  ADJUSTMENT_TYPES,
  type AdjustmentCause,
  type AdjustmentContext,
  type AdjustmentImportResult,
  type AdjustmentMapping,
  type AdjustmentRecord,
  type AdjustmentType,
  type AdjustmentValidationReport,
  type CodeSummary,
  type ErrorCode,
  type IgnoredColumn,
  type ImportCode,
  type ImportIssue,
  type InformationCode,
  type MappingIssue,
  type RecordedHandling,
  type WeightBasis,
} from "./types";

/**
 * Applies an approved mapping to a history file and reports, in plain sentences with counts, everything it could not use.
 * Pure. Nothing is invented: a cell that cannot be read makes its row an error row (the import cannot be committed until the
 * file is fixed), blank money stays unknown (null, never 0), and no report line ever contains a cell value.
 *
 * Errors (block the commit): invalid_date, non_positive_weight, invalid_weight, partial_dimensions, invalid_dimension,
 * negative_amount, invalid_amount, duplicate_reference, invalid_type, unknown_carrier, service_carrier_mismatch,
 * invalid_package_ref, example_row.
 * Information (never block): unknown_customer, no_amounts, credit_row, possible_double_count, missing_weight,
 * already_imported, merged_duplicate, ignored_duplicate, service_unmapped, cause_defaulted, handling_unreadable, reason_truncated.
 */

export { IMPORT_LIMITS, IMPORT_NOTICE };
export const ADJUSTMENT_MAX_ROWS = 20_000;

const ERROR_ORDER: ErrorCode[] = [
  "invalid_date", "non_positive_weight", "invalid_weight", "partial_dimensions", "invalid_dimension", "negative_amount", "invalid_amount", "duplicate_reference",
  "invalid_type", "unknown_carrier", "service_carrier_mismatch", "invalid_package_ref", "example_row",
];
const INFO_ORDER: InformationCode[] = [
  "unknown_customer", "no_amounts", "credit_row", "possible_double_count", "missing_weight", "already_imported", "merged_duplicate", "ignored_duplicate",
  "service_unmapped", "cause_defaulted", "handling_unreadable", "reason_truncated",
];
const ALL_CODES: ImportCode[] = [...ERROR_ORDER, ...INFO_ORDER];
const isError = (c: ImportCode): c is ErrorCode => (ERROR_ORDER as ImportCode[]).includes(c);

const n = (count: number) => count.toLocaleString("en-US");
const rows = (count: number) => `${n(count)} ${count === 1 ? "row" : "rows"}`;
const have = (count: number) => (count === 1 ? "has" : "have");
const are = (count: number) => (count === 1 ? "is" : "are");

/** One plain sentence per code, with the count. Counts are rows; none of these ever carries a cell value. */
const SENTENCES: Record<ImportCode, (count: number) => string> = {
  invalid_date: (c) => `${rows(c)} ${have(c)} a ship date that cannot be read (or is before 2015 or after tomorrow), or an adjusted-on date that cannot be read or is earlier than the ship date.`,
  non_positive_weight: (c) => `${rows(c)} ${have(c)} a weight of zero or less.`,
  invalid_weight: (c) => `${rows(c)} ${have(c)} a weight that cannot be read as a number or is too large to store (the unit must be lb, oz, g or kg).`,
  partial_dimensions: (c) => `${rows(c)} give${c === 1 ? "s" : ""} only some of the length, width and height; give all three or none.`,
  invalid_dimension: (c) => `${rows(c)} ${have(c)} a length, width or height that cannot be read as a positive number (the unit must be in or cm).`,
  negative_amount: (c) => `${rows(c)} ${have(c)} a negative amount. Amounts are what the customer was charged; a credit is a corrected charge that is lower than the original charge.`,
  invalid_amount: (c) => `${rows(c)} ${have(c)} an amount that cannot be read as dollars and cents (write 12.50, not 12,50).`,
  duplicate_reference: (c) => `${rows(c)} repeat${c === 1 ? "s" : ""} a package reference, customer, carrier and adjustment type used earlier in the file. Choose how repeats are handled (refuse, add up or keep the first), or remove them.`,
  invalid_type: (c) => `${rows(c)} ${have(c)} no adjustment type, or one that is not matched to reweigh, remeasure, both, or another correction fee.`,
  unknown_carrier: (c) => `${rows(c)} ${have(c)} no carrier, or one that is not matched to a carrier in the list.`,
  service_carrier_mismatch: (c) => `${rows(c)} ${have(c)} a service that belongs to a different carrier than the carrier on the row.`,
  invalid_package_ref: (c) => `${rows(c)} ${have(c)} a package reference that is longer than 120 characters or that a spreadsheet shortened to scientific notation (such as 9.4E+21); keep that column as text and export the file again.`,
  example_row: (c) => `${rows(c)} ${are(c)} the fictional example ${c === 1 ? "row" : "rows"} from the template. Delete ${c === 1 ? "it" : "them"} before importing.`,
  unknown_customer: (c) => `${rows(c)} name${c === 1 ? "s" : ""} a customer that is not in your account. ${c === 1 ? "It stays" : "They stay"} in your history but ${c === 1 ? "counts" : "count"} for no customer.`,
  no_amounts: (c) => `${rows(c)} ${have(c)} no amounts; ${c === 1 ? "it counts" : "they count"} toward how often adjustments happen, not toward how much they cost.`,
  credit_row: (c) => `${c === 1 ? "1 row is a credit" : `${n(c)} rows are credits`} (the corrected charge is lower than the original charge); ${c === 1 ? "it is" : "they are"} kept and shown separately, never netted against charges.`,
  possible_double_count: (c) => `${rows(c)} may count the adjustment fee twice: the corrected charge already exceeds the original charge by the fee. Enter the shipping charge without the separate fee.`,
  missing_weight: (c) => `${rows(c)} ${have(c)} no declared weight (for example the WMS sent none); ${c === 1 ? "it is" : "they are"} kept and marked as missing, never as zero.`,
  already_imported: (c) => `${rows(c)} ${are(c)} already imported from an earlier file and will be skipped.`,
  merged_duplicate: (c) => `${rows(c)} repeated an earlier package and ${c === 1 ? "was" : "were"} added into the first row for it.`,
  ignored_duplicate: (c) => `${rows(c)} repeated an earlier package and ${c === 1 ? "was" : "were"} ignored; the first row is kept.`,
  service_unmapped: (c) => `${rows(c)} ${have(c)} a service that is not matched to one of your services; the service stays unknown for ${c === 1 ? "it" : "them"}.`,
  cause_defaulted: (c) => `${rows(c)} ${have(c)} no cause, or one that is not matched; ${c === 1 ? "it is" : "they are"} stored under the default cause.`,
  handling_unreadable: (c) => `${rows(c)} ${have(c)} a handling value that is not absorbed, pass through or manual approval; it is not recorded (the policy decides handling anyway).`,
  reason_truncated: (c) => `${rows(c)} ${have(c)} a reason longer than 120 characters; the text is cut to 120 characters.`,
};

export function sentenceFor(code: ImportCode, count: number): string {
  return SENTENCES[code](count);
}

const MAX_ISSUES = 100;
const MAX_ROW_NUMBERS = 50;
const MAX_CUSTOMERS_LISTED = 50;

/** The unique key of a stored record: (customer, carrier, package reference, type). The database enforces it with a unique index. */
export function adjustmentRecordKey(brandId: string | null, carrierCode: string, packageRef: string, adjustmentType: AdjustmentType): string {
  return `${brandId ?? "-"}|${carrierCode}|${packageRef}|${adjustmentType}`;
}

function recordedHandling(raw: string): RecordedHandling | null | "invalid" {
  const t = normalizeValue(raw);
  if (!t) return null;
  if (/^(absorbed|absorb|not billed|not billed to customer)$/.test(t)) return "absorbed";
  if (/^(pass through|passed through|pass thru|passthrough|billed to customer|charged to customer)$/.test(t)) return "pass_through";
  if (/^(manual approval|manual|case by case|approval)$/.test(t)) return "manual_approval";
  return "invalid";
}

const enumValue = <T extends string>(list: readonly T[], normalized: string): T | null => (list as readonly string[]).includes(normalized.replace(/ /g, "_")) ? (normalized.replace(/ /g, "_") as T) : null;

interface Parsed {
  /** 1-based position under the header row. */
  rowNo: number;
  errors: Set<ErrorCode>;
  infos: Set<InformationCode>;
  record: AdjustmentRecord;
  key: string | null;
  validShipDate: string | null;
  brandText: string;
  /** Set when the row was folded into an earlier row (sum) or ignored (first). */
  consumed: "merged" | "ignored" | null;
}

function emptyCounts(): Record<ImportCode, number> {
  return Object.fromEntries(ALL_CODES.map((c) => [c, 0])) as Record<ImportCode, number>;
}

function failedReport(mappingIssues: MappingIssue[], ignoredColumns: IgnoredColumn[] = []): AdjustmentValidationReport {
  return {
    ok: false,
    committable: false,
    mappingIssues,
    counts: { rows: 0, errorRows: 0, cleanRows: 0, accepted: 0, merged: 0, ignored: 0, alreadyImported: 0 },
    byCode: emptyCounts(),
    codes: [],
    rowNumbers: {},
    issues: [],
    issuesTruncated: false,
    shipDateRange: { min: null, max: null },
    byType: {},
    byCarrier: {},
    customers: [],
    unassignedRows: 0,
    ignoredColumns,
    notice: IMPORT_NOTICE,
    limits: IMPORT_LIMITS,
  };
}

/** Columns the mapping does not read; money-like ones are the "Columns we will ignore". Names only, never values. */
export function ignoredColumnsOf(headers: string[], mapping: AdjustmentMapping): IgnoredColumn[] {
  const used = new Set(ADJUSTMENT_FIELDS.map((f) => mapping.columns[f]).filter((i): i is number => i !== null));
  return headers.map((h, i) => ({ index: i, header: h, moneyLike: isMoneyLikeHeader(h) })).filter((c) => !used.has(c.index));
}

export function applyAdjustmentMapping(tables: Table[], mapping: AdjustmentMapping, ctx: AdjustmentContext): AdjustmentImportResult {
  const mappingIssues = validateMapping(mapping, tables, ctx);
  if (mappingIssues.length) return { records: [], report: failedReport(mappingIssues) };
  const table = tables.find((t) => t.name === mapping.sheet)!;
  const headers = table.rows[mapping.headerRow]!;
  const ignoredColumns = ignoredColumnsOf(headers, mapping);

  const dataRows = table.rows.slice(mapping.headerRow + 1);
  const nonBlank = dataRows.reduce((count, r) => count + (r.every((x) => x === "") ? 0 : 1), 0);
  if (nonBlank === 0) return { records: [], report: failedReport([{ code: "no_rows", message: "The sheet has no data rows under the header." }], ignoredColumns) };
  if (nonBlank > ADJUSTMENT_MAX_ROWS) {
    return { records: [], report: failedReport([{ code: "too_many_rows", message: `The sheet has more than ${n(ADJUSTMENT_MAX_ROWS)} rows. Split the file by month and import each part.` }], ignoredColumns) };
  }

  const c = mapping.columns;
  const catalogById = new Map(ctx.catalog.map((s) => [s.id, s]));
  const cell = (cells: string[], idx: number | null) => (idx === null ? "" : (cells[idx] ?? "").trim());
  const causeSource = c.cause ?? c.reason;

  const parsed: Parsed[] = [];
  for (let i = 0; i < dataRows.length; i++) {
    const cells = dataRows[i]!;
    if (cells.every((x) => x === "")) continue;
    const errors = new Set<ErrorCode>();
    const infos = new Set<InformationCode>();

    // Dates.
    const sd = readDateCell(cell(cells, c.shipDate), mapping.dateFormat);
    const shipDate = sd !== null && sd !== "invalid" && shipDateInRange(sd, ctx.today) ? sd : null;
    if (shipDate === null) errors.add("invalid_date");
    const ao = readDateCell(cell(cells, c.adjustedOn), mapping.dateFormat);
    let adjustedOn: string | null = null;
    if (ao === "invalid" || (ao !== null && (!shipDateInRange(ao, ctx.today) || (shipDate !== null && ao < shipDate)))) errors.add("invalid_date");
    else adjustedOn = ao;

    // Type.
    const typeText = cell(cells, c.adjustmentType);
    let adjustmentType: AdjustmentType | null = null;
    if (typeText) {
      const key = normalizeValue(typeText);
      adjustmentType = Object.hasOwn(mapping.typeMap, key) ? (mapping.typeMap[key] ?? null) : enumValue(ADJUSTMENT_TYPES, key);
    } else adjustmentType = mapping.defaults.adjustmentType;
    if (adjustmentType === null) errors.add("invalid_type");

    // Carrier and service. A carrier text must be matched; a blank carrier comes from the matched service.
    const carrierText = cell(cells, c.carrier);
    const serviceText = cell(cells, c.service);
    let carrierCode: string | null = null;
    if (carrierText) {
      const key = normalizeValue(carrierText);
      carrierCode = Object.hasOwn(mapping.carrierMap, key) ? (mapping.carrierMap[key] ?? null) : suggestCarrier(key, ctx.catalog);
      if (carrierCode === null) errors.add("unknown_carrier");
    }
    let serviceId: string | null = null;
    if (serviceText) {
      const serviceKey = serviceKeyOf(carrierText || null, serviceText);
      serviceId = Object.hasOwn(mapping.serviceMap, serviceKey) ? (mapping.serviceMap[serviceKey] ?? null) : null;
      if (serviceId === null) infos.add("service_unmapped");
    }
    if (serviceId !== null) {
      const entry = catalogById.get(serviceId);
      if (entry) {
        if (!carrierText) carrierCode = entry.carrierCode;
        else if (carrierCode !== null && entry.carrierCode !== carrierCode) errors.add("service_carrier_mismatch");
      }
    }
    if (carrierCode === null && !errors.has("unknown_carrier")) errors.add("unknown_carrier");
    const serviceLabel = cleanText(serviceText, 160).text;

    // Customer.
    const brandText = cell(cells, c.brand);
    let brandId: string | null = null;
    if (brandText) {
      const key = normalizeValue(brandText);
      brandId = Object.hasOwn(mapping.brandMap, key) ? (mapping.brandMap[key] ?? null) : suggestBrand(key, ctx.brands);
      if (brandId === null) infos.add("unknown_customer");
    } else brandId = mapping.defaults.brandId;

    // Cause.
    const causeText = cell(cells, causeSource);
    let cause: AdjustmentCause = mapping.defaults.cause;
    if (causeText) {
      const key = normalizeValue(causeText);
      const mapped = Object.hasOwn(mapping.causeMap, key) ? mapping.causeMap[key] : enumValue(ADJUSTMENT_CAUSES, key);
      if (mapped) cause = mapped;
      else infos.add("cause_defaulted");
    } else infos.add("cause_defaulted");

    // Free text.
    const reason = cleanText(cell(cells, c.reason), 120);
    if (reason.truncated) infos.add("reason_truncated");
    const ref = readPackageRef(cell(cells, c.packageRef));
    if (ref === "invalid") errors.add("invalid_package_ref");
    const packageRef = ref === "invalid" ? null : ref.ref;

    // Weights: the row's unit column applies to both weight columns.
    const weightUnitCell = cell(cells, c.weightUnit);
    const declared = readWeight(cell(cells, c.declaredWeight), weightUnitCell, mapping.weightUnit);
    const actual = readWeight(cell(cells, c.actualWeight), weightUnitCell, mapping.weightUnit);
    for (const w of [declared, actual]) {
      if (w.status === "invalid") errors.add("invalid_weight");
      else if (w.status === "non_positive") errors.add("non_positive_weight");
    }
    if (declared.status === "blank") infos.add("missing_weight");
    const declaredWeightLb = declared.status === "ok" ? declared.lb : null;
    const declaredWeightBasis: WeightBasis = declaredWeightLb === null ? "missing" : cause === "wms_no_weight" ? "fallback" : "measured";

    // Dimensions: all three or none, on each side.
    const dimUnitCell = cell(cells, c.dimensionUnit);
    const readSet = (a: number | null, b: number | null, d: number | null) => {
      const reads = [a, b, d].map((idx) => readDimension(cell(cells, idx), dimUnitCell, mapping.dimensionUnit));
      const filled = reads.filter((r) => r.status !== "blank").length;
      if (filled !== 0 && filled !== 3) errors.add("partial_dimensions");
      if (reads.some((r) => r.status === "invalid")) errors.add("invalid_dimension");
      return reads.every((r) => r.status === "ok") ? { length: (reads[0] as { inches: string }).inches, width: (reads[1] as { inches: string }).inches, height: (reads[2] as { inches: string }).inches } : null;
    };
    const original = readSet(c.originalLength, c.originalWidth, c.originalHeight);
    const corrected = readSet(c.correctedLength, c.correctedWidth, c.correctedHeight);

    // Money: blank stays unknown; a negative or unreadable amount makes the row an error row.
    const money = (idx: number | null): string | null => {
      const m = parseMoneyCell(cell(cells, idx));
      if (m === "invalid") errors.add("invalid_amount");
      else if (m !== null && m.negative) errors.add("negative_amount");
      return m === null || m === "invalid" || m.negative ? null : m.amount;
    };
    const originalCharge = money(c.originalCharge);
    const correctedCharge = money(c.correctedCharge);
    const separateFee = money(c.adjustmentFee);

    // Handling is informational.
    const handlingRead = recordedHandling(cell(cells, c.handling));
    if (handlingRead === "invalid") infos.add("handling_unreadable");

    // The template's fictional rows must never become history.
    if ((packageRef !== null && /^example[-_ ]/i.test(packageRef)) || /fictional example row/i.test(reason.text ?? "") || /\(fictional\)\s*$/i.test(brandText)) errors.add("example_row");

    const record: AdjustmentRecord = {
      rowNo: i + 1,
      shipDate: shipDate ?? "",
      adjustedOn,
      carrierCode: carrierCode ?? "",
      serviceId,
      serviceText: serviceLabel,
      brandId,
      adjustmentType: adjustmentType ?? "reweight",
      cause,
      reasonText: reason.text,
      packageRef,
      declaredWeightLb,
      declaredWeightBasis,
      actualWeightLb: actual.status === "ok" ? actual.lb : null,
      original,
      corrected,
      originalCharge,
      correctedCharge,
      separateFee,
      handlingRecorded: handlingRead === "invalid" ? null : handlingRead,
    };
    const key = packageRef !== null && carrierCode !== null && adjustmentType !== null ? adjustmentRecordKey(brandId, carrierCode, packageRef, adjustmentType) : null;
    parsed.push({ rowNo: i + 1, errors, infos, record, key, validShipDate: shipDate, brandText, consumed: null });
  }

  // Repeats within the file: the first row holding a key keeps it.
  const holders = new Map<string, Parsed>();
  for (const r of parsed) {
    if (r.key === null) continue;
    const holder = holders.get(r.key);
    if (!holder) {
      holders.set(r.key, r);
      continue;
    }
    if (mapping.duplicateHandling === "refuse") r.errors.add("duplicate_reference");
    else if (r.errors.size === 0) {
      r.consumed = mapping.duplicateHandling === "sum" ? "merged" : "ignored";
      if (r.consumed === "merged") {
        holder.record.originalCharge = addMoney(holder.record.originalCharge, r.record.originalCharge);
        holder.record.correctedCharge = addMoney(holder.record.correctedCharge, r.record.correctedCharge);
        holder.record.separateFee = addMoney(holder.record.separateFee, r.record.separateFee);
        // Added up, the amounts may no longer fit the column: the row of the first package becomes an error row instead of failing at commit.
        if (![holder.record.originalCharge, holder.record.correctedCharge, holder.record.separateFee].every(moneyFits)) holder.errors.add("invalid_amount");
      }
    }
  }

  // Counts per code: a repeat folded into another row counts only as merged or ignored.
  const byCode = emptyCounts();
  const rowNumbers: Partial<Record<ImportCode, number[]>> = {};
  const issues: ImportIssue[] = [];
  let issuesTruncated = false;
  const note = (code: ImportCode, rowNo: number) => {
    byCode[code]++;
    const list = (rowNumbers[code] ??= []);
    if (list.length < MAX_ROW_NUMBERS) list.push(rowNo);
    if (issues.length < MAX_ISSUES) issues.push({ code, severity: isError(code) ? "error" : "information", row: rowNo });
    else issuesTruncated = true;
  };

  const records: AdjustmentRecord[] = [];
  let errorRows = 0;
  let merged = 0;
  let ignored = 0;
  let alreadyImported = 0;
  let unassignedRows = 0;
  const customers = new Map<string, { text: string; rows: number; brandId: string | null }>();
  const dates: string[] = [];
  for (const r of parsed) {
    if (r.validShipDate) dates.push(r.validShipDate);
    if (r.consumed) {
      if (r.consumed === "merged") merged++;
      else ignored++;
      note(r.consumed === "merged" ? "merged_duplicate" : "ignored_duplicate", r.rowNo);
      continue;
    }
    const rec = r.record;
    if (r.brandText) {
      const key = normalizeValue(r.brandText);
      const e = customers.get(key) ?? { text: cleanText(r.brandText, 120).text ?? r.brandText, rows: 0, brandId: rec.brandId };
      e.rows++;
      customers.set(key, e);
    } else if (rec.brandId === null) unassignedRows++;

    if (r.errors.size === 0) {
      // Facts that depend on the amounts are only stated for rows whose amounts were read.
      const { originalCharge: o, correctedCharge: k, separateFee: f } = rec;
      if (o === null && k === null && f === null) r.infos.add("no_amounts");
      if (o !== null && k !== null && cents(k).lessThan(cents(o))) r.infos.add("credit_row");
      if (o !== null && k !== null && f !== null && cents(f).greaterThan(0) && cents(k).minus(cents(o)).minus(cents(f)).abs().lessThanOrEqualTo(1)) r.infos.add("possible_double_count");
    }
    const imported = r.errors.size === 0 && r.key !== null && ctx.existingKeys?.has(r.key) === true;
    if (imported) {
      alreadyImported++;
      r.infos.add("already_imported");
    }
    if (r.errors.size) errorRows++;
    for (const code of ERROR_ORDER) if (r.errors.has(code)) note(code, r.rowNo);
    for (const code of INFO_ORDER) if (r.infos.has(code)) note(code, r.rowNo);
    if (r.errors.size === 0 && !imported) records.push(rec);
  }

  const byType: Partial<Record<AdjustmentType, number>> = {};
  const byCarrier: Record<string, number> = {};
  for (const rec of records) {
    byType[rec.adjustmentType] = (byType[rec.adjustmentType] ?? 0) + 1;
    byCarrier[rec.carrierCode] = (byCarrier[rec.carrierCode] ?? 0) + 1;
  }
  const codes: CodeSummary[] = ALL_CODES.filter((code) => byCode[code] > 0).map((code) => ({ code, severity: isError(code) ? "error" : "information", rows: byCode[code], message: sentenceFor(code, byCode[code]) }));
  const sortedDates = [...dates].sort();
  const total = parsed.length;

  return {
    records,
    report: {
      ok: true,
      committable: errorRows === 0 && records.length > 0,
      mappingIssues: [],
      counts: { rows: total, errorRows, cleanRows: total - errorRows, accepted: records.length, merged, ignored, alreadyImported },
      byCode,
      codes,
      rowNumbers,
      issues,
      issuesTruncated,
      shipDateRange: { min: sortedDates[0] ?? null, max: sortedDates[sortedDates.length - 1] ?? null },
      byType,
      byCarrier,
      customers: [...customers.values()].sort((a, b) => b.rows - a.rows || (a.text < b.text ? -1 : 1)).slice(0, MAX_CUSTOMERS_LISTED),
      unassignedRows,
      ignoredColumns,
      notice: IMPORT_NOTICE,
      limits: IMPORT_LIMITS,
    },
  };
}

const STORED_VALIDATION_MAX_BYTES = 30_000;

/**
 * The report as stored in adjustment_imports.validation (at most 32 KB in the database). The counts the database reads
 * (counts.rows, counts.accepted) are never trimmed; the row-number and issue lists are, when a pathological file needs it.
 */
export function toStoredValidation(report: AdjustmentValidationReport): AdjustmentValidationReport {
  const size = (r: AdjustmentValidationReport) => new TextEncoder().encode(JSON.stringify(r)).length;
  let out = report;
  if (size(out) > STORED_VALIDATION_MAX_BYTES) out = { ...out, issues: out.issues.slice(0, 20), issuesTruncated: true };
  if (size(out) > STORED_VALIDATION_MAX_BYTES) out = { ...out, rowNumbers: Object.fromEntries(Object.entries(out.rowNumbers).map(([k, v]) => [k, (v ?? []).slice(0, 10)])) };
  if (size(out) > STORED_VALIDATION_MAX_BYTES) out = { ...out, customers: out.customers.slice(0, 10), ignoredColumns: out.ignoredColumns.slice(0, 20) };
  return out;
}
