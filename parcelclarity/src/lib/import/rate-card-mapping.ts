import type { Table } from "./parse-table";

/**
 * Column-mapping model for rate-card imports and the heuristics that propose one. Heuristics only
 * propose; an administrator reviews and approves the mapping before anything is imported. No AI
 * is involved, and cell contents are treated strictly as data.
 */

export type WeightUnit = "lb" | "oz";

export interface ServiceCatalogEntry {
  id: string;
  carrierCode: string;
  carrierName: string;
  code: string;
  name: string;
}

/** Long format: one row per (service, origin?, zone, bracket). Column indexes are 0-based; null = not present. */
export interface LongMapping {
  format: "long";
  sheet: string;
  headerRow: number;
  columns: {
    carrier: number | null;
    service: number;
    originZip: number | null;
    zone: number;
    weightMin: number | null;
    weightMax: number;
    weightUnit: number | null;
    price: number;
    minCharge: number | null;
    dimDivisor: number | null;
  };
  defaults: { weightUnit: WeightUnit; dimDivisor: string | null };
  /** Raw service text (normalized) → shipping_services.id. Must cover every service string in the file. */
  serviceMap: Record<string, string>;
}

/** Grid format: weights down the first column, zones across; one service per sheet (or per block). */
export interface GridSheetMapping {
  sheet: string;
  serviceId: string;
  headerRow: number;
  weightColumn: number;
  weightUnit: WeightUnit;
  zoneColumns: { column: number; zone: string }[];
  originZip: string | null;
  dimDivisor: string | null;
  minCharge: string | null;
}

export interface GridMapping {
  format: "grid";
  sheets: GridSheetMapping[];
}

export type RateCardMapping = LongMapping | GridMapping;

export interface Detection {
  suggestedFormat: "long" | "grid";
  sheets: { name: string; headerRow: number; headers: string[]; sample: string[][]; rowCount: number; looksLikeGrid: boolean }[];
  /** Distinct raw service strings found (long format), with the best catalog match for each. */
  serviceStrings: { raw: string; normalized: string; suggestedServiceId: string | null; confidence: number }[];
  suggestion: RateCardMapping | null;
}

export const normalizeHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const normalizeServiceText = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const HEADER_SYNONYMS: Record<keyof LongMapping["columns"], string[]> = {
  carrier: ["carrier", "carrier name", "courier"],
  service: ["service", "service name", "service level", "ship method", "shipping service", "method", "product"],
  originZip: ["origin zip", "origin", "origin zip code", "ship from zip", "from zip", "origin postal"],
  zone: ["zone", "dest zone", "destination zone", "ship zone", "zn"],
  weightMin: ["weight min", "min weight", "weight from", "from weight", "min lbs", "min lb", "weight min lb", "lower weight"],
  weightMax: ["weight max", "max weight", "weight", "weight to", "to weight", "weight lb", "lbs", "lb", "max lbs", "weight lbs", "upper weight", "weight bracket", "bracket"],
  weightUnit: ["weight unit", "unit", "units", "uom"],
  price: ["price", "rate", "base rate", "base price", "cost", "charge", "customer rate", "customer price", "amount", "list rate"],
  minCharge: ["min charge", "minimum charge", "minimum", "min", "minimum rate"],
  dimDivisor: ["dim divisor", "dim factor", "dimensional divisor", "divisor", "dim"],
};

function matchHeader(headers: string[], field: keyof LongMapping["columns"], used: Set<number>): number | null {
  const normalized = headers.map(normalizeHeader);
  for (const synonym of HEADER_SYNONYMS[field]) {
    const idx = normalized.findIndex((h, i) => !used.has(i) && h === synonym);
    if (idx !== -1) return idx;
  }
  for (const synonym of HEADER_SYNONYMS[field]) {
    const idx = normalized.findIndex((h, i) => !used.has(i) && h.includes(synonym) && synonym.length >= 4);
    if (idx !== -1) return idx;
  }
  return null;
}

const ZONE_HEADER = /^(zone\s*)?([0-9]{1,2}|[a-z])$/i;
const WEIGHT_HEADER = /weight|lbs?\b|wt\b|oz\b|ounces|pounds/i;

const PRICE_LIKE = /^\$?\d+\.\d{2,}$/;

/**
 * A grid sheet has a header row with a weight column and at least three zone-like headers.
 * Data rows of a long-format file also contain small integers (zones, brackets), so a header
 * candidate must look like a header: no price-like cells, and a labelled weight column.
 */
function detectGridHeader(rows: string[][]): { headerRow: number; weightColumn: number; zoneColumns: { column: number; zone: string }[] } | null {
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const row = rows[r]!;
    if (row.some((c) => PRICE_LIKE.test(c.trim()))) continue;
    const zoneColumns = row.map((h, column) => ({ h: h.trim(), column })).filter(({ h }) => ZONE_HEADER.test(h)).map(({ h, column }) => ({ column, zone: h.replace(/zone\s*/i, "").toUpperCase() }));
    if (zoneColumns.length < 3) continue;
    const weightColumn = row.findIndex((h, i) => WEIGHT_HEADER.test(h) && !zoneColumns.some((z) => z.column === i));
    if (weightColumn === -1) continue;
    return { headerRow: r, weightColumn, zoneColumns };
  }
  return null;
}

function findHeaderRow(rows: string[][]): number {
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const row = rows[r]!;
    const nonEmpty = row.filter((c) => c !== "").length;
    const numeric = row.filter((c) => /^[\d.$,]+$/.test(c)).length;
    if (nonEmpty >= 3 && numeric <= nonEmpty / 3) return r;
  }
  return 0;
}

/** Scores a raw service string against the catalog: token overlap, with carrier names as strong hints. */
export function suggestService(raw: string, catalog: ServiceCatalogEntry[], carrierHint?: string | null): { serviceId: string | null; confidence: number } {
  const text = normalizeServiceText(raw);
  if (!text) return { serviceId: null, confidence: 0 };
  const tokens = new Set(text.split(" "));
  let best: { serviceId: string | null; confidence: number } = { serviceId: null, confidence: 0 };
  for (const s of catalog) {
    const nameTokens = new Set(normalizeServiceText(`${s.carrierName} ${s.name}`).split(" "));
    const serviceOnly = new Set(normalizeServiceText(s.name).split(" "));
    let overlap = 0;
    for (const t of tokens) if (nameTokens.has(t)) overlap++;
    const union = new Set([...tokens, ...serviceOnly]).size;
    let score = union ? overlap / union : 0;
    const carrierToken = normalizeServiceText(s.carrierName);
    if (tokens.has(carrierToken) || (carrierHint && normalizeServiceText(carrierHint) === carrierToken)) score += 0.25;
    if (text === normalizeServiceText(s.name) || text === normalizeServiceText(`${s.carrierName} ${s.name}`)) score = 1;
    if (score > best.confidence) best = { serviceId: s.id, confidence: Math.min(1, score) };
  }
  return best.confidence >= 0.4 ? best : { serviceId: null, confidence: best.confidence };
}

export function detectRateCard(tables: Table[], catalog: ServiceCatalogEntry[]): Detection {
  const sheets = tables.map((t) => {
    // Long format takes precedence: if the header row carries the long-format columns, it is not a grid.
    const longHeader = findHeaderRow(t.rows);
    const longHeaders = t.rows[longHeader] ?? [];
    const probe = new Set<number>();
    const longLike = (["service", "price", "zone", "weightMax"] as const).every((f) => {
      const idx = matchHeader(longHeaders, f, probe);
      if (idx !== null) probe.add(idx);
      return idx !== null;
    });
    const grid = longLike ? null : detectGridHeader(t.rows);
    const headerRow = grid ? grid.headerRow : longHeader;
    return {
      name: t.name,
      headerRow,
      headers: t.rows[headerRow] ?? [],
      sample: t.rows.slice(headerRow + 1, headerRow + 6),
      rowCount: Math.max(0, t.rows.length - headerRow - 1),
      looksLikeGrid: !!grid,
      grid,
      table: t,
    };
  });

  const first = sheets[0]!;
  const used = new Set<number>();
  const col = (field: keyof LongMapping["columns"]) => {
    const idx = matchHeader(first.headers, field, used);
    if (idx !== null) used.add(idx);
    return idx;
  };
  const service = col("service");
  const price = col("price");
  const zone = col("zone");
  const weightMax = col("weightMax");
  const longViable = service !== null && price !== null && zone !== null && weightMax !== null;

  if (!longViable && sheets.some((s) => s.looksLikeGrid)) {
    const gridSheets: GridSheetMapping[] = sheets
      .filter((s) => s.grid)
      .map((s) => {
        const guess = suggestService(s.name, catalog);
        return {
          sheet: s.name,
          serviceId: guess.serviceId ?? "",
          headerRow: s.grid!.headerRow,
          weightColumn: s.grid!.weightColumn,
          weightUnit: /oz|ounce/i.test(s.headers[s.grid!.weightColumn] ?? "") ? "oz" : "lb",
          zoneColumns: s.grid!.zoneColumns,
          originZip: null,
          dimDivisor: null,
          minCharge: null,
        };
      });
    return {
      suggestedFormat: "grid",
      sheets: sheets.map(({ name, headerRow, headers, sample, rowCount, looksLikeGrid }) => ({ name, headerRow, headers, sample, rowCount, looksLikeGrid })),
      serviceStrings: [],
      suggestion: { format: "grid", sheets: gridSheets },
    };
  }

  const carrier = col("carrier");
  const serviceStrings: Detection["serviceStrings"] = [];
  if (service !== null) {
    const seen = new Map<string, string>();
    for (const row of first.table.rows.slice(first.headerRow + 1)) {
      const raw = (row[service] ?? "").trim();
      if (!raw) continue;
      const normalized = normalizeServiceText(raw);
      if (!seen.has(normalized)) seen.set(normalized, raw);
    }
    for (const [normalized, raw] of seen) {
      const hint = carrier !== null ? first.table.rows.find((r) => normalizeServiceText(r[service] ?? "") === normalized)?.[carrier] : null;
      const s = suggestService(raw, catalog, hint);
      serviceStrings.push({ raw, normalized, suggestedServiceId: s.serviceId, confidence: s.confidence });
    }
  }

  const suggestion: LongMapping | null = longViable
    ? {
        format: "long",
        sheet: first.name,
        headerRow: first.headerRow,
        columns: {
          carrier,
          service: service!,
          originZip: col("originZip"),
          zone: zone!,
          weightMin: col("weightMin"),
          weightMax: weightMax!,
          weightUnit: col("weightUnit"),
          price: price!,
          minCharge: col("minCharge"),
          dimDivisor: col("dimDivisor"),
        },
        defaults: { weightUnit: "lb", dimDivisor: null },
        serviceMap: Object.fromEntries(serviceStrings.filter((s) => s.suggestedServiceId && s.confidence >= 0.6).map((s) => [s.normalized, s.suggestedServiceId!])),
      }
    : null;

  return {
    suggestedFormat: "long",
    sheets: sheets.map(({ name, headerRow, headers, sample, rowCount, looksLikeGrid }) => ({ name, headerRow, headers, sample, rowCount, looksLikeGrid })),
    serviceStrings,
    suggestion,
  };
}
