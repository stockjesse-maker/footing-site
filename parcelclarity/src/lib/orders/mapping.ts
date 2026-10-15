import type { Table } from "../import/parse-table";
import { normalizeHeader, normalizeServiceText, suggestService, type ServiceCatalogEntry } from "../import/rate-card-mapping";
import { classifyDateCell, parseZip } from "./cells";
import type { OrderColumnMap, OrderFileFormat, OrderGrouping, OrderMapping, WeightUnitInFile } from "./types";

/**
 * Detects the layout of an uploaded orders file and proposes a mapping the customer then confirms.
 * Heuristics only (header synonyms, a look at the cells); nothing is decided silently: where the data
 * cannot settle a question (month-first or day-first dates, pounds or ounces) the detection says so
 * and the wizard asks.
 */

export interface OrderDetection {
  format: OrderFileFormat;
  sheets: { name: string; headerRow: number; headers: string[]; sample: string[][]; rowCount: number }[];
  /** Distinct service strings with the best catalog match for each, for the service-map step. */
  serviceStrings: { text: string; normalized: string; rows: number; suggestedServiceId: string | null; confidence: number }[];
  suggestion: OrderMapping | null;
  /** No date value had a component above 12, so month-first and day-first both fit: the customer must choose. */
  dateFormatAmbiguous: boolean;
  /** The unit the weight header names, if any ("Weight (oz)", "Lineitem grams"). */
  weightUnitFromHeader: WeightUnitInFile | null;
  /** Plain-language observations for the wizard. */
  notes: string[];
}

type Field = keyof OrderColumnMap;

/** Synonyms per field, normalised like the headers (lower case, non-alphanumerics → spaces). Order = priority. */
const HEADER_SYNONYMS: Record<Field, string[]> = {
  orderId: ["order id", "order number", "order no", "order name", "order ref", "order reference", "order", "name"],
  shipmentId: ["shipment id", "shipment number", "shipment no", "shipment", "fulfillment id"],
  packageId: ["package id", "package number", "package no", "package", "carton id", "carton", "box id", "tracking number", "tracking"],
  orderDate: ["order date", "created at", "order created", "date ordered", "placed at", "order placed", "created", "date"],
  shipDate: ["ship date", "shipped at", "shipped date", "fulfilled at", "shipment date", "date shipped", "fulfillment date"],
  originZip: ["origin zip", "ship from zip", "warehouse zip", "from zip", "origin postal code", "origin postal", "ship from postal code", "sender zip", "origin"],
  destinationZip: ["destination zip", "shipping zip", "ship to zip", "dest zip", "ship to postal code", "shipping postal code", "zip code", "postal code", "recipient zip", "customer zip", "to zip", "zip"],
  country: ["shipping country", "ship to country", "destination country", "country code", "country"],
  residential: ["residential", "address type", "residential indicator", "is residential", "delivery type", "home delivery"],
  carrier: ["carrier", "carrier name", "carrier code", "courier"],
  service: ["shipping method", "ship method", "service level", "shipping service", "carrier service", "service name", "delivery method", "service", "method", "shipping"],
  weight: ["package weight", "shipment weight", "total weight", "actual weight", "weight lb", "weight lbs", "weight oz", "weight kg", "weight g", "lineitem grams", "total grams", "weight", "grams"],
  weightUnit: ["weight unit", "weight uom", "uom"],
  length: ["length in", "length", "l"],
  width: ["width in", "width", "w"],
  height: ["height in", "height", "h"],
  declaredValue: ["declared value", "insured value", "insurance value", "value"],
  sku: ["lineitem sku", "item sku", "product sku", "variant sku", "sku"],
  units: ["lineitem quantity", "item quantity", "units per sku", "line quantity", "quantity", "qty", "units"],
  packaging: ["packaging type", "packaging", "package type", "box type", "container"],
  cancelled: ["cancelled at", "canceled at", "cancel date", "cancelled", "canceled"],
  requiresShipping: ["lineitem requires shipping", "requires shipping"],
  packageCount: ["package count", "number of packages", "num packages", "package qty", "packages"],
};

/** Fields in the order they claim columns, so "Order Number" is the order id before "Shipment Number" looks for "number". */
const FIELD_ORDER: Field[] = [
  "orderId", "shipmentId", "shipDate", "orderDate", "destinationZip", "originZip", "service", "carrier", "weight", "weightUnit",
  "length", "width", "height", "sku", "units", "packageId", "packaging", "declaredValue", "residential", "country", "cancelled", "requiresShipping", "packageCount",
];

/** The key of a service string in `serviceMap`: carrier and service text together, normalised. */
export function serviceKey(carrier: string | null, service: string): string {
  return normalizeServiceText(carrier ? `${carrier} ${service}` : service);
}

function matchHeader(normalized: string[], field: Field, used: Set<number>): number | null {
  for (const synonym of HEADER_SYNONYMS[field]) {
    const idx = normalized.findIndex((h, i) => !used.has(i) && h === synonym);
    if (idx !== -1) return idx;
  }
  for (const synonym of HEADER_SYNONYMS[field]) {
    if (synonym.length < 5) continue;
    const idx = normalized.findIndex((h, i) => !used.has(i) && h.includes(synonym));
    if (idx !== -1) return idx;
  }
  return null;
}

function findHeaderRow(rows: string[][]): number {
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const row = rows[r]!;
    const nonEmpty = row.filter((c) => c !== "").length;
    const numeric = row.filter((c) => /^[\d.$,/-]+$/.test(c)).length;
    if (nonEmpty >= 3 && numeric <= nonEmpty / 4) return r;
  }
  return 0;
}

function detectFormat(normalized: string[]): OrderFileFormat {
  const has = (h: string) => normalized.includes(h);
  if (has("name") && has("lineitem quantity") && (has("shipping zip") || has("shipping method"))) return "shopify";
  if (has("order number") && (has("shipment number") || has("warehouse zip") || has("ship to zip"))) return "shiphero";
  return "generic";
}

function weightUnitOfHeader(header: string | undefined): WeightUnitInFile | null {
  if (!header) return null;
  const h = normalizeHeader(header);
  if (/\b(lb|lbs|pound|pounds)\b/.test(h)) return "lb";
  if (/\b(oz|ounce|ounces)\b/.test(h)) return "oz";
  if (/\b(g|gram|grams)\b/.test(h)) return "g";
  if (/\b(kg|kilogram|kilograms)\b/.test(h)) return "kg";
  return null;
}

/** Month-first or day-first: decided only when some value has a component above 12. */
function detectDateFormat(cells: string[]): { format: OrderMapping["dateFormat"]; ambiguous: boolean } {
  let sawNumeric = false;
  for (const raw of cells) {
    const c = classifyDateCell(raw);
    if (!c) continue;
    if (c.kind === "iso") continue;
    sawNumeric = true;
    if (c.first > 12) return { format: "dmy", ambiguous: false };
    if (c.second > 12) return { format: "mdy", ambiguous: false };
  }
  return sawNumeric ? { format: "mdy", ambiguous: true } : { format: "iso", ambiguous: false };
}

export function detectOrderFile(tables: Table[], catalog: ServiceCatalogEntry[]): OrderDetection {
  const sheets = tables.map((t) => {
    const headerRow = findHeaderRow(t.rows);
    return { name: t.name, headerRow, headers: t.rows[headerRow] ?? [], sample: t.rows.slice(headerRow + 1, headerRow + 6), rowCount: Math.max(0, t.rows.length - headerRow - 1) };
  });
  const table = tables[0];
  const sheet = sheets[0];
  if (!table || !sheet) return { format: "generic", sheets, serviceStrings: [], suggestion: null, dateFormatAmbiguous: false, weightUnitFromHeader: null, notes: ["The file has no rows."] };

  const headers = sheet.headers;
  const normalized = headers.map(normalizeHeader);
  const format = detectFormat(normalized);
  const used = new Set<number>();
  const columns = {} as OrderColumnMap;
  for (const field of FIELD_ORDER) {
    const idx = matchHeader(normalized, field, used);
    // Order id is required; every other field may be absent.
    (columns as Record<Field, number | null>)[field] = idx;
    if (idx !== null) used.add(idx);
  }
  const dataRows = table.rows.slice(sheet.headerRow + 1);
  const notes: string[] = [];
  if (columns.orderId === null) {
    notes.push("No order id column was recognised; choose it below.");
    columns.orderId = 0;
  }

  const cell = (row: string[], idx: number | null) => (idx === null ? "" : (row[idx] ?? "").trim());
  const dateCells = dataRows.flatMap((r) => [cell(r, columns.orderDate), cell(r, columns.shipDate)]).filter(Boolean).slice(0, 2000);
  const dates = detectDateFormat(dateCells);
  const weightUnitFromHeader = weightUnitOfHeader(columns.weight === null ? undefined : headers[columns.weight]);
  const padShortZips = dataRows.some((r) => parseZip(cell(r, columns.destinationZip), false).status === "short");

  const grouping: OrderGrouping = {
    shipments: columns.shipmentId !== null ? "by_shipment_id" : format === "shiphero" ? "one_per_row" : "one_per_order",
    packages: columns.packageId !== null ? "by_package_columns" : format === "generic" && columns.sku === null && columns.weight !== null ? "by_package_columns" : "one_per_shipment",
  };

  // Service strings are keyed together with the carrier when the file names one ("UPS" + "Ground"
  // and "FedEx" + "Ground" are different services).
  const counts = new Map<string, { text: string; rows: number; carrier: string | null }>();
  for (const r of dataRows) {
    const text = cell(r, columns.service);
    if (!text) continue;
    const carrier = cell(r, columns.carrier) || null;
    const key = serviceKey(carrier, text);
    const entry = counts.get(key) ?? { text: carrier ? `${carrier} ${text}` : text, rows: 0, carrier };
    entry.rows++;
    counts.set(key, entry);
  }
  const serviceStrings = [...counts.entries()]
    .map(([normalizedText, e]) => {
      const s = suggestService(e.text, catalog, e.carrier);
      return { text: e.text, normalized: normalizedText, rows: e.rows, suggestedServiceId: s.serviceId, confidence: s.confidence };
    })
    .sort((a, b) => b.rows - a.rows || (a.text < b.text ? -1 : 1));
  const serviceMap: Record<string, string | null> = {};
  for (const s of serviceStrings) serviceMap[s.normalized] = s.confidence >= 0.75 ? s.suggestedServiceId : null;

  if (columns.weight === null) notes.push(format === "shopify" ? "Shopify order exports carry no package weight. Orders can be priced from your product weights (upload them under Product weights) or from a weight column added to the export." : "No weight column was recognised; without weights orders cannot be priced.");
  if (columns.destinationZip === null) notes.push("No destination ZIP column was recognised; it is required.");
  if (columns.service === null) notes.push("No shipping service column was recognised; choose one service for the whole file when you run the model.");
  if (dates.ambiguous) notes.push("Dates could be month-first or day-first; confirm the format.");
  if (columns.weight !== null && !weightUnitFromHeader) notes.push("The weight column does not state its unit; confirm pounds or ounces (the preview shows the median weight under your choice).");
  if (padShortZips) notes.push("Some ZIP codes have fewer than five digits; the spreadsheet probably dropped leading zeros, so they will be padded.");

  const suggestion: OrderMapping = {
    sheet: table.name,
    headerRow: sheet.headerRow,
    format,
    columns,
    grouping,
    dateFormat: dates.format,
    weightUnit: weightUnitFromHeader ?? "lb",
    padShortZips,
    serviceMap,
    useSkuProfiles: columns.weight === null && columns.sku !== null,
    defaults: { originZip: null, residential: null },
  };
  return { format, sheets, serviceStrings, suggestion, dateFormatAmbiguous: dates.ambiguous, weightUnitFromHeader, notes };
}
