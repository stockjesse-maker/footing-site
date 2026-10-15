import Decimal from "decimal.js";
import type { Table } from "../import/parse-table";
import { serviceKey } from "./mapping";
import {
  decimalText,
  isCancelledCell,
  parseCountry,
  parseDeclaredValue,
  parseDimension,
  parseOrderDate,
  parseRequiresShipping,
  parseResidential,
  parseUnits,
  parseWeightCell,
  parseWeightUnitCell,
  parseZip,
  weightToLb,
} from "./cells";
import type { OrderImportResult, OrderIssue, OrderMapping, OrderValidationReport, ParsedOrder, ParsedOrderLine, ParsedPackage, ParsedShipment, SkuProfileInput, WeightUnitInFile } from "./types";

/**
 * Applies an approved mapping to an orders file: rows → orders → shipments → packages (+ order
 * lines). Pure. Nothing is invented: a cell that cannot be read becomes an issue on its order or
 * shipment, and every count the customer sees (rows, orders, shipments, packages, lines) is
 * derived separately. Order-level fields (date, destination, origin, residential, service) are
 * the first non-empty value across the order's rows, so Shopify-style continuation rows are fine;
 * two different non-empty values make the order inconsistent rather than picking one.
 */

const MAX_ISSUES = 500;
const D = Decimal.clone({ precision: 28, rounding: Decimal.ROUND_HALF_UP });
const PARCEL_MAX_LB = new D(150);

/** Issues that leave an order unmodelable under the mapping's defaults (a run may still exclude more or fewer; a missing origin is supplied by the run's ship-from ZIP). */
const BLOCKING: ReadonlySet<string> = new Set(["destination_missing", "destination_invalid", "destination_short", "destination_not_us", "weight_missing", "weight_invalid", "weight_unit_invalid", "service_unmapped", "service_missing", "no_packages", "nothing_to_ship", "order_inconsistent", "package_inconsistent", "origin_invalid", "order_cancelled", "sku_unknown", "value_out_of_range"]);

/** Column limits of the stored rows (orders.external_order_id, order_lines.sku, …); a longer value is refused, never truncated. */
const MAX_ID_CHARS = 120;
const MAX_WEIGHT = new Decimal("1000000");
const MAX_DIMENSION = new Decimal("1000000");

const MESSAGES: Record<string, string> = {
  order_id_missing: "Row has no order id and was skipped.",
  date_missing: "No order date or ship date; the order can only be priced at the rates of a chosen date.",
  date_invalid: "The date could not be read under the chosen date format.",
  destination_missing: "No destination ZIP code.",
  destination_invalid: "The destination ZIP code is not a 5-digit US ZIP.",
  destination_short: "The destination ZIP has fewer than five digits (leading zeros lost?); enable padding or fix the file.",
  destination_not_us: "Destination outside the US; only US addresses can be priced.",
  origin_missing: "No origin ZIP and no default origin; set the ship-from ZIP when you run the model.",
  origin_invalid: "The origin ZIP code is not a 5-digit US ZIP.",
  residential_invalid: "The residential/commercial value could not be read.",
  service_missing: "No shipping service on the shipment.",
  service_unmapped: "The shipping service in the file is not mapped to one of your rate card's services.",
  weight_missing: "No package weight.",
  weight_invalid: "The weight could not be read as a number.",
  weight_converted: "Weight was converted from grams/kilograms to pounds.",
  weight_exceeds_parcel: "Weight above 150 lb; parcel rate cards rarely cover it.",
  weight_unit_invalid: "The weight unit could not be read (use lb or oz).",
  dimensions_incomplete: "Only some dimensions were given, so dimensional weight will not be checked.",
  dimension_invalid: "A dimension could not be read as a number.",
  declared_value_invalid: "The declared value could not be read as money.",
  units_invalid: "A line quantity could not be read as a whole number.",
  no_packages: "The shipment has no package rows.",
  nothing_to_ship: "None of the order's lines require shipping (e.g. gift cards), so there is nothing to price.",
  order_inconsistent: "Rows of the same order disagree on an order-level value.",
  order_cancelled: "The order was cancelled and is not modeled.",
  rows_collapsed_to_package: "Several line rows repeat the same package; they were read as one package.",
  package_inconsistent: "Rows of the same package disagree on its weight or dimensions.",
  package_count_mismatch: "The file's package count differs from the package rows found.",
  shipment_id_missing: "Some rows of the order have no shipment id; they were read as one shipment.",
  sku_unknown: "A SKU has no product weight; the package weight could not be derived.",
  weight_derived: "Package weight derived from product weights (priced as an estimate).",
  value_out_of_range: "A value is too long or too large to store (ids and SKUs up to 120 characters; weights and dimensions below 1,000,000).",
};

interface Row {
  rowNo: number;
  cells: string[];
}

interface Field<T> {
  value: T | null;
  conflict: boolean;
}

function toLbUnit(value: string, unit: WeightUnitInFile): { weight: string; weightUnit: "lb" | "oz"; converted: boolean } {
  if (unit === "lb" || unit === "oz") return { weight: value, weightUnit: unit, converted: false };
  return { weight: decimalText(weightToLb(value, unit)), weightUnit: "lb", converted: true };
}

export function applyOrderMapping(tables: Table[], mapping: OrderMapping, opts: { skuProfiles?: SkuProfileInput[] } = {}): OrderImportResult {
  const issues: OrderIssue[] = [];
  const issueOrders = new Map<string, Set<string>>();
  // Rows the issue covers (an order-level issue covers the order's rows), shipments it covers, and its severity: all counted before the detail cap.
  const issueRows = new Map<string, number>();
  const issueShipments = new Map<string, number>();
  const severityByCode = new Map<string, OrderIssue["severity"]>();
  let dropped = 0;
  const report = (code: string, severity: OrderIssue["severity"], row: number | undefined, orderId: string | undefined, detail: string | undefined, covers: { rows: number; shipments: number }) => {
    const message = detail ? `${MESSAGES[code] ?? code} ${detail}` : (MESSAGES[code] ?? code);
    issueRows.set(code, (issueRows.get(code) ?? 0) + covers.rows);
    issueShipments.set(code, (issueShipments.get(code) ?? 0) + covers.shipments);
    if (!severityByCode.has(code) || severity === "error") severityByCode.set(code, severity);
    if (orderId) (issueOrders.get(code) ?? issueOrders.set(code, new Set()).get(code)!).add(orderId);
    if (issues.length >= MAX_ISSUES) {
      dropped++;
      return;
    }
    issues.push({ severity, code, message, row, orderId });
  };
  const profiles = new Map((opts.skuProfiles ?? []).map((p) => [p.sku.trim().toLowerCase(), p]));
  const c = mapping.columns;
  const table = tables.find((t) => t.name === mapping.sheet) ?? tables[0];
  const empty: OrderValidationReport = {
    ok: false,
    counts: { rows: 0, orders: 0, shipments: 0, packages: 0, lines: 0, units: 0 },
    modelableOrders: 0,
    issuesByCode: [],
    issues: [],
    issuesTruncated: false,
    services: [],
    weights: { count: 0, medianLb: null, p90Lb: null, over150Lb: 0 },
    derivation: { shipments: "", packages: "", lines: "" },
    dateRange: { from: null, to: null },
  };
  if (!table) return { orders: [], report: { ...empty, issues: [{ severity: "error", code: "sheet_missing", message: `Sheet "${mapping.sheet}" was not found.` }], issuesByCode: [{ code: "sheet_missing", severity: "error", orders: 0, rows: 0, shipments: 0, message: "Sheet not found." }] } };

  const cell = (row: Row, idx: number | null | undefined) => (idx === null || idx === undefined ? "" : (row.cells[idx] ?? "").trim());

  // 1. Rows → order groups, in first-appearance order.
  const groups = new Map<string, Row[]>();
  let rowCount = 0;
  for (let i = mapping.headerRow + 1; i < table.rows.length; i++) {
    const cells = table.rows[i]!;
    if (cells.every((x) => x === "")) continue;
    rowCount++;
    const row: Row = { rowNo: i + 1, cells };
    const id = cell(row, c.orderId);
    if (!id) {
      report("order_id_missing", "error", row.rowNo, undefined, undefined, { rows: 1, shipments: 0 });
      continue;
    }
    groups.set(id, [...(groups.get(id) ?? []), row]);
  }

  /** First non-empty value across rows; a second, different non-empty value is a conflict. */
  const firstOf = <T>(rows: Row[], idx: number | null | undefined, parse: (raw: string) => T | null): Field<T> => {
    let value: T | null = null;
    let conflict = false;
    for (const r of rows) {
      const raw = cell(r, idx);
      if (!raw) continue;
      const v = parse(raw);
      if (v === null) continue;
      if (value === null) value = v;
      else if (JSON.stringify(v) !== JSON.stringify(value)) conflict = true;
    }
    return { value, conflict };
  };

  const orders: ParsedOrder[] = [];
  const serviceCounts = new Map<string, { text: string; rows: number }>();
  const packageWeightsLb: Decimal[] = [];
  let over150 = 0;
  let convertedNoted = false;
  const dates: string[] = [];

  for (const [externalOrderId, rows] of groups) {
    const orderIssues = new Set<string>();
    const flag = (code: string, severity: OrderIssue["severity"] = "error", row?: number, detail?: string) => {
      if (!orderIssues.has(code)) report(code, severity, row, externalOrderId, detail, { rows: rows.length, shipments: 0 });
      orderIssues.add(code);
    };
    if (externalOrderId.length > MAX_ID_CHARS) flag("value_out_of_range", "error", rows[0]!.rowNo, "(order id)");
    const inconsistent = (what: string) => flag("order_inconsistent", "error", rows[0]!.rowNo, `(${what})`);

    const orderDate = firstOf(rows, c.orderDate, (raw) => {
      const d = parseOrderDate(raw, mapping.dateFormat);
      if (d === "invalid") flag("date_invalid", "warning", undefined, `("${raw}")`);
      return d === "invalid" ? null : d;
    });
    if (orderDate.conflict) inconsistent("order date");

    const destination = firstOf(rows, c.destinationZip, (raw) => {
      const z = parseZip(raw, mapping.padShortZips);
      if (z.status === "invalid") flag("destination_invalid", "error", undefined, `("${raw}")`);
      if (z.status === "short") flag("destination_short", "error", undefined, `("${raw}")`);
      return z.status === "ok" ? z.zip : null;
    });
    if (destination.conflict) inconsistent("destination ZIP");
    const country = firstOf(rows, c.country, parseCountry);
    if (country.value === "other") flag("destination_not_us");
    else if (destination.value === null && !orderIssues.has("destination_invalid") && !orderIssues.has("destination_short")) flag("destination_missing");

    const origin = firstOf(rows, c.originZip, (raw) => {
      const z = parseZip(raw, mapping.padShortZips);
      if (z.status !== "ok") flag("origin_invalid", "error", undefined, `("${raw}")`);
      return z.status === "ok" ? z.zip : null;
    });
    if (origin.conflict) inconsistent("origin ZIP");
    if (origin.value === null && !mapping.defaults.originZip && !orderIssues.has("origin_invalid")) flag("origin_missing", "warning");

    const residential = firstOf(rows, c.residential, (raw) => {
      const r = parseResidential(raw);
      if (r === "invalid") flag("residential_invalid", "warning", undefined, `("${raw}")`);
      return r === "invalid" ? null : r;
    });
    if (residential.conflict) inconsistent("residential flag");
    const cancelled = rows.some((r) => isCancelledCell(cell(r, c.cancelled)));
    if (cancelled) flag("order_cancelled", "warning");

    // 2. Order lines (sku / units), with Shopify's "requires shipping" deciding what contributes to shipped weight.
    const lines: ParsedOrderLine[] = [];
    const shippable: { sku: string | null; units: number }[] = [];
    if (c.sku !== null || c.units !== null) {
      for (const r of rows) {
        const sku = cell(r, c.sku) || null;
        const unitsRaw = cell(r, c.units);
        if (!sku && !unitsRaw) continue;
        const units = unitsRaw ? parseUnits(unitsRaw) : 1;
        if (units === "invalid") {
          flag("units_invalid", "warning", r.rowNo, `("${unitsRaw}")`);
          continue;
        }
        if (sku && sku.length > MAX_ID_CHARS) flag("value_out_of_range", "error", r.rowNo, "(SKU)");
        const line = { lineNo: lines.length + 1, sku, units: units ?? 1 };
        lines.push(line);
        const requires = c.requiresShipping === null || c.requiresShipping === undefined ? null : parseRequiresShipping(cell(r, c.requiresShipping));
        if (requires !== false) shippable.push({ sku, units: line.units });
      }
    }
    const units = lines.length ? shippable.reduce((n, l) => n + l.units, 0) : null;

    // 3. Shipments. An order whose lines all say "no shipping" (gift cards) has nothing to price.
    let shipmentGroups: Row[][];
    if (lines.length && !shippable.length) {
      flag("nothing_to_ship", "warning");
      shipmentGroups = [];
    } else if (mapping.grouping.shipments === "one_per_row") shipmentGroups = rows.map((r) => [r]);
    else if (mapping.grouping.shipments === "by_shipment_id" && c.shipmentId !== null) {
      // A row without a shipment id continues the shipment above it (exports often fill the id on the
      // first row only); a leading blank row forms its own shipment.
      const byId = new Map<string, Row[]>();
      let blank = false;
      let lastId = "";
      for (const r of rows) {
        let id = cell(r, c.shipmentId);
        if (!id) {
          blank = true;
          id = lastId;
        } else lastId = id;
        byId.set(id, [...(byId.get(id) ?? []), r]);
      }
      if (blank) flag("shipment_id_missing", "warning");
      shipmentGroups = [...byId.values()];
    } else shipmentGroups = [rows];

    const shipments: ParsedShipment[] = [];
    for (const srows of shipmentGroups) {
      const seq = shipments.length + 1;
      const shipmentIssues = new Set<string>();
      const sflag = (code: string, severity: OrderIssue["severity"] = "error", row?: number, detail?: string) => {
        if (!shipmentIssues.has(code) && !orderIssues.has(code)) report(code, severity, row, externalOrderId, detail, { rows: srows.length, shipments: 1 });
        shipmentIssues.add(code);
      };
      const shipmentIdCell = c.shipmentId === null ? "" : cell(srows[0]!, c.shipmentId);
      if (shipmentIdCell.length > MAX_ID_CHARS) sflag("value_out_of_range", "error", srows[0]!.rowNo, "(shipment id)");
      const shipDate = firstOf(srows, c.shipDate, (raw) => {
        const d = parseOrderDate(raw, mapping.dateFormat);
        if (d === "invalid") sflag("date_invalid", "warning", undefined, `("${raw}")`);
        return d === "invalid" ? null : d;
      });
      const serviceText = firstOf(srows, c.service, (raw) => raw).value;
      const carrierText = firstOf(srows, c.carrier, (raw) => raw).value;
      let serviceId: string | null = null;
      if (serviceText) {
        const key = serviceKey(carrierText, serviceText);
        const entry = serviceCounts.get(key) ?? { text: carrierText ? `${carrierText} ${serviceText}` : serviceText, rows: 0 };
        entry.rows += srows.length;
        serviceCounts.set(key, entry);
        serviceId = mapping.serviceMap[key] ?? null;
        if (!serviceId) sflag("service_unmapped", "error", undefined, `("${serviceText}")`);
      } else sflag("service_missing");
      const sDest = firstOf(srows, c.destinationZip, (raw) => (parseZip(raw, mapping.padShortZips).status === "ok" ? (parseZip(raw, mapping.padShortZips) as { zip: string }).zip : null)).value;
      const sOrigin = firstOf(srows, c.originZip, (raw) => (parseZip(raw, mapping.padShortZips).status === "ok" ? (parseZip(raw, mapping.padShortZips) as { zip: string }).zip : null)).value;
      const sResidential = firstOf(srows, c.residential, (raw) => (parseResidential(raw) === "invalid" ? null : parseResidential(raw) as boolean | null)).value;

      // 4. Packages.
      const packageRows = (() => {
        if (mapping.grouping.packages === "one_per_row") return srows.map((r) => [r]);
        if (mapping.grouping.packages === "one_per_shipment") return [srows];
        // With line columns, rows that repeat a package's id or its weight/dimensions are the same package
        // (one row per item); without them every row with package data is its own package. A row with
        // no package data at all (an item listed under the package above, as the template allows) continues
        // the previous package rather than becoming a weightless one.
        const hasLineColumns = c.sku !== null || c.units !== null;
        const byKey = new Map<string, Row[]>();
        let lastKey: string | null = null;
        for (const r of srows) {
          const id = cell(r, c.packageId);
          const signature = [cell(r, c.weight), cell(r, c.weightUnit), cell(r, c.length), cell(r, c.width), cell(r, c.height), cell(r, c.packaging)].join("|");
          let key: string;
          if (id) key = `id:${id}`;
          else if (signature === "|||||" && lastKey !== null) key = lastKey;
          else key = hasLineColumns ? `sig:${signature}` : `row:${r.rowNo}`;
          byKey.set(key, [...(byKey.get(key) ?? []), r]);
          lastKey = key;
        }
        return [...byKey.values()];
      })();

      const packages: ParsedPackage[] = [];
      let collapsed = false;
      for (const prows of packageRows) {
        const first = prows.find((r) => cell(r, c.weight)) ?? prows[0]!;
        if (prows.length > 1 && mapping.grouping.packages === "by_package_columns") collapsed = true;
        if (prows.length > 1 && cell(prows[0]!, c.packageId)) {
          const signatures = new Set(prows.map((r) => [cell(r, c.weight), cell(r, c.length), cell(r, c.width), cell(r, c.height)].join("|")).filter((s) => s !== "|||"));
          if (signatures.size > 1) sflag("package_inconsistent", "error", first.rowNo);
        }
        const weightRaw = cell(first, c.weight);
        let weight: string | null = null;
        let weightUnit: "lb" | "oz" = mapping.weightUnit === "oz" ? "oz" : "lb";
        if (weightRaw) {
          const w = parseWeightCell(weightRaw);
          if (w === "invalid" || w === null) sflag("weight_invalid", "error", first.rowNo, `("${weightRaw}")`);
          else {
            const unitCell = cell(first, c.weightUnit);
            const fromCell = unitCell ? parseWeightUnitCell(unitCell) : null;
            if (fromCell === "invalid") sflag("weight_unit_invalid", "error", first.rowNo, `("${unitCell}")`);
            else {
              const unit = w.unit ?? fromCell ?? mapping.weightUnit;
              const lb = toLbUnit(w.value, unit);
              weight = lb.weight;
              weightUnit = lb.weightUnit;
              if (lb.converted && !convertedNoted) {
                convertedNoted = true;
                report("weight_converted", "warning", first.rowNo, undefined, undefined, { rows: 1, shipments: 0 });
              }
              if (/[1-9]/.test(weight) && (new D(weight).greaterThanOrEqualTo(MAX_WEIGHT) || new D(weight).toDecimalPlaces(6).isZero())) {
                sflag("value_out_of_range", "error", first.rowNo, `(weight "${weightRaw}")`);
                weight = null;
              } else if (/[1-9]/.test(weight)) {
                const inLb = weightToLb(weight, weightUnit);
                packageWeightsLb.push(inLb);
                if (inLb.greaterThan(PARCEL_MAX_LB)) {
                  over150++;
                  sflag("weight_exceeds_parcel", "warning", first.rowNo);
                }
              } else weight = null;
            }
          }
        }
        const dims = [c.length, c.width, c.height].map((idx) => {
          const raw = cell(first, idx);
          let d = raw ? parseDimension(raw) : null;
          if (d !== null && d !== "invalid" && (new D(d).greaterThanOrEqualTo(MAX_DIMENSION) || new D(d).toDecimalPlaces(4).isZero())) d = "invalid";
          if (d === "invalid") sflag("dimension_invalid", "warning", first.rowNo, `("${raw}")`);
          return d === "invalid" ? null : d;
        });
        const given = dims.filter((d) => d !== null).length;
        if (given !== 0 && given !== 3) sflag("dimensions_incomplete", "warning", first.rowNo);
        const declaredRaw = cell(first, c.declaredValue);
        const declared = declaredRaw ? parseDeclaredValue(declaredRaw) : null;
        if (declared === "invalid") sflag("declared_value_invalid", "warning", first.rowNo, `("${declaredRaw}")`);
        packages.push({
          seq: packages.length + 1,
          weight,
          weightUnit,
          length: given === 3 ? dims[0]! : null,
          width: given === 3 ? dims[1]! : null,
          height: given === 3 ? dims[2]! : null,
          declaredValue: declared === "invalid" ? null : declared,
          packagingType: cell(first, c.packaging) || null,
          weightDerived: false,
          dimensionsDerived: false,
        });
      }
      if (collapsed) sflag("rows_collapsed_to_package", "warning", srows[0]!.rowNo);

      // Derive a missing weight from product weights when the whole order ships as this one package.
      if (mapping.useSkuProfiles && packages.length === 1 && packages[0]!.weight === null && shipmentGroups.length === 1 && shippable.length && orderIssues.has("units_invalid")) {
        sflag("weight_missing", "error", undefined, "(a line quantity could not be read, so the weight could not be derived from product weights)");
      } else if (mapping.useSkuProfiles && packages.length === 1 && packages[0]!.weight === null && shipmentGroups.length === 1 && shippable.length) {
        let total = new D(0);
        let known = true;
        for (const l of shippable) {
          const p = l.sku ? profiles.get(l.sku.trim().toLowerCase()) : undefined;
          if (!p) {
            known = false;
            sflag("sku_unknown", "error", undefined, l.sku ? `("${l.sku}")` : "(line without SKU)");
            break;
          }
          total = total.plus(new D(p.unitWeightLb).times(l.units));
        }
        if (known && total.greaterThan(0)) {
          const pkg = packages[0]!;
          pkg.weight = decimalText(total);
          pkg.weightUnit = "lb";
          pkg.weightDerived = true;
          packageWeightsLb.push(total);
          if (total.greaterThan(PARCEL_MAX_LB)) over150++;
          const single = shippable.length === 1 && shippable[0]!.units === 1 ? profiles.get(shippable[0]!.sku?.trim().toLowerCase() ?? "") : undefined;
          if (single?.lengthIn && single.widthIn && single.heightIn && pkg.length === null) {
            pkg.length = single.lengthIn;
            pkg.width = single.widthIn;
            pkg.height = single.heightIn;
            pkg.dimensionsDerived = true;
          }
          sflag("weight_derived", "warning");
        }
      }
      if (!packages.length) sflag("no_packages");
      else if (packages.some((p) => p.weight === null) && !shipmentIssues.has("weight_invalid") && !shipmentIssues.has("sku_unknown") && !shipmentIssues.has("value_out_of_range")) sflag("weight_missing");

      if (c.packageCount !== null && c.packageCount !== undefined) {
        const declaredCount = parseUnits(cell(srows[0]!, c.packageCount));
        if (typeof declaredCount === "number" && declaredCount !== packages.length) sflag("package_count_mismatch", "warning", srows[0]!.rowNo, `(file says ${declaredCount}, found ${packages.length})`);
      }

      shipments.push({
        seq,
        externalShipmentId: c.shipmentId === null ? null : cell(srows[0]!, c.shipmentId) || null,
        serviceText,
        serviceId,
        originZip: sOrigin ?? origin.value,
        destinationZip: sDest ?? destination.value,
        shipDate: shipDate.value,
        residential: sResidential ?? residential.value,
        issues: [...shipmentIssues],
        packages,
        sourceRows: srows.map((r) => r.rowNo),
      });
      if (shipDate.value) dates.push(shipDate.value);
    }
    if (!orderDate.value && !shipments.some((s) => s.shipDate)) flag("date_missing", "warning");
    if (orderDate.value) dates.push(orderDate.value);

    orders.push({
      externalOrderId,
      orderDate: orderDate.value,
      destinationZip: destination.value,
      originZip: origin.value,
      residential: residential.value,
      units,
      cancelled,
      issues: [...orderIssues],
      lines,
      shipments,
      sourceRows: rows.map((r) => r.rowNo),
    });
  }

  // 5. Report.
  const blocking = (o: ParsedOrder) => o.issues.some((i) => BLOCKING.has(i)) || o.shipments.some((s) => s.issues.some((i) => BLOCKING.has(i)));
  const counts = {
    rows: rowCount,
    orders: orders.length,
    shipments: orders.reduce((n, o) => n + o.shipments.length, 0),
    packages: orders.reduce((n, o) => n + o.shipments.reduce((m, s) => m + s.packages.length, 0), 0),
    lines: orders.reduce((n, o) => n + o.lines.length, 0),
    units: orders.reduce((n, o) => n + (o.units ?? 0), 0),
  };
  const sortedLb = [...packageWeightsLb].sort((a, b) => a.comparedTo(b));
  // The median averages the two middle values for an even count; p90 is nearest-rank.
  const median = () => {
    const n = sortedLb.length;
    if (!n) return null;
    return decimalText(n % 2 ? sortedLb[(n - 1) / 2]! : sortedLb[n / 2 - 1]!.plus(sortedLb[n / 2]!).div(2), 3);
  };
  const quantile = (q: number) => (sortedLb.length ? decimalText(sortedLb[Math.min(sortedLb.length - 1, Math.floor(q * sortedLb.length))]!, 3) : null);
  const codes = [...new Set([...issueRows.keys()])];
  const issuesByCode = codes
    .map((code) => ({ code, severity: severityByCode.get(code) ?? "warning", orders: issueOrders.get(code)?.size ?? 0, rows: issueRows.get(code) ?? 0, shipments: issueShipments.get(code) ?? 0, message: MESSAGES[code] ?? code }))
    .sort((a, b) => b.orders - a.orders || b.rows - a.rows || (a.code < b.code ? -1 : 1));
  const shipmentsHow =
    mapping.grouping.shipments === "by_shipment_id" ? "one shipment per distinct shipment id within an order"
    : mapping.grouping.shipments === "one_per_row" ? "each row is one shipment"
    : "one shipment per order (the file has no shipment ids)";
  const packagesHow =
    mapping.grouping.packages === "one_per_row" ? "each row is one package"
    : mapping.grouping.packages === "one_per_shipment" ? "one package per shipment (the file has no package columns)"
    : c.packageId !== null ? "one package per package id within a shipment" : "one package per distinct weight and dimensions within a shipment; line rows that repeat them are the same package";
  const linesHow = c.sku !== null || c.units !== null ? "one line per row with a SKU or quantity" : "the file has no line columns";
  const sortedDates = [...dates].sort();

  return {
    orders,
    report: {
      ok: orders.length > 0,
      counts,
      modelableOrders: orders.filter((o) => !blocking(o)).length,
      issuesByCode,
      issues,
      issuesTruncated: dropped > 0,
      services: [...serviceCounts.entries()].map(([normalized, e]) => ({ text: e.text, normalized, rows: e.rows, mappedTo: mapping.serviceMap[normalized] ?? null })).sort((a, b) => b.rows - a.rows),
      weights: { count: sortedLb.length, medianLb: median(), p90Lb: quantile(0.9), over150Lb: over150 },
      derivation: { shipments: shipmentsHow, packages: packagesHow, lines: linesHow },
      dateRange: { from: sortedDates[0] ?? null, to: sortedDates[sortedDates.length - 1] ?? null },
    },
  };
}
