import { NextResponse, type NextRequest } from "next/server";
import { getContext, getUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/permissions";
import { uuidSchema } from "@/lib/auth/validation";
import { createClient } from "@/lib/supabase/server";

export const maxDuration = 60;

/**
 * Shipment-level export of a completed run, streamed 1,000 rows at a time under the caller's Row
 * Level Security. Customer-facing columns only: no rule keys, ids or 3PL internals, and every
 * amount is labelled by what it is (from the rate card, based on assumptions, may be added after
 * shipping, could not be decided). `in_totals` says whether the row is part of the headline
 * figures (an order counts only when every one of its shipments priced), so the file reconciles
 * with the page. Text the customer's own file supplied is neutralised against spreadsheet formulas.
 */

const PAGE = 1000;

const REASON: Record<string, string> = {
  order_cancelled: "Order cancelled",
  date_missing: "No date",
  destination_missing: "No destination ZIP",
  origin_missing: "No origin ZIP",
  service_unmapped: "Service not mapped",
  weight_missing: "No package weight",
  order_inconsistent: "Rows disagree",
  package_inconsistent: "Package rows disagree",
  destination_invalid: "Destination ZIP unreadable",
  destination_not_us: "Destination outside the US",
  weight_invalid: "Weight unreadable",
  nothing_to_ship: "Nothing to ship",
  sku_unknown: "Product weight missing",
  value_out_of_range: "Value too long or too large",
  no_packages: "No packages",
  service_not_on_rate_card: "Service not on rate card",
  zone_unresolved: "Destination not in zone chart",
  zone_ambiguous: "Zone could not be decided",
  no_rate_for_weight: "Heavier than the top bracket",
  no_rate_for_zone: "No rate for zone",
  no_rate_for_origin: "No rate from origin",
  rate_card_not_effective: "No rates on that date",
  invalid_input: "Value could not be priced",
};

/** Quotes for CSV. */
const csvCell = (v: string | null | undefined) => {
  const s = v ?? "";
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Text from the uploaded file: a leading =, +, -, @ or tab would run as a formula in a spreadsheet, so it is prefixed with an apostrophe. */
const textCell = (v: string | null | undefined) => {
  const s = v ?? "";
  return csvCell(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);
};

interface Row {
  row_no: number;
  status: string;
  unavailable_reason: string | null;
  ship_date: string | null;
  zone: string | null;
  billable_lb: string[] | null;
  definite: string | number;
  estimated: string | number;
  expected: string | number;
  conditional_exposure: string | number;
  unresolved: string | number;
  in_totals: boolean;
  shipments: {
    external_shipment_id: string | null;
    origin_zip: string | null;
    destination_zip: string | null;
    ship_date: string | null;
    orders: { external_order_id: string; origin_zip: string | null; destination_zip: string | null; order_date: string | null } | null;
  } | null;
  shipping_services: { name: string } | null;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const user = await getUser();
  const ctx = user ? await getContext() : null;
  if (!ctx || !can(ctx.active.role, "simulation.run") || !uuidSchema.safeParse(runId).success) return new NextResponse("Not found", { status: 404 });
  const supabase = await createClient();
  const { data: run } = await supabase.from("simulation_runs").select("id, tenant_id, brand_id, status, kind, simulation_projects(name, rate_cards(name))").eq("id", runId).maybeSingle();
  if (!run || run.tenant_id !== ctx.active.tenantId || run.status !== "completed" || run.kind !== "bulk") return new NextResponse("Not found", { status: 404 });
  if (ctx.active.portal === "brand" && run.brand_id !== ctx.active.brandId) return new NextResponse("Not found", { status: 404 });
  const brandParam = request.nextUrl.searchParams.get("brandId");
  if (ctx.active.portal === "tenant" && brandParam && brandParam !== run.brand_id) return new NextResponse("Not found", { status: 404 });
  const project = run.simulation_projects as unknown as { name: string; rate_cards: { name: string } | null } | null;

  // Exports of customer order data are audited; a failed audit write refuses the export.
  const { error: auditError } = await supabase.rpc("log_audit_event", {
    p_tenant: run.tenant_id,
    p_brand: run.brand_id,
    p_action: "export.run_results",
    p_entity_type: "simulation_run",
    p_entity_id: runId,
    p_metadata: { kind: "shipment_csv" },
  });
  if (auditError) return new NextResponse("Export unavailable", { status: 503 });

  const encoder = new TextEncoder();
  const header = ["order_id", "shipment_id", "ship_date", "rates_of", "origin_zip", "destination_zip", "zone", "service", "billable_lb", "estimated_total", "from_rate_card", "based_on_assumptions", "may_be_added_after_shipping", "could_not_be_decided", "status", "in_totals", "reason"];
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(`# Estimates from ${csvCell(project?.rate_cards?.name ?? "your rate card")} for "${project?.name ?? "model"}", not an invoice. Amounts in USD. in_totals = yes marks the rows summed into the headline figures.\r\n`));
      controller.enqueue(encoder.encode(`${header.join(",")}\r\n`));
      let from = 0;
      for (;;) {
        const { data, error } = await supabase
          .from("simulation_results")
          .select(
            "row_no, status, unavailable_reason, ship_date, zone, billable_lb, definite, estimated, expected, conditional_exposure, unresolved, in_totals, shipments(external_shipment_id, origin_zip, destination_zip, ship_date, orders(external_order_id, origin_zip, destination_zip, order_date)), shipping_services(name)",
          )
          .eq("run_id", runId)
          .order("row_no")
          .range(from, from + PAGE - 1)
          .overrideTypes<Row[], { merge: false }>();
        if (error) {
          controller.error(new Error(error.message));
          return;
        }
        for (const r of data ?? []) {
          const ok = r.status === "ok";
          const line = [
            textCell(r.shipments?.orders?.external_order_id ?? ""),
            textCell(r.shipments?.external_shipment_id ?? ""),
            csvCell(r.shipments?.ship_date ?? r.shipments?.orders?.order_date ?? ""),
            csvCell(r.ship_date ?? ""),
            csvCell(r.shipments?.origin_zip ?? r.shipments?.orders?.origin_zip ?? ""),
            csvCell(r.shipments?.destination_zip ?? r.shipments?.orders?.destination_zip ?? ""),
            csvCell(r.zone ?? ""),
            textCell(r.shipping_services?.name ?? ""),
            csvCell(r.billable_lb?.join("+") ?? ""),
            csvCell(ok ? String(r.expected) : ""),
            csvCell(ok ? String(r.definite) : ""),
            csvCell(ok ? String(r.estimated) : ""),
            csvCell(ok ? String(r.conditional_exposure) : ""),
            csvCell(ok ? String(r.unresolved) : ""),
            csvCell(ok ? "priced" : "not priced"),
            csvCell(r.in_totals ? "yes" : "no"),
            textCell(ok ? (r.in_totals ? "" : "Another shipment of this order could not be priced") : (REASON[r.unavailable_reason ?? ""] ?? r.unavailable_reason ?? "")),
          ];
          controller.enqueue(encoder.encode(`${line.join(",")}\r\n`));
        }
        if (!data || data.length < PAGE) break;
        from += PAGE;
      }
      controller.close();
    },
  });
  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="parcelclarity-model-${runId.slice(0, 8)}.csv"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
