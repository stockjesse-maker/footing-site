/**
 * Adjustment-history import contracts (Milestone 5, design v2 section 5). Pure: no I/O, no framework imports.
 *
 * A history file holds what each customer WAS CHARGED for a shipping correction (a reweigh, a remeasure or
 * another correction fee). Nothing in it is a carrier cost: the header guard (header-guard.ts) runs before
 * anything is stored, and no column the guard flags can ever be mapped to an amount. The mapping is what
 * the 3PL approves in the wizard; validation turns the file into records without inventing values and
 * reports every row it could not use as plain sentences with counts, never with cell values.
 */

import type { ServiceCatalogEntry } from "../import/rate-card-mapping";

export type AdjustmentType = "reweight" | "remeasure" | "combined" | "correction";
export const ADJUSTMENT_TYPES: readonly AdjustmentType[] = ["reweight", "remeasure", "combined", "correction"];

export type AdjustmentCause = "wms_no_weight" | "scale_error" | "carrier_reweigh" | "carrier_remeasure" | "packaging_change" | "other";
export const ADJUSTMENT_CAUSES: readonly AdjustmentCause[] = ["wms_no_weight", "scale_error", "carrier_reweigh", "carrier_remeasure", "packaging_change", "other"];

/** What the file says happened to the money. Informational only: forecasts always use the policy. */
export type RecordedHandling = "absorbed" | "pass_through" | "manual_approval";
export const RECORDED_HANDLINGS: readonly RecordedHandling[] = ["absorbed", "pass_through", "manual_approval"];

export type DuplicateHandling = "refuse" | "sum" | "first";
export type WeightBasis = "measured" | "fallback" | "missing";
export type WeightUnitInFile = "lb" | "oz" | "g" | "kg";
export type DimensionUnit = "in" | "cm";

/** Target fields of a history file, in the order a template lists them. */
export type AdjustmentField =
  | "shipDate"
  | "adjustedOn"
  | "carrier"
  | "service"
  | "brand"
  | "adjustmentType"
  | "cause"
  | "reason"
  | "packageRef"
  | "declaredWeight"
  | "actualWeight"
  | "weightUnit"
  | "originalLength"
  | "originalWidth"
  | "originalHeight"
  | "correctedLength"
  | "correctedWidth"
  | "correctedHeight"
  | "dimensionUnit"
  | "originalCharge"
  | "correctedCharge"
  | "adjustmentFee"
  | "handling";

export const ADJUSTMENT_FIELDS: readonly AdjustmentField[] = [
  "shipDate", "adjustedOn", "carrier", "service", "brand", "adjustmentType", "cause", "reason", "packageRef", "declaredWeight", "actualWeight", "weightUnit",
  "originalLength", "originalWidth", "originalHeight", "correctedLength", "correctedWidth", "correctedHeight", "dimensionUnit", "originalCharge", "correctedCharge", "adjustmentFee", "handling",
];

/** The three fields that hold money. A flagged header can never be mapped to one of these, not even by hand. */
export type MoneyField = "originalCharge" | "correctedCharge" | "adjustmentFee";
export const MONEY_FIELDS: readonly MoneyField[] = ["originalCharge", "correctedCharge", "adjustmentFee"];

/** The mapping the 3PL approves. Stored (compacted by toStoredMapping) in adjustment_imports.mapping, at most 8 KB. */
export interface AdjustmentMapping {
  v: 1;
  sheet: string;
  headerRow: number;
  /** Target field to 0-based column index of the header row; null = not in the file. */
  columns: Record<AdjustmentField, number | null>;
  /** Calendar dates are read as written (never shifted). */
  dateFormat: "iso" | "mdy" | "dmy";
  /** Used when neither the cell nor a unit column states one. g and kg are converted to pounds (6 decimals, HALF_UP). */
  weightUnit: WeightUnitInFile;
  dimensionUnit: DimensionUnit;
  /** What to do with a repeated (customer, carrier, package reference, type) inside one file. */
  duplicateHandling: DuplicateHandling;
  defaults: {
    /** Required when the file has no (readable) type column. */
    adjustmentType: AdjustmentType | null;
    /** Used for a blank or unlisted cause. "other" says "not one of the named causes". */
    cause: AdjustmentCause;
    /** Customer for rows with a blank customer cell (or all rows when the file has no customer column). */
    brandId: string | null;
  };
  /** Normalised type text to adjustment type; null = not matched (those rows are refused until it is). */
  typeMap: Record<string, AdjustmentType | null>;
  /** Normalised cause (or reason) text to cause. */
  causeMap: Record<string, AdjustmentCause>;
  /** Normalised carrier text to carrier code (carriers.code); null = not matched. */
  carrierMap: Record<string, string | null>;
  /** Normalised carrier+service text (see serviceKeyOf) to shipping_services.id; null = not matched (service stays unknown). */
  serviceMap: Record<string, string | null>;
  /** Normalised customer name to brand id; null = leave unassigned. */
  brandMap: Record<string, string | null>;
}

export interface BrandOption {
  id: string;
  name: string;
}

/** Everything outside the file that the validation needs. The caller loads it; the library does no I/O. */
export interface AdjustmentContext {
  catalog: ServiceCatalogEntry[];
  brands: BrandOption[];
  /** Today as YYYY-MM-DD; dates later than tomorrow are refused (the database refuses them too). The library never reads the clock. */
  today: string;
  /** Keys (adjustmentRecordKey) of records already stored by earlier imports: those rows are skipped and counted "already imported". */
  existingKeys?: ReadonlySet<string>;
}

/** One distinct text in the file with how often it occurs and what we would map it to. */
export interface DistinctValue {
  text: string;
  normalized: string;
  rows: number;
  suggested: string | null;
}

export interface IgnoredColumn {
  index: number;
  header: string;
  /** True when the header reads like an amount (so it is listed under "Columns we will ignore"). */
  moneyLike: boolean;
}

export interface AdjustmentSheetInfo {
  name: string;
  /** The row that holds the column names (0-based); 0 for a sheet where none was found. */
  headerRow: number;
  /** The column names; empty for a sheet where none was found (a data row is never read as column names). */
  headers: string[];
  /** Non-blank rows under the column names. */
  rowCount: number;
  /** False when no row among the first fifty holds a ship date and a carrier, service or type column: the sheet cannot be imported. */
  recognised: boolean;
}

export interface AdjustmentDetection {
  sheets: AdjustmentSheetInfo[];
  /** Mapping proposed for the chosen sheet (the first one unless a sheet name was given). */
  suggestion: AdjustmentMapping;
  dateFormatAmbiguous: boolean;
  /** The unit a weight header names ("Declared Weight (oz)"), if any. */
  weightUnitFromHeader: WeightUnitInFile | null;
  /** True when a weight column exists but nothing in the file states its unit: the 3PL must choose pounds or ounces. */
  weightUnitMustBeChosen: boolean;
  distinct: { types: DistinctValue[]; causes: DistinctValue[]; carriers: DistinctValue[]; services: DistinctValue[]; customers: DistinctValue[] };
  /** Columns the suggestion does not read. Money-like ones are the "Columns we will ignore". */
  ignoredColumns: IgnoredColumn[];
  /** Amount columns that passed the guard and look customer-facing but whose role (original, corrected or fee) is not clear. */
  amountColumnsNeedingChoice: { index: number; header: string }[];
  notes: string[];
}

/** Validation codes. Errors block the commit; information never does. */
export type ErrorCode =
  | "invalid_date"
  | "non_positive_weight"
  | "invalid_weight"
  | "partial_dimensions"
  | "invalid_dimension"
  | "negative_amount"
  | "invalid_amount"
  | "duplicate_reference"
  | "invalid_type"
  | "unknown_carrier"
  | "service_carrier_mismatch"
  | "invalid_package_ref"
  | "ragged_row"
  | "example_row";

export type InformationCode =
  | "unknown_customer"
  | "no_amounts"
  | "credit_row"
  | "possible_double_count"
  | "missing_weight"
  | "already_imported"
  | "merged_duplicate"
  | "merged_amounts_unknown"
  | "ignored_duplicate"
  | "short_row"
  | "service_unmapped"
  | "cause_defaulted"
  | "handling_unreadable"
  | "reason_truncated";

export type ImportCode = ErrorCode | InformationCode;

export interface MappingIssue {
  code: string;
  message: string;
  field?: AdjustmentField;
}

export interface ImportIssue {
  code: ImportCode;
  severity: "error" | "information";
  /** 1-based data row: row 1 is the first row under the column names that is not blank (blank lines are not counted; ROW_NUMBERING_NOTE says so). */
  row: number;
}

export interface CodeSummary {
  code: ImportCode;
  severity: "error" | "information";
  rows: number;
  /** One plain sentence including the count. Never contains a cell value. */
  message: string;
}

export interface AdjustmentValidationReport {
  /** False when the mapping cannot be applied (see mappingIssues); nothing else in the report is meaningful then. */
  ok: boolean;
  /** No error rows and at least one row to send. */
  committable: boolean;
  mappingIssues: MappingIssue[];
  counts: {
    /** Non-blank data rows in the sheet. */
    rows: number;
    /** Rows with at least one error. */
    errorRows: number;
    /** rows - errorRows. */
    cleanRows: number;
    /** Records that will be sent to the database (after merging or ignoring repeats and leaving out rows already imported). */
    accepted: number;
    merged: number;
    ignored: number;
    alreadyImported: number;
  };
  /** Rows per code, every code present (zero included). */
  byCode: Record<ImportCode, number>;
  /** Codes with at least one row, errors first. */
  codes: CodeSummary[];
  /** 1-based data row numbers per code (blank lines are not counted), at most 50 each. */
  rowNumbers: Partial<Record<ImportCode, number[]>>;
  /** First 100 issues in row order. */
  issues: ImportIssue[];
  issuesTruncated: boolean;
  shipDateRange: { min: string | null; max: string | null };
  byType: Partial<Record<AdjustmentType, number>>;
  /** Records per carrier code. */
  byCarrier: Record<string, number>;
  /** Distinct customer names in the file (blank excluded) and where each goes. */
  customers: { text: string; rows: number; brandId: string | null }[];
  /** Rows with a blank customer cell that no default covers. */
  unassignedRows: number;
  ignoredColumns: IgnoredColumn[];
  notice: string;
  limits: string;
}

/** A validated record (camelCase), numbered by its source row. Amounts are two-decimal strings, weights pounds at up to six decimals. */
export interface AdjustmentRecord {
  rowNo: number;
  shipDate: string;
  adjustedOn: string | null;
  carrierCode: string;
  serviceId: string | null;
  serviceText: string | null;
  brandId: string | null;
  adjustmentType: AdjustmentType;
  cause: AdjustmentCause;
  reasonText: string | null;
  packageRef: string | null;
  declaredWeightLb: string | null;
  declaredWeightBasis: WeightBasis;
  actualWeightLb: string | null;
  original: { length: string; width: string; height: string } | null;
  corrected: { length: string; width: string; height: string } | null;
  originalCharge: string | null;
  correctedCharge: string | null;
  separateFee: string | null;
  handlingRecorded: RecordedHandling | null;
}

export interface AdjustmentImportResult {
  /** The records to send, in file order. Meaningful when report.committable. */
  records: AdjustmentRecord[];
  report: AdjustmentValidationReport;
}

/** One row of public.append_adjustment_records(p_rows). Exactly these keys, in this order; unknown is null, never 0. */
export interface AppendRow {
  ship_date: string;
  adjusted_on: string | null;
  carrier_code: string;
  service_id: string | null;
  service_text: string | null;
  brand_id: string | null;
  adjustment_type: AdjustmentType;
  cause: AdjustmentCause;
  reason_text: string | null;
  package_ref: string | null;
  declared_weight_lb: string | null;
  declared_weight_basis: WeightBasis;
  actual_weight_lb: string | null;
  orig_length_in: string | null;
  orig_width_in: string | null;
  orig_height_in: string | null;
  corr_length_in: string | null;
  corr_width_in: string | null;
  corr_height_in: string | null;
  original_charge: string | null;
  corrected_charge: string | null;
  separate_fee: string | null;
  handling_recorded: RecordedHandling | null;
}

export interface AppendChunk {
  /** p_from_row: the 1-based row_no of the first row of the chunk (dense numbering over the whole import). */
  fromRow: number;
  rows: AppendRow[];
}
