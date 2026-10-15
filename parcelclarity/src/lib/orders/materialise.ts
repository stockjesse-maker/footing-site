import type { MaterialisePayload, ParsedOrder } from "./types";

/**
 * Turns validated orders into the row chunks `public.materialise_order_rows()` accepts. Every
 * shipment gets a dense, dataset-wide `row_no` (the batch cursor of a run): orders are contiguous
 * and ordered by their first ship date (then order date, then id), so a pricing batch spans as few
 * ship dates as possible. Chunks hold whole orders.
 */

const LAST = "9999-12-31";

function firstDate(order: ParsedOrder): string {
  const shipDates = order.shipments.map((s) => s.shipDate).filter((d): d is string => d !== null).sort();
  return shipDates[0] ?? order.orderDate ?? LAST;
}

export function buildMaterialisePayloads(orders: ParsedOrder[], chunkOrders = 5000): MaterialisePayload[] {
  const sorted = [...orders].sort((a, b) => {
    const da = firstDate(a);
    const db = firstDate(b);
    if (da !== db) return da < db ? -1 : 1;
    return a.externalOrderId < b.externalOrderId ? -1 : a.externalOrderId > b.externalOrderId ? 1 : 0;
  });
  const payloads: MaterialisePayload[] = [];
  let rowNo = 0;
  for (let i = 0; i < sorted.length; i += chunkOrders) {
    const chunk = sorted.slice(i, i + chunkOrders);
    const payload: MaterialisePayload = { orders: [], lines: [], shipments: [], packages: [] };
    for (const o of chunk) {
      payload.orders.push({
        external_order_id: o.externalOrderId,
        order_date: o.orderDate,
        destination_zip: o.destinationZip,
        origin_zip: o.originZip,
        residential: o.residential,
        units: o.units,
        line_count: o.lines.length,
        cancelled: o.cancelled,
        issues: o.issues,
      });
      for (const l of o.lines) payload.lines.push({ external_order_id: o.externalOrderId, line_no: l.lineNo, sku: l.sku, units: l.units });
      for (const s of o.shipments) {
        rowNo++;
        payload.shipments.push({
          external_order_id: o.externalOrderId,
          seq: s.seq,
          row_no: rowNo,
          external_shipment_id: s.externalShipmentId,
          service_text: s.serviceText === null ? null : s.serviceText.slice(0, 160),
          service_id: s.serviceId,
          origin_zip: s.originZip,
          destination_zip: s.destinationZip,
          ship_date: s.shipDate,
          residential: s.residential,
          issues: s.issues,
        });
        for (const p of s.packages) {
          payload.packages.push({
            external_order_id: o.externalOrderId,
            shipment_seq: s.seq,
            seq: p.seq,
            weight: p.weight,
            weight_unit: p.weightUnit,
            length_in: p.length,
            width_in: p.width,
            height_in: p.height,
            declared_value: p.declaredValue,
            packaging_type: p.packagingType === null ? null : p.packagingType.slice(0, 60),
            weight_derived: p.weightDerived,
            dimensions_derived: p.dimensionsDerived,
          });
        }
      }
    }
    payloads.push(payload);
  }
  return payloads;
}
