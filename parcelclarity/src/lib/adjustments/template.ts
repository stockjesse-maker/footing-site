import { ADJUSTMENT_TEMPLATE_HEADERS } from "./header-guard";

/**
 * Downloadable template for adjustment history. Every value in the two example rows is fictional and the rows say so (brand
 * "Example Brand (fictional)", package references starting EXAMPLE-, and a reason that reads "FICTIONAL EXAMPLE ROW"): the
 * importer refuses any row that still carries those markers, so the example rows can never become history. The amounts are
 * what a customer was charged, never a carrier cost.
 *
 * Columns: ship_date and adjustment_type are required, and so is a carrier (or a service that implies one). Amounts are what the
 * customer was charged for the shipment (original and corrected, without the separate adjustment fee) and the separate fee, as
 * 12.50 (no decimal commas). weight_unit is lb, oz, g or kg; dimension_unit is in or cm; dates are YYYY-MM-DD; adjustment_type is
 * reweight, remeasure, combined or correction; cause is wms_no_weight, scale_error, carrier_reweigh, carrier_remeasure,
 * packaging_change or other; handling (optional, informational) is absorbed, pass_through or manual_approval.
 */
const EXAMPLE_REASON = "FICTIONAL EXAMPLE ROW - delete before uploading";
const ROWS = [
  ["2026-01-15", "2026-01-21", "UPS", "UPS Ground", "Example Brand (fictional)", "reweight", "carrier_reweigh", EXAMPLE_REASON, "EXAMPLE-FICTIONAL-001", "3", "5", "lb", "10", "8", "6", "", "", "", "in", "12.00", "13.50", "3.00", ""],
  ["2026-01-16", "2026-01-22", "UPS", "UPS Ground", "Example Brand (fictional)", "remeasure", "carrier_remeasure", EXAMPLE_REASON, "EXAMPLE-FICTIONAL-002", "4", "4", "lb", "10", "8", "6", "14", "10", "8", "in", "12.50", "15.00", "4.00", "pass_through"],
];

export const ADJUSTMENTS_TEMPLATE_CSV = [ADJUSTMENT_TEMPLATE_HEADERS.join(","), ...ROWS.map((r) => r.join(","))].join("\n") + "\n";
export const ADJUSTMENTS_TEMPLATE_FILENAME = "parcelclarity-adjustment-history-template.csv";
