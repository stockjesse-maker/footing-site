import type {
  AdjustmentCause,
  AdjustmentDetection,
  AdjustmentField,
  AdjustmentMapping,
  AdjustmentType,
  AdjustmentValidationReport,
  CodeSummary,
  DistinctValue,
  IgnoredColumn,
  ImportCode,
  MappingIssue,
  MoneyField,
} from "@/lib/adjustments/types";
import { MONEY_FIELD_HINT, MONEY_FIELD_LABELS, type ImportStatusKey } from "@/lib/adjustments/staff-copy";

/**
 * The logic of the import wizard that is not rendering: which step a status is on, what the mapping screen groups and says, how a value
 * map reads, what still has to be chosen before the file can be checked, and how a stored report is read back. Pure (no React, no I/O).
 */
export type ImportStatus = ImportStatusKey;

/**
 * 1 Upload, 2 Map columns, 3 Check, 4 Import. The number is the step a person is ON; 5 means every step is done. An upload is always done
 * once its page exists, so the page starts at 2. A discarded or withdrawn import is on no step (0).
 */
export function stepNumber(status: ImportStatus): 0 | 2 | 3 | 4 | 5 {
  switch (status) {
    case "uploaded":
      return 2;
    case "mapped":
      return 3;
    case "validated":
    case "committing":
      return 4;
    case "committed":
      return 5;
    default:
      return 0;
  }
}

/** The mapping can be edited (and the file checked again) until the import is committed, discarded or withdrawn. */
export const isEditable = (status: ImportStatus): boolean => status === "uploaded" || status === "mapped" || status === "validated";

/** Importing is offered for a checked file, and for one whose earlier import attempt did not finish (it is rolled back and started over). */
export const canImport = (status: ImportStatus): boolean => status === "validated" || status === "committing";

/** The Import step is offered only for a checked file whose report still describes what is on screen (a mapping changed since is not offered until it is checked again). */
export const importOffered = (status: ImportStatus, report: Pick<AdjustmentValidationReport, "ok" | "committable"> | null, stale: boolean): boolean => canImport(status) && report !== null && report.ok && report.committable && !stale;

/** The step a person is on once an import has just finished in this session (every step done). */
export const stepAfterCommit = 5 as const;

export interface FieldSpec {
  field: AdjustmentField;
  label: string;
  hint?: string;
  required?: boolean;
  money?: boolean;
}

export interface FieldGroup {
  id: string;
  legend: string;
  description?: string;
  fields: FieldSpec[];
}

/** The columns of the mapping step, in groups. Money fields come last and carry the rule about what an amount must be. */
export const FIELD_GROUPS: readonly FieldGroup[] = [
  {
    id: "when",
    legend: "When and which package",
    fields: [
      { field: "shipDate", label: "Ship date", required: true },
      { field: "adjustedOn", label: "Date the adjustment posted" },
      { field: "packageRef", label: "Package reference (tracking number)", hint: "Used to avoid importing the same package twice." },
    ],
  },
  {
    id: "who",
    legend: "Carrier, service and customer",
    fields: [
      { field: "carrier", label: "Carrier", hint: "Choose a carrier or a service column; every row needs a carrier." },
      { field: "service", label: "Service" },
      { field: "brand", label: "Customer", hint: "Leave empty when the whole file is one customer's." },
    ],
  },
  {
    id: "kind",
    legend: "Kind of adjustment",
    fields: [
      { field: "adjustmentType", label: "Adjustment type", hint: "Leave empty to use one type for the whole file." },
      { field: "cause", label: "Cause" },
      { field: "reason", label: "Reason (free text)", hint: "Used to work out the cause when there is no cause column." },
      { field: "handling", label: "Who paid, if recorded", hint: "For your information only. Your decisions on the Policies tab decide who pays, not this column." },
    ],
  },
  {
    id: "weights",
    legend: "Weights",
    fields: [
      { field: "declaredWeight", label: "Weight declared at labelling" },
      { field: "actualWeight", label: "Corrected weight" },
      { field: "weightUnit", label: "Weight unit column" },
    ],
  },
  {
    id: "sizes",
    legend: "Sizes",
    fields: [
      { field: "originalLength", label: "Original length" },
      { field: "originalWidth", label: "Original width" },
      { field: "originalHeight", label: "Original height" },
      { field: "correctedLength", label: "Corrected length" },
      { field: "correctedWidth", label: "Corrected width" },
      { field: "correctedHeight", label: "Corrected height" },
      { field: "dimensionUnit", label: "Dimension unit column" },
    ],
  },
  {
    id: "money",
    legend: "What your customer was charged",
    description: "Map an amount column only if it holds what your customer was, or would be, charged. Leave a field empty if the file has no such column.",
    fields: [
      { field: "originalCharge", label: MONEY_FIELD_LABELS.originalCharge, hint: MONEY_FIELD_HINT, money: true },
      { field: "correctedCharge", label: MONEY_FIELD_LABELS.correctedCharge, hint: MONEY_FIELD_HINT, money: true },
      { field: "adjustmentFee", label: MONEY_FIELD_LABELS.adjustmentFee, hint: MONEY_FIELD_HINT, money: true },
    ],
  },
];

export const MONEY_FIELD_KEYS: readonly MoneyField[] = ["originalCharge", "correctedCharge", "adjustmentFee"];
export const fieldLabel = (field: AdjustmentField): string => FIELD_GROUPS.flatMap((g) => g.fields).find((f) => f.field === field)?.label ?? field;

/** JSON with object keys sorted at every level, so two equal mappings serialise identically whatever their key order (the stored copy comes back from jsonb reordered). */
export function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));
}

export const mappingChanged = (current: AdjustmentMapping, saved: AdjustmentMapping | null): boolean => saved === null || stable(current) !== stable(saved);

/** The first non-blank sample value of a mapped column, from the stored sample rows (they hold ONLY mapped columns, keyed by header). */
export function sampleValue(sampleRows: readonly Record<string, string>[] | undefined, header: string | undefined): string | null {
  if (!sampleRows || !header) return null;
  for (const r of sampleRows) {
    const v = r[header];
    if (typeof v === "string" && v.trim() !== "") return v.trim().slice(0, 40);
  }
  return null;
}

export const setColumn = (m: AdjustmentMapping, field: AdjustmentField, index: number | null): AdjustmentMapping => ({ ...m, columns: { ...m.columns, [field]: index } });

/** "Which amount is this column?" for a column that looks like a customer charge: it becomes the chosen money field, and no other money field keeps it. */
export function chooseAmountColumn(m: AdjustmentMapping, index: number, field: MoneyField | null): AdjustmentMapping {
  const columns = { ...m.columns };
  for (const f of MONEY_FIELD_KEYS) if (columns[f] === index) columns[f] = null;
  if (field) columns[field] = index;
  return { ...m, columns };
}

export const amountChoiceFor = (m: AdjustmentMapping, index: number): MoneyField | "" => MONEY_FIELD_KEYS.find((f) => m.columns[f] === index) ?? "";

/** Columns that two fields both claim ("One column cannot be read as two different fields."), by field. */
export function duplicateColumns(m: AdjustmentMapping, headers: readonly string[]): { header: string; fields: AdjustmentField[] }[] {
  const byIndex = new Map<number, AdjustmentField[]>();
  for (const [field, index] of Object.entries(m.columns) as [AdjustmentField, number | null][]) {
    if (index === null) continue;
    byIndex.set(index, [...(byIndex.get(index) ?? []), field]);
  }
  return [...byIndex.entries()].filter(([, fields]) => fields.length > 1).map(([index, fields]) => ({ header: headers[index] || `Column ${index + 1}`, fields }));
}

export interface Choices {
  /** The date format is ambiguous and nobody chose it yet. */
  dateUnchosen: boolean;
  /** The weights have no stated unit and nobody chose it yet. */
  unitUnchosen: boolean;
}

/** What still has to be decided before the file can be checked, as plain sentences (empty when nothing is missing). */
export function missingChoices(m: AdjustmentMapping, headers: readonly string[], c: Choices): string[] {
  const out: string[] = [];
  if (m.columns.shipDate === null) out.push("Choose the ship date column; every row needs one.");
  if (m.columns.carrier === null && m.columns.service === null) out.push("Choose a carrier or a service column; every row needs a carrier.");
  if (m.columns.adjustmentType === null && m.defaults.adjustmentType === null) out.push("Choose the adjustment type column, or one type for the whole file.");
  if (c.dateUnchosen) out.push("Choose how to read the dates.");
  if (c.unitUnchosen) out.push("Choose the unit the weights are in.");
  for (const d of duplicateColumns(m, headers)) out.push(`The column "${d.header}" is chosen for ${d.fields.map(fieldLabel).join(" and ")}. One column cannot be read as two different fields.`);
  return out;
}

/** The checkbox gates the check: the file is not checked until the person says what its charge columns hold. */
export function canCheck(a: { attested: boolean; missing: readonly string[]; pending: boolean }): boolean {
  return a.attested && a.missing.length === 0 && !a.pending;
}

// ---------------------------------------------------------------------------
// Value maps
// ---------------------------------------------------------------------------
/** What a distinct text is mapped to now: the entry the person chose, else what the detection suggested, else the fallback. (The stored mapping drops entries that match the suggestion.) */
export function mapped<T>(map: Record<string, T | null>, normalized: string, suggested: T | null, fallback: T | null = null): T | null {
  return Object.prototype.hasOwnProperty.call(map, normalized) ? (map[normalized] ?? null) : (suggested ?? fallback);
}

export interface ValueRow<T> {
  text: string;
  normalized: string;
  rows: number;
  value: T | null;
  matchedAutomatically: boolean;
}

export function valueRows<T>(values: readonly DistinctValue[], map: Record<string, T | null>, fallback: T | null = null): ValueRow<T>[] {
  return values.map((v) => ({
    text: v.text,
    normalized: v.normalized,
    rows: v.rows,
    value: mapped(map, v.normalized, v.suggested as T | null, fallback),
    matchedAutomatically: v.suggested !== null && !Object.prototype.hasOwnProperty.call(map, v.normalized),
  }));
}

export type ValueMapName = "typeMap" | "causeMap" | "carrierMap" | "serviceMap" | "brandMap";

export function setMapEntry(m: AdjustmentMapping, name: ValueMapName, normalized: string, value: string | null): AdjustmentMapping {
  return { ...m, [name]: { ...m[name], [normalized]: value } } as AdjustmentMapping;
}

export interface CatalogService {
  id: string;
  carrierCode: string;
  carrierName: string;
  name: string;
}

export interface CarrierOption {
  code: string;
  name: string;
}

export function carrierOptions(catalog: readonly CatalogService[]): CarrierOption[] {
  const seen = new Map<string, string>();
  for (const s of catalog) if (!seen.has(s.carrierCode)) seen.set(s.carrierCode, s.carrierName);
  return [...seen].map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name));
}

export const serviceLabel = (s: CatalogService): string => `${s.carrierName}: ${s.name}`;

export const TYPE_OPTIONS: readonly { value: AdjustmentType; label: string }[] = [
  { value: "reweight", label: "Reweigh" },
  { value: "remeasure", label: "Remeasure" },
  { value: "combined", label: "Both together" },
  { value: "correction", label: "Other correction fee" },
];

// ---------------------------------------------------------------------------
// The validation report, read back from storage
// ---------------------------------------------------------------------------
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonNegInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * Reads `adjustment_imports.validation` back into a report. Null unless it carries what the screen needs (the counts and the codes): a
 * discarded or withdrawn import keeps only `counts` and `byCode`, and something that is not a report is never rendered as one.
 */
export function parseStoredReport(raw: unknown): AdjustmentValidationReport | null {
  if (!isRecord(raw) || !isRecord(raw.counts) || !Array.isArray(raw.codes)) return null;
  const c = raw.counts;
  if (![c.rows, c.errorRows, c.cleanRows, c.accepted, c.merged, c.ignored, c.alreadyImported].every(nonNegInt)) return null;
  const codes: CodeSummary[] = [];
  for (const item of raw.codes) {
    if (!isRecord(item) || typeof item.code !== "string" || typeof item.message !== "string" || !nonNegInt(item.rows) || (item.severity !== "error" && item.severity !== "information")) return null;
    codes.push({ code: item.code as ImportCode, severity: item.severity, rows: item.rows, message: item.message });
  }
  const range = isRecord(raw.shipDateRange) ? raw.shipDateRange : {};
  const list = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    ok: raw.ok !== false,
    committable: raw.committable === true,
    mappingIssues: list<MappingIssue>(raw.mappingIssues),
    counts: { rows: c.rows as number, errorRows: c.errorRows as number, cleanRows: c.cleanRows as number, accepted: c.accepted as number, merged: c.merged as number, ignored: c.ignored as number, alreadyImported: c.alreadyImported as number },
    byCode: (isRecord(raw.byCode) ? raw.byCode : {}) as AdjustmentValidationReport["byCode"],
    codes,
    rowNumbers: (isRecord(raw.rowNumbers) ? raw.rowNumbers : {}) as AdjustmentValidationReport["rowNumbers"],
    issues: list(raw.issues),
    issuesTruncated: raw.issuesTruncated === true,
    shipDateRange: { min: typeof range.min === "string" ? range.min : null, max: typeof range.max === "string" ? range.max : null },
    byType: (isRecord(raw.byType) ? raw.byType : {}) as AdjustmentValidationReport["byType"],
    byCarrier: (isRecord(raw.byCarrier) ? raw.byCarrier : {}) as AdjustmentValidationReport["byCarrier"],
    customers: list(raw.customers),
    unassignedRows: nonNegInt(raw.unassignedRows) ? raw.unassignedRows : 0,
    ignoredColumns: list<IgnoredColumn>(raw.ignoredColumns),
    notice: typeof raw.notice === "string" ? raw.notice : "",
    limits: typeof raw.limits === "string" ? raw.limits : "",
  };
}

/** Errors first, then information, each in the order the report lists them. */
export function splitCodes(report: Pick<AdjustmentValidationReport, "codes">): { errors: CodeSummary[]; information: CodeSummary[] } {
  return { errors: report.codes.filter((c) => c.severity === "error"), information: report.codes.filter((c) => c.severity === "information") };
}

export const causeOrDefault = (c: AdjustmentCause | null | undefined): AdjustmentCause => c ?? "other";

/** What the Import step confirms: how many rows, which ship dates, and that Withdraw exists. Counts come from the report that was checked. */
export function commitSummary(report: Pick<AdjustmentValidationReport, "counts" | "shipDateRange">): { rows: number; from: string | null; to: string | null; skipped: number } {
  return { rows: report.counts.accepted, from: report.shipDateRange.min, to: report.shipDateRange.max, skipped: report.counts.alreadyImported };
}

export function detectionHeaders(detection: AdjustmentDetection | null, sheet: string): string[] {
  return detection?.sheets.find((s) => s.name === sheet)?.headers ?? detection?.sheets[0]?.headers ?? [];
}
