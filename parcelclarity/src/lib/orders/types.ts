/**
 * Order-file import contracts (Milestone 3). The mapping is what the customer approves in the
 * wizard; validation turns the file into orders → shipments → packages (+ order lines) without
 * inventing values, and reports every row it could not use. Pure: no I/O, no framework imports.
 */

export type OrderFileFormat = "generic" | "shopify" | "shiphero";

/** How rows become shipments and packages. Detection proposes one; the customer confirms it. */
export interface OrderGrouping {
  /** by_shipment_id: distinct shipment id within the order; one_per_order: all rows of an order are one shipment; one_per_row: each row is its own shipment. */
  shipments: "by_shipment_id" | "one_per_order" | "one_per_row";
  /** by_package_columns: a package per distinct (package id | package seq | tracking) within the shipment, rows that differ only in line columns collapse into one package; one_per_shipment: one package per shipment; one_per_row: each row is a package. */
  packages: "by_package_columns" | "one_per_shipment" | "one_per_row";
}

export interface OrderColumnMap {
  orderId: number;
  shipmentId: number | null;
  packageId: number | null;
  orderDate: number | null;
  shipDate: number | null;
  originZip: number | null;
  destinationZip: number | null;
  country: number | null;
  residential: number | null;
  carrier: number | null;
  service: number | null;
  weight: number | null;
  weightUnit: number | null;
  length: number | null;
  width: number | null;
  height: number | null;
  declaredValue: number | null;
  sku: number | null;
  units: number | null;
  packaging: number | null;
  /** A "cancelled at" timestamp or a status column whose value 'cancelled' excludes the order. */
  cancelled: number | null;
  /** Shopify "Lineitem requires shipping": a row reading false is an order line with nothing to ship (no package). */
  requiresShipping?: number | null;
  /** A per-shipment package count (ShipHero "Package Count"); reported when it disagrees with the package rows, never used to invent packages. */
  packageCount?: number | null;
}

export type WeightUnitInFile = "lb" | "oz" | "g" | "kg";

export interface OrderMapping {
  sheet: string;
  headerRow: number;
  format: OrderFileFormat;
  columns: OrderColumnMap;
  grouping: OrderGrouping;
  /** Calendar dates are read as written; timestamps keep their own offset (never converted to UTC). */
  dateFormat: "iso" | "mdy" | "dmy";
  /** Unit when neither the header nor the cell states one. Grams/kilograms are converted to pounds (6 decimals, HALF_UP). */
  weightUnit: WeightUnitInFile;
  /** Spreadsheets drop leading zeros: pad 3–4 digit ZIPs to five. */
  padShortZips: boolean;
  /** Normalised service text → shipping_services.id, or null for "not mapped" (excluded unless the run uses an override). */
  serviceMap: Record<string, string | null>;
  /** Derive missing package weights/dimensions from the brand's product weights (sku_profiles). */
  useSkuProfiles: boolean;
  defaults: {
    /** Applied when the row has no origin; priced as an assumption (estimate). */
    originZip: string | null;
    /** Applied when the row has no residential flag; priced as an assumption (estimate). null = ask/none. */
    residential: boolean | null;
  };
}

/** A product weight used to derive package weights when the file carries none. */
export interface SkuProfileInput {
  sku: string;
  unitWeightLb: string;
  lengthIn: string | null;
  widthIn: string | null;
  heightIn: string | null;
}

export interface ParsedPackage {
  seq: number;
  weight: string | null;
  weightUnit: "lb" | "oz";
  length: string | null;
  width: string | null;
  height: string | null;
  declaredValue: string | null;
  packagingType: string | null;
  weightDerived: boolean;
  dimensionsDerived: boolean;
}

export interface ParsedShipment {
  seq: number;
  externalShipmentId: string | null;
  serviceText: string | null;
  /** Resolved through mapping.serviceMap; null when unmapped. */
  serviceId: string | null;
  originZip: string | null;
  destinationZip: string | null;
  shipDate: string | null;
  residential: boolean | null;
  issues: string[];
  packages: ParsedPackage[];
  /** 1-based source rows that contributed to this shipment. */
  sourceRows: number[];
}

export interface ParsedOrderLine {
  lineNo: number;
  sku: string | null;
  units: number;
}

export interface ParsedOrder {
  externalOrderId: string;
  orderDate: string | null;
  destinationZip: string | null;
  originZip: string | null;
  residential: boolean | null;
  units: number | null;
  cancelled: boolean;
  issues: string[];
  lines: ParsedOrderLine[];
  shipments: ParsedShipment[];
  sourceRows: number[];
}

export interface OrderIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  row?: number;
  orderId?: string;
}

export interface OrderValidationReport {
  /** False only when nothing usable was found (no orders) or the mapping cannot be applied. */
  ok: boolean;
  counts: { rows: number; orders: number; shipments: number; packages: number; lines: number; units: number };
  /** Orders with no validation issue under the mapping's defaults (a run may still exclude more or fewer). */
  modelableOrders: number;
  issuesByCode: Array<{ code: string; severity: "error" | "warning"; orders: number; rows: number; message: string }>;
  issues: OrderIssue[];
  issuesTruncated: boolean;
  /** Distinct service strings and how often they occur, for the service-map step. */
  services: Array<{ text: string; normalized: string; rows: number; mappedTo: string | null }>;
  /** Weight distribution under the chosen unit, so a wrong default is visible ("median 12.0 lb: if these are ounces choose oz"). */
  weights: { count: number; medianLb: string | null; p90Lb: string | null; over150Lb: number };
  /** Plain-language derivation of each count, shown under "Does this look right?". */
  derivation: { shipments: string; packages: string; lines: string };
  dateRange: { from: string | null; to: string | null };
}

export interface OrderImportResult {
  orders: ParsedOrder[];
  report: OrderValidationReport;
}

/** Rows handed to public.materialise_order_rows(), one chunk of whole orders at a time. */
export interface MaterialisePayload {
  orders: Array<{ external_order_id: string; order_date: string | null; destination_zip: string | null; origin_zip: string | null; residential: boolean | null; units: number | null; line_count: number; cancelled: boolean; issues: string[] }>;
  lines: Array<{ external_order_id: string; line_no: number; sku: string | null; units: number }>;
  shipments: Array<{ external_order_id: string; seq: number; row_no: number; external_shipment_id: string | null; service_text: string | null; service_id: string | null; origin_zip: string | null; destination_zip: string | null; ship_date: string | null; residential: boolean | null; issues: string[] }>;
  packages: Array<{ external_order_id: string; shipment_seq: number; seq: number; weight: string | null; weight_unit: "lb" | "oz"; length_in: string | null; width_in: string | null; height_in: string | null; declared_value: string | null; packaging_type: string | null; weight_derived: boolean; dimensions_derived: boolean }>;
}
