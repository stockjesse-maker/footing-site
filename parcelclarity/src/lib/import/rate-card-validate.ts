import type { Table } from "./parse-table";
import { normalizeServiceText, type RateCardMapping, type ServiceCatalogEntry, type WeightUnit } from "./rate-card-mapping";

/**
 * Applies an approved mapping to the parsed tables and validates the result. Pure. Errors block
 * import; warnings are shown for the administrator's judgement. Nothing is ever invented: a cell
 * that cannot be read becomes an error, not a guess.
 */

export interface ParsedRateRow {
  serviceId: string;
  originPrefix: string | null;
  zone: string;
  weightMin: string;
  weightMax: string;
  weightUnit: WeightUnit;
  price: string;
  minCharge: string | null;
  source: { sheet: string; row: number }; // 1-based row number in the file
}

export interface ServiceSummary {
  serviceId: string;
  serviceName: string;
  rowCount: number;
  zones: string[];
  originPrefixes: string[];
  maxWeight: { value: string; unit: WeightUnit } | null;
  dimDivisor: string | null;
}

export interface Issue {
  severity: "error" | "warning";
  code: string;
  message: string;
  sheet?: string;
  row?: number;
}

export interface ValidationReport {
  ok: boolean;
  rowCount: number;
  errorCount: number;
  warningCount: number;
  errors: Issue[];
  warnings: Issue[];
  issuesTruncated: boolean;
  services: ServiceSummary[];
}

export interface ImportResult {
  rows: ParsedRateRow[];
  /** Per-service terms gathered from the file (DIM divisor, minimum charge). */
  terms: Record<string, { dimDivisor: string | null; minCharge: string | null }>;
  report: ValidationReport;
}

const MAX_ISSUES = 300;

export function parseMoney(raw: string): string | null {
  const cleaned = raw.trim().replace(/^\$|usd/gi, "").replace(/,/g, "").trim();
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const [int, frac = ""] = cleaned.split(".");
  return `${int}.${(frac + "0000").slice(0, 4)}`;
}

export function parseDecimal(raw: string): string | null {
  const cleaned = raw.trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  return cleaned;
}

/** "5", "5 lb", "5lbs", "16 oz", "1-4 oz", "1 - 4" → { min?, max, unit? }. */
export function parseWeightCell(raw: string): { min: string | null; max: string; unit: WeightUnit | null } | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  const unit: WeightUnit | null = /\boz\b|ounce/.test(text) ? "oz" : /\blbs?\b|pound/.test(text) ? "lb" : null;
  const numbers = text.replace(/[a-z]/g, " ").match(/\d+(\.\d+)?/g);
  if (!numbers || numbers.length === 0 || numbers.length > 2) return null;
  if (numbers.length === 2) return { min: numbers[0]!, max: numbers[1]!, unit };
  return { min: null, max: numbers[0]!, unit };
}

export function parseZone(raw: string): string | null {
  const z = raw.trim().toUpperCase().replace(/^ZONE\s*/, "");
  return /^[A-Z0-9]{1,12}$/.test(z) ? z : null;
}

export function parseOrigin(raw: string): string | null | "invalid" {
  const t = raw.trim();
  if (!t) return null;
  const digits = t.replace(/-\d{4}$/, "");
  if (/^\d{5}$/.test(digits) || /^\d{3}$/.test(digits)) return digits;
  return "invalid";
}

function toLb(value: string, unit: WeightUnit): number {
  return unit === "oz" ? Number(value) / 16 : Number(value);
}

export function applyMapping(tables: Table[], mapping: RateCardMapping, catalog: ServiceCatalogEntry[]): ImportResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  let dropped = 0;
  const push = (issue: Issue) => {
    const list = issue.severity === "error" ? errors : warnings;
    if (list.length >= MAX_ISSUES) dropped++;
    else list.push(issue);
  };
  const catalogById = new Map(catalog.map((s) => [s.id, s]));
  const rows: ParsedRateRow[] = [];
  const terms: ImportResult["terms"] = {};
  const noteDivisor = (serviceId: string, raw: string | null, sheet: string, row: number) => {
    const t = (terms[serviceId] ??= { dimDivisor: null, minCharge: null });
    if (raw === null || raw === "") return;
    const v = parseDecimal(raw);
    if (v === null || Number(v) <= 0) {
      push({ severity: "error", code: "bad_dim_divisor", message: `DIM divisor "${raw}" is not a positive number.`, sheet, row });
      return;
    }
    if (t.dimDivisor !== null && t.dimDivisor !== v) push({ severity: "warning", code: "dim_divisor_conflict", message: `DIM divisor ${v} differs from ${t.dimDivisor} seen earlier for the same service; the first value is kept.`, sheet, row });
    else t.dimDivisor = v;
  };

  if (mapping.format === "long") {
    const table = tables.find((t) => t.name === mapping.sheet) ?? tables[0];
    if (!table) {
      push({ severity: "error", code: "sheet_missing", message: `Sheet "${mapping.sheet}" was not found.` });
    } else {
      const c = mapping.columns;
      for (let i = mapping.headerRow + 1; i < table.rows.length; i++) {
        const r = table.rows[i]!;
        const rowNo = i + 1;
        if (r.every((cell) => cell === "")) continue;
        const cell = (idx: number | null) => (idx === null ? "" : (r[idx] ?? "").trim());

        const serviceRaw = cell(c.service);
        const serviceId = mapping.serviceMap[normalizeServiceText(serviceRaw)];
        if (!serviceRaw) {
          push({ severity: "error", code: "service_missing", message: "Service is empty.", sheet: table.name, row: rowNo });
          continue;
        }
        if (!serviceId || !catalogById.has(serviceId)) {
          push({ severity: "error", code: "service_unmapped", message: `Service "${serviceRaw}" is not mapped to a known service.`, sheet: table.name, row: rowNo });
          continue;
        }
        const zone = parseZone(cell(c.zone));
        if (!zone) {
          push({ severity: "error", code: "zone_invalid", message: `Zone "${cell(c.zone)}" is not valid.`, sheet: table.name, row: rowNo });
          continue;
        }
        const origin = parseOrigin(cell(c.originZip));
        if (origin === "invalid") {
          push({ severity: "error", code: "origin_invalid", message: `Origin ZIP "${cell(c.originZip)}" must be 3 or 5 digits.`, sheet: table.name, row: rowNo });
          continue;
        }
        const wmax = parseWeightCell(cell(c.weightMax));
        if (!wmax) {
          push({ severity: "error", code: "weight_invalid", message: `Weight "${cell(c.weightMax)}" is not a number.`, sheet: table.name, row: rowNo });
          continue;
        }
        let min: string | null = wmax.min;
        if (c.weightMin !== null && cell(c.weightMin) !== "") {
          const wmin = parseDecimal(cell(c.weightMin));
          if (wmin === null) {
            push({ severity: "error", code: "weight_invalid", message: `Minimum weight "${cell(c.weightMin)}" is not a number.`, sheet: table.name, row: rowNo });
            continue;
          }
          min = wmin;
        }
        const unitCell = cell(c.weightUnit).toLowerCase();
        const unit: WeightUnit = wmax.unit ?? (unitCell.startsWith("oz") ? "oz" : unitCell.startsWith("lb") || unitCell.startsWith("pound") ? "lb" : mapping.defaults.weightUnit);
        const price = parseMoney(cell(c.price));
        if (price === null) {
          push({ severity: "error", code: "price_invalid", message: `Price "${cell(c.price)}" is not a number.`, sheet: table.name, row: rowNo });
          continue;
        }
        let minCharge: string | null = null;
        if (cell(c.minCharge) !== "") {
          minCharge = parseMoney(cell(c.minCharge));
          if (minCharge === null) {
            push({ severity: "error", code: "min_charge_invalid", message: `Minimum charge "${cell(c.minCharge)}" is not a number.`, sheet: table.name, row: rowNo });
            continue;
          }
        }
        noteDivisor(serviceId, c.dimDivisor === null ? mapping.defaults.dimDivisor : cell(c.dimDivisor) || mapping.defaults.dimDivisor, table.name, rowNo);
        rows.push({ serviceId, originPrefix: origin, zone, weightMin: min ?? "", weightMax: wmax.max, weightUnit: unit, price, minCharge, source: { sheet: table.name, row: rowNo } });
      }
    }
  } else {
    for (const sheetMap of mapping.sheets) {
      const table = tables.find((t) => t.name === sheetMap.sheet);
      if (!table) {
        push({ severity: "error", code: "sheet_missing", message: `Sheet "${sheetMap.sheet}" was not found.` });
        continue;
      }
      if (!sheetMap.serviceId || !catalogById.has(sheetMap.serviceId)) {
        push({ severity: "error", code: "service_unmapped", message: `Sheet "${sheetMap.sheet}" is not mapped to a service.`, sheet: table.name });
        continue;
      }
      const origin = sheetMap.originZip ? parseOrigin(sheetMap.originZip) : null;
      if (origin === "invalid") {
        push({ severity: "error", code: "origin_invalid", message: `Origin ZIP "${sheetMap.originZip}" must be 3 or 5 digits.`, sheet: table.name });
        continue;
      }
      noteDivisor(sheetMap.serviceId, sheetMap.dimDivisor, table.name, sheetMap.headerRow + 1);
      if (sheetMap.minCharge) {
        const mc = parseMoney(sheetMap.minCharge);
        if (mc === null) push({ severity: "error", code: "min_charge_invalid", message: `Minimum charge "${sheetMap.minCharge}" is not a number.`, sheet: table.name });
        else (terms[sheetMap.serviceId] ??= { dimDivisor: null, minCharge: null }).minCharge = mc;
      }
      for (let i = sheetMap.headerRow + 1; i < table.rows.length; i++) {
        const r = table.rows[i]!;
        const rowNo = i + 1;
        const weightRaw = (r[sheetMap.weightColumn] ?? "").trim();
        if (!weightRaw) {
          if (r.some((cell) => cell !== "")) push({ severity: "warning", code: "row_skipped", message: "Row has no weight and was skipped.", sheet: table.name, row: rowNo });
          continue;
        }
        const w = parseWeightCell(weightRaw);
        if (!w) {
          push({ severity: "error", code: "weight_invalid", message: `Weight "${weightRaw}" is not a number.`, sheet: table.name, row: rowNo });
          continue;
        }
        const unit = w.unit ?? sheetMap.weightUnit;
        for (const zc of sheetMap.zoneColumns) {
          const raw = (r[zc.column] ?? "").trim();
          if (raw === "" || raw === "-" || raw.toLowerCase() === "n/a") continue;
          const price = parseMoney(raw);
          if (price === null) {
            push({ severity: "error", code: "price_invalid", message: `Price "${raw}" in zone ${zc.zone} is not a number.`, sheet: table.name, row: rowNo });
            continue;
          }
          const zone = parseZone(zc.zone);
          if (!zone) {
            push({ severity: "error", code: "zone_invalid", message: `Zone header "${zc.zone}" is not valid.`, sheet: table.name });
            continue;
          }
          rows.push({ serviceId: sheetMap.serviceId, originPrefix: origin, zone, weightMin: w.min ?? "", weightMax: w.max, weightUnit: unit, price, minCharge: null, source: { sheet: table.name, row: rowNo } });
        }
      }
    }
  }

  // Bracket integrity per (service, origin, zone): derive missing minimums, detect overlaps and gaps.
  const groups = new Map<string, ParsedRateRow[]>();
  for (const row of rows) {
    const key = `${row.serviceId}|${row.originPrefix ?? ""}|${row.zone}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => toLb(a.weightMax, a.weightUnit) - toLb(b.weightMax, b.weightUnit));
    let prevMaxLb = 0;
    let prevPrice = -1;
    for (let i = 0; i < group.length; i++) {
      const row = group[i]!;
      const maxLb = toLb(row.weightMax, row.weightUnit);
      if (i > 0 && maxLb === prevMaxLb) {
        push({ severity: "error", code: "bracket_duplicate", message: `Duplicate bracket up to ${row.weightMax} ${row.weightUnit} for zone ${row.zone}.`, sheet: row.source.sheet, row: row.source.row });
        continue;
      }
      if (row.weightMin === "") {
        // Derive from the previous bracket in the same unit when possible.
        row.weightMin = i === 0 ? "0" : group[i - 1]!.weightUnit === row.weightUnit ? group[i - 1]!.weightMax : String(toLb(group[i - 1]!.weightMax, group[i - 1]!.weightUnit) * (row.weightUnit === "oz" ? 16 : 1));
      } else {
        const minLb = toLb(row.weightMin, row.weightUnit);
        if (minLb >= maxLb) push({ severity: "error", code: "bracket_inverted", message: `Weight from ${row.weightMin} must be below weight to ${row.weightMax} (${row.weightUnit}).`, sheet: row.source.sheet, row: row.source.row });
        else if (i > 0 && minLb < prevMaxLb - 1e-9) push({ severity: "error", code: "bracket_overlap", message: `Bracket ${row.weightMin}–${row.weightMax} ${row.weightUnit} overlaps the previous bracket for zone ${row.zone}.`, sheet: row.source.sheet, row: row.source.row });
        else if (i > 0 && minLb > prevMaxLb + 1e-9) push({ severity: "warning", code: "bracket_gap", message: `Weights between ${prevMaxLb} lb and ${row.weightMin} ${row.weightUnit} have no rate for zone ${row.zone}.`, sheet: row.source.sheet, row: row.source.row });
      }
      const price = Number(row.price);
      if (price === 0) push({ severity: "warning", code: "price_zero", message: `Price is zero for zone ${row.zone} up to ${row.weightMax} ${row.weightUnit}.`, sheet: row.source.sheet, row: row.source.row });
      if (prevPrice >= 0 && price < prevPrice) push({ severity: "warning", code: "price_decreasing", message: `Price ${row.price} is lower than the lighter bracket (${prevPrice.toFixed(2)}) for zone ${row.zone}.`, sheet: row.source.sheet, row: row.source.row });
      prevMaxLb = maxLb;
      prevPrice = price;
    }
  }

  if (!rows.length && !errors.length) push({ severity: "error", code: "no_rows", message: "No rate rows were found." });

  const services: ServiceSummary[] = [...new Set(rows.map((r) => r.serviceId))].map((serviceId) => {
    const mine = rows.filter((r) => r.serviceId === serviceId);
    const heaviest = mine.reduce<ParsedRateRow | null>((m, r) => (!m || toLb(r.weightMax, r.weightUnit) > toLb(m.weightMax, m.weightUnit) ? r : m), null);
    return {
      serviceId,
      serviceName: catalogById.get(serviceId)?.name ?? serviceId,
      rowCount: mine.length,
      zones: [...new Set(mine.map((r) => r.zone))].sort(),
      originPrefixes: [...new Set(mine.map((r) => r.originPrefix ?? "any"))].sort(),
      maxWeight: heaviest ? { value: heaviest.weightMax, unit: heaviest.weightUnit } : null,
      dimDivisor: terms[serviceId]?.dimDivisor ?? null,
    };
  });
  for (const s of services) {
    if (s.dimDivisor === null) push({ severity: "warning", code: "dim_divisor_missing", message: `No DIM divisor for ${s.serviceName}; calculations will use actual weight and be marked as estimates until one is set.` });
  }

  return {
    rows,
    terms,
    report: {
      ok: errors.length === 0 && rows.length > 0,
      rowCount: rows.length,
      errorCount: errors.length + (dropped > 0 ? 0 : 0),
      warningCount: warnings.length,
      errors,
      warnings,
      issuesTruncated: dropped > 0,
      services,
    },
  };
}
