import { NextResponse, type NextRequest } from "next/server";
import type { BulkSummary } from "@/engine/modeling/types";
import { getContext, getUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/permissions";
import { uuidSchema } from "@/lib/auth/validation";
import { ORDERS_CSV_COLUMNS, feeScheduleLine, ordersCsvComments, ordersCsvRecord, ruleNameIndex } from "@/lib/modeling/headline";
import { fileSummaryOf, loadOrderResults, loadOrderShipping } from "@/lib/modeling/queries";
import { createClient } from "@/lib/supabase/server";

export const maxDuration = 60;

/**
 * Per-order export of a completed fee-aware run: one row per order with its items, lines, packages,
 * shipments, expected shipping, order fees and shipping + order fees, read 1,000 orders at a time under the
 * caller's Row Level Security. Blank means not computed and is never a zero. There is deliberately no
 * per-order column for monthly charges or an all-in figure: monthly charges are spread over the customer's
 * volume, never charged per order, and are in monthly.csv. Customer-facing columns only (no rule keys, ids or
 * 3PL internals); text the customer's own file supplied is neutralised against spreadsheet formulas.
 */

const PAGE = 1000;

export async function GET(request: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const user = await getUser();
  const ctx = user ? await getContext() : null;
  if (!ctx || !can(ctx.active.role, "simulation.run") || !uuidSchema.safeParse(runId).success) return new NextResponse("Not found", { status: 404 });
  const supabase = await createClient();
  const { data: run } = await supabase.from("simulation_runs").select("id, tenant_id, brand_id, status, kind, summary, simulation_projects(name, rate_cards(name))").eq("id", runId).maybeSingle();
  if (!run || run.tenant_id !== ctx.active.tenantId || run.status !== "completed" || run.kind !== "bulk") return new NextResponse("Not found", { status: 404 });
  if (ctx.active.portal === "brand" && run.brand_id !== ctx.active.brandId) return new NextResponse("Not found", { status: 404 });
  const brandParam = request.nextUrl.searchParams.get("brandId");
  if (ctx.active.portal === "tenant" && brandParam && brandParam !== run.brand_id) return new NextResponse("Not found", { status: 404 });
  // A model priced before fulfillment fees existed has no per-order fee results to export.
  const summary: BulkSummary | null = fileSummaryOf({ kind: "bulk", summary: run.summary as BulkSummary | null });
  if (!summary) return new NextResponse("Not found", { status: 404 });
  const project = run.simulation_projects as unknown as { name: string; rate_cards: { name: string } | null } | null;

  // Exports of customer order data are audited; a failed audit write refuses the export.
  const { error: auditError } = await supabase.rpc("log_audit_event", {
    p_tenant: run.tenant_id,
    p_brand: run.brand_id,
    p_action: "export.run_orders",
    p_entity_type: "simulation_run",
    p_entity_id: runId,
    p_metadata: { kind: "orders_csv" },
  });
  if (auditError) return new NextResponse("Export unavailable", { status: 503 });

  const names = ruleNameIndex(summary);
  const comments = ordersCsvComments(summary, {
    scenarioName: project?.name ?? "model",
    rateCardName: project?.rate_cards?.name ?? "your rate card",
    feeScheduleLine: feeScheduleLine(ctx.active.tenantName, summary.provenance),
    audience: ctx.active.portal === "tenant" ? "staff" : "brand",
  });
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const line of comments) controller.enqueue(encoder.encode(`${line}\r\n`));
      controller.enqueue(encoder.encode(`${ORDERS_CSV_COLUMNS.join(",")}\r\n`));
      for (let from = 0; ; from += PAGE) {
        const orders = await loadOrderResults(supabase, runId, { from, to: from + PAGE - 1 });
        if (orders.error) {
          controller.error(new Error(orders.error));
          return;
        }
        // An order whose shipping cannot be read must not be exported as "not priced": the export stops instead.
        const shipping = await loadOrderShipping(supabase, runId, orders.rows.map((r) => r.orderId));
        if (shipping.error) {
          controller.error(new Error(shipping.error));
          return;
        }
        for (const r of orders.rows) {
          const record = ordersCsvRecord(
            {
              externalOrderId: r.externalOrderId,
              orderDate: r.orderDate,
              units: r.units,
              lines: r.lines,
              packages: r.packages,
              shipments: r.shipments,
              assumed: r.assumed,
              feeStatus: r.feeStatus,
              definiteE4: r.definiteE4,
              estimatedE4: r.estimatedE4,
              shippingExpected: shipping.shipping.get(r.orderId)?.expected ?? null,
              unresolved: r.unresolved,
            },
            names,
          );
          controller.enqueue(encoder.encode(`${record.join(",")}\r\n`));
        }
        if (orders.rows.length < PAGE) break;
      }
      controller.close();
    },
  });
  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="parcelclarity-orders-${runId.slice(0, 8)}.csv"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
