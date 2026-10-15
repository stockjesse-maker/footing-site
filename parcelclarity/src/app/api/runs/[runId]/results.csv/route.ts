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
 * shipping, could not be decided).
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

const csvCell = (v: string | null | undefined) => {
  const s = v ?? "";
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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
  shipments: { external_shipment_id: string | null; origin_zip: string | null; destination_zip: string | null; orders: { external_order_id: string; origin_zip: string | null; destination_zip: string | null } | null } | null;
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

  const encoder = new TextEncoder();
  const header = ["order_id", "shipment_id", "ship_date", "origin_zip", "destination_zip", "zone", "service", "billable_lb", "estimated_total", "from_rate_card", "based_on_assumptions", "may_be_added_after_shipping", "could_not_be_decided", "status", "reason"];
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(`# Estimates from ${csvCell(project?.rate_cards?.name ?? "your rate card")} for "${project?.name ?? "model"}", not an invoice. Amounts in USD.\r\n`));
      controller.enqueue(encoder.encode(`${header.join(",")}\r\n`));
      let from = 0;
      for (;;) {
        const { data, error } = await supabase
          .from("simulation_results")
          .select("row_no, status, unavailable_reason, ship_date, zone, billable_lb, definite, estimated, expected, conditional_exposure, unresolved, shipments(external_shipment_id, origin_zip, destination_zip, orders(external_order_id, origin_zip, destination_zip)), shipping_services(name)")
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
            r.shipments?.orders?.external_order_id ?? "",
            r.shipments?.external_shipment_id ?? "",
            r.ship_date ?? "",
            r.shipments?.origin_zip ?? r.shipments?.orders?.origin_zip ?? "",
            r.shipments?.destination_zip ?? r.shipments?.orders?.destination_zip ?? "",
            r.zone ?? "",
            r.shipping_services?.name ?? "",
            r.billable_lb?.join("+") ?? "",
            ok ? String(r.expected) : "",
            ok ? String(r.definite) : "",
            ok ? String(r.estimated) : "",
            ok ? String(r.conditional_exposure) : "",
            ok ? String(r.unresolved) : "",
            ok ? "priced" : "not priced",
            ok ? "" : (REASON[r.unavailable_reason ?? ""] ?? r.unavailable_reason ?? ""),
          ];
          controller.enqueue(encoder.encode(`${line.map(csvCell).join(",")}\r\n`));
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
