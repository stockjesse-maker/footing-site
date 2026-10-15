import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { calculateShipment } from "@/engine/calculate";
import { createDictionary, emptyPartial, encodeResult, finalizeSummary, foldBatch } from "@/engine/modeling";
import type { CompactResult, DatasetCounts, ExclusionReason, FoldOrder, FoldShipment, PartialSummary } from "@/engine/modeling/types";
import { ENGINE_VERSION, type AssumedInputs, type PackageInput, type ShipmentInput } from "@/engine/types";
import type { ServiceCatalogEntry } from "@/lib/import/rate-card-mapping";
import { loadServiceCatalog } from "@/lib/pricing/catalog";
import { createPricingLoadCache, loadPricingContext, type LoadedSnapshot, type PricingLoadCache } from "@/lib/pricing/snapshot";

/**
 * The batch core of a bulk run. It takes a database client and the run row and prices the next
 * windows of shipments until its time budget is spent, committing every window through
 * `advance_simulation_run`. It never reads cookies or sessions: the server action that calls it
 * has authenticated, and the database functions authorise every call on the run row, so a future
 * worker can call it with any client that may act for the brand.
 */

export interface RunRecord {
  id: string;
  tenant_id: string;
  brand_id: string;
  project_id: string;
  kind: "single" | "bulk";
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  pricing_basis: "ship_date" | "fixed_date";
  as_of_date: string | null;
  service_override_id: string | null;
  unmapped_policy: "exclude" | "use_override";
  assumptions: RunAssumptions;
  total_shipments: number;
  processed_shipments: number;
  next_row_no: number;
  partial_summary: PartialSummary | null;
}

export interface RunAssumptions {
  /** Applied when a shipment carries no residential flag; priced as an assumption. null = treat as business, still an assumption. */
  residentialDefault?: boolean | null;
  /** Applied when a shipment carries no origin ZIP; priced as an assumption. */
  originZipDefault?: string | null;
  /** Price every shipment on the override service (what-if), not only unmapped ones. */
  overrideAllServices?: boolean;
}

export interface ProjectRecord {
  id: string;
  rate_card_id: string;
  dataset_id: string | null;
}

export interface RunProgress {
  status: RunRecord["status"];
  nextRow: number;
  processed: number;
  total: number;
  /** Milliseconds spent pricing in this call (for the client's remaining-time estimate). */
  batchMs: number;
}

interface BatchPackage {
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

interface BatchShipment {
  shipmentId: string;
  orderId: string;
  rowNo: number;
  externalOrderId: string;
  externalShipmentId: string | null;
  orderDate: string | null;
  shipDate: string | null;
  cancelled: boolean;
  originZip: string | null;
  destinationZip: string | null;
  residential: boolean | null;
  serviceId: string | null;
  serviceText: string | null;
  orderIssues: string[];
  shipmentIssues: string[];
  packages: BatchPackage[];
}

interface BatchInput {
  status: RunRecord["status"];
  fromRow: number;
  toRow: number;
  total: number;
  shipments: BatchShipment[];
}

type ContextLoad = { ok: true; snapshot: LoadedSnapshot } | { ok: false; reason: "no_version_in_effect" };

interface ContextRow {
  ship_date: string;
  rate_card_version_id: string | null;
  rule_version_ids: string[];
  zip_list_ids: string[];
  override_ids: string[];
  load_issues: string[];
  unavailable_reason: string | null;
}

interface ResultRow {
  shipment_id: string;
  order_id: string;
  row_no: number;
  status: "ok" | "unavailable";
  unavailable_reason: string | null;
  rate_card_version_id: string | null;
  ship_date: string | null;
  zone: string | null;
  service_id: string | null;
  billable_lb: string[];
  definite: string;
  estimated: string;
  expected: string;
  conditional_exposure: string;
  unresolved: string;
  lines: CompactResult["lines"];
  warning_codes: string[];
}

export interface BatchCaches {
  pricing: PricingLoadCache;
  contexts: Map<string, ContextLoad>;
  catalog: ServiceCatalogEntry[] | null;
}

export function createBatchCaches(): BatchCaches {
  return { pricing: createPricingLoadCache(), contexts: new Map(), catalog: null };
}

const ZERO = "0.00";

function unavailableResult(reason: CompactResult["unavailableReason"], shipDate: string | null, serviceId: string | null): CompactResult {
  return { status: "unavailable", unavailableReason: reason, rateCardVersionId: null, shipDate, zone: null, serviceId, billableLb: [], definite: ZERO, estimated: ZERO, expected: ZERO, conditionalExposure: ZERO, unresolved: ZERO, lines: [], warningCodes: [] };
}

export async function priceBatchCore(
  db: SupabaseClient,
  run: RunRecord,
  project: ProjectRecord,
  opts: { timeBudgetMs?: number; windowLimit?: number; caches?: BatchCaches } = {},
): Promise<RunProgress> {
  const started = Date.now();
  const budget = opts.timeBudgetMs ?? 4000;
  const limit = opts.windowLimit ?? 100;
  const caches = opts.caches ?? createBatchCaches();
  if (!caches.catalog) caches.catalog = await loadServiceCatalog(db);
  const catalog = new Map(caches.catalog.map((s) => [s.id, s]));
  const assumptions = run.assumptions ?? {};

  let status = run.status;
  let nextRow = run.next_row_no;
  let processed = run.processed_shipments;
  const total = run.total_shipments;
  let partial: PartialSummary = run.partial_summary ?? emptyPartial();

  const loadContext = async (shipDate: string): Promise<ContextLoad> => {
    const hit = caches.contexts.get(shipDate);
    if (hit) return hit;
    const loaded = await loadPricingContext(db, { rateCardId: project.rate_card_id, shipDate, brandId: run.brand_id, cache: caches.pricing });
    let entry: ContextLoad;
    if (loaded.ok) entry = { ok: true, snapshot: loaded.snapshot };
    else if (loaded.error === "no_version_in_effect") entry = { ok: false, reason: "no_version_in_effect" };
    else throw new Error(`pricing context unavailable (${loaded.error})`);
    caches.contexts.set(shipDate, entry);
    return entry;
  };

  while (status === "running" && nextRow <= total && Date.now() - started < budget) {
    const { data, error } = await db.rpc("simulation_batch_input", { p_run: run.id, p_limit: limit });
    if (error) throw new Error(`batch input: ${error.message}`);
    const input = data as BatchInput;
    if (input.status !== "running") {
      status = input.status;
      break;
    }
    if (!input.shipments.length) break;

    const dictionary = partial.dictionary.length ? [...partial.dictionary] : createDictionary();
    const contextRows = new Map<string, ContextRow>();
    const results: ResultRow[] = [];
    const orders = new Map<string, FoldOrder>();

    for (const s of input.shipments) {
      const order = orders.get(s.orderId) ?? { orderKey: s.externalOrderId, orderDate: s.orderDate, cancelled: s.cancelled, shipments: [] };
      orders.set(s.orderId, order);

      const shipDate = run.pricing_basis === "fixed_date" ? run.as_of_date : (s.shipDate ?? s.orderDate);
      const assumed: AssumedInputs = {};
      let excludedReason: ExclusionReason | null = null;

      // Service: the file's mapping, the run's override for unmapped (or all) shipments, else excluded.
      let serviceId = s.serviceId;
      if (run.service_override_id && (assumptions.overrideAllServices || (!serviceId && run.unmapped_policy === "use_override"))) serviceId = run.service_override_id;
      if (s.cancelled) excludedReason = "order_cancelled";
      else if (!shipDate) excludedReason = "date_missing";
      else if (!serviceId) excludedReason = "service_unmapped";
      else if (!s.destinationZip) excludedReason = "destination_missing";
      else if (!s.packages.length) excludedReason = "no_packages";
      else if (s.packages.some((p) => p.weight === null)) excludedReason = "weight_missing";

      let originZip = s.originZip;
      if (!originZip && assumptions.originZipDefault) {
        originZip = assumptions.originZipDefault;
        assumed.originZip = true;
      }
      if (!excludedReason && !originZip) excludedReason = "origin_missing";

      let residential = s.residential;
      if (residential === null) {
        residential = assumptions.residentialDefault ?? false;
        assumed.residential = true;
      }
      if (s.packages.some((p) => p.weightDerived)) assumed.weight = true;
      if (s.packages.some((p) => p.dimensionsDerived)) assumed.dimensions = true;

      let compact: CompactResult | null = null;
      if (!excludedReason) {
        const ctx = await loadContext(shipDate!);
        if (!contextRows.has(shipDate!)) {
          contextRows.set(shipDate!, ctx.ok
            ? { ship_date: shipDate!, rate_card_version_id: ctx.snapshot.pins.rateCardVersionId, rule_version_ids: ctx.snapshot.pins.ruleVersionIds, zip_list_ids: ctx.snapshot.pins.zipListIds, override_ids: ctx.snapshot.pins.overrideIds, load_issues: ctx.snapshot.issues, unavailable_reason: null }
            : { ship_date: shipDate!, rate_card_version_id: null, rule_version_ids: [], zip_list_ids: [], override_ids: [], load_issues: [], unavailable_reason: "no_version_in_effect" });
        }
        if (!ctx.ok) {
          compact = unavailableResult("rate_card_not_effective", shipDate, serviceId);
        } else {
          const service = ctx.snapshot.services.find((x) => x.serviceId === serviceId) ?? catalog.get(serviceId!);
          if (!service) {
            compact = unavailableResult("service_not_on_rate_card", shipDate, serviceId);
          } else {
            const packages: PackageInput[] = s.packages.map((p) => ({
              weight: p.weight!,
              weightUnit: p.weightUnit,
              ...(p.length && p.width && p.height ? { length: p.length, width: p.width, height: p.height } : {}),
              ...(p.declaredValue ? { declaredValue: p.declaredValue } : {}),
            }));
            const shipment: ShipmentInput = {
              shipDate: shipDate!,
              originZip: originZip!,
              destinationZip: s.destinationZip!,
              residential,
              carrierCode: service.carrierCode,
              serviceCode: "serviceCode" in service ? service.serviceCode : service.code,
              packages,
              orderId: s.externalOrderId,
              shipmentId: s.externalShipmentId ?? undefined,
              ...(Object.keys(assumed).length ? { assumed } : {}),
            };
            const calc = calculateShipment(shipment, ctx.snapshot.context);
            compact = encodeResult(calc, dictionary, { serviceId: serviceId! });
            compact.rateCardVersionId = ctx.snapshot.pins.rateCardVersionId;
            compact.shipDate = shipDate;
          }
        }
      }

      const packagesWithoutDimensions = s.packages.filter((p) => !(p.length && p.width && p.height)).length;
      const fold: FoldShipment = {
        rowNo: s.rowNo,
        packageCount: s.packages.length,
        serviceId,
        serviceName: serviceId ? (catalog.get(serviceId)?.name ?? null) : null,
        carrierCode: serviceId ? (catalog.get(serviceId)?.carrierCode ?? null) : null,
        excludedReason,
        result: compact,
        assumed: { residential: !!assumed.residential, originZip: !!assumed.originZip, weight: !!assumed.weight, dimensions: !!assumed.dimensions },
        packagesWithoutDimensions,
      };
      order.shipments.push(fold);

      const r = compact ?? unavailableResult(null, shipDate, serviceId);
      results.push({
        shipment_id: s.shipmentId,
        order_id: s.orderId,
        row_no: s.rowNo,
        status: compact ? compact.status : "unavailable",
        unavailable_reason: compact ? compact.unavailableReason : excludedReason,
        rate_card_version_id: r.rateCardVersionId,
        ship_date: r.shipDate,
        zone: r.zone,
        service_id: r.serviceId,
        billable_lb: r.billableLb,
        definite: r.definite,
        estimated: r.estimated,
        expected: r.expected,
        conditional_exposure: r.conditionalExposure,
        unresolved: r.unresolved,
        lines: r.lines,
        warning_codes: r.warningCodes,
      });
    }

    partial = foldBatch({ ...partial, dictionary }, [...orders.values()]);
    const { data: adv, error: advError } = await db.rpc("advance_simulation_run", {
      p_run: run.id,
      p_from_row: input.fromRow,
      p_to_row: input.toRow,
      p_results: results,
      p_partial: partial,
      p_contexts: [...contextRows.values()],
    });
    if (advError) throw new Error(`advance: ${advError.message}`);
    const progress = adv as { applied: boolean; status: RunRecord["status"]; nextRow: number; processed: number; total: number };
    status = progress.status;
    nextRow = progress.nextRow;
    processed = progress.processed;
  }

  if (status === "running" && nextRow > total) {
    const [{ data: ds }, { data: ctxRows }] = await Promise.all([
      db.from("order_datasets").select("row_count, order_count, shipment_count, package_count").eq("id", project.dataset_id!).maybeSingle(),
      db.from("simulation_run_contexts").select("load_issues").eq("run_id", run.id),
    ]);
    const counts: DatasetCounts = { rows: ds?.row_count ?? 0, orders: ds?.order_count ?? 0, shipments: ds?.shipment_count ?? total, packages: ds?.package_count ?? 0 };
    const loadIssues = [...new Set((ctxRows ?? []).flatMap((c) => (c.load_issues as string[]) ?? []))];
    const summary = finalizeSummary(partial, counts, loadIssues, ENGINE_VERSION);
    const { error: finError } = await db.rpc("finish_simulation_run", {
      p_run: run.id,
      p_summary: summary,
      p_reference_data: { dictionary: summary.dictionary, pricingBasis: run.pricing_basis, asOfDate: run.as_of_date },
      p_engine_version: ENGINE_VERSION,
    });
    if (finError) throw new Error(`finish: ${finError.message}`);
    status = "completed";
  }

  return { status, nextRow, processed, total, batchMs: Date.now() - started };
}
