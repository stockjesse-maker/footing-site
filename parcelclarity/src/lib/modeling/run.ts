import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { calculateShipment } from "@/engine/calculate";
import { FEE_ENGINE_VERSION, calculateOrderFees, normalisePackaging } from "@/engine/fees";
import type { FeeRule, FeeScheduleSnapshot, OrderFeeContext } from "@/engine/fees/types";
import { createDictionary, emptyPartial, encodeOrderFees, encodeResult, finalizeSummary, foldBatch } from "@/engine/modeling";
import type { CompactResult, DatasetCounts, ExclusionReason, FeeDictionaryEntry, FeeStatus, FinalizeFeeInput, FoldOrder, FoldOrderFees, FoldShipment, PartialSummary, RunPeriod } from "@/engine/modeling/types";
import { ENGINE_VERSION, type AssumedInputs, type DecimalString, type PackageInput, type ShipmentInput } from "@/engine/types";
import type { ServiceCatalogEntry } from "@/lib/import/rate-card-mapping";
import { buildOrderFeeInput, buildOrderShippingInput, createApportionment, orderMonthOf, type Apportionment, type FulfillmentAssumptions } from "@/lib/modeling/fee-input";
import { loadServiceCatalog } from "@/lib/pricing/catalog";
import { createPricingLoadCache, loadPricingContext, type LoadedSnapshot, type PricingLoadCache } from "@/lib/pricing/snapshot";

/**
 * The batch core of a bulk run. It takes a database client and the run row and prices the next
 * windows of shipments until its time budget is spent, committing every window through
 * `advance_simulation_run`. It never reads cookies or sessions: the server action that calls it
 * has authenticated, and the database functions authorise every call on the run row, so a future
 * worker can call it with any client that may act for the brand.
 *
 * Milestone 4: every window also prices the fees of its orders (whole orders per window) with the
 * fee schedule version in effect on each order's fee date, commits one fee result per order, and the
 * finishing call computes the monthly charges, minimums and allocation that `finish_simulation_run`
 * recomputes in SQL before trusting the summary.
 */

export interface RunRecord {
  id: string;
  tenant_id: string;
  brand_id: string;
  project_id: string;
  kind: "single" | "bulk" | "forecast";
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
  // --- Milestone 4: pinned fee schedule, period and volume (computed by start_simulation_run) ---
  fee_schedule_id: string | null;
  monthly_fee_schedule_version_id: string | null;
  /** Monthly-volume tier rates per version id: { [versionId]: { [ruleKey]: { rateE4, monthlyQuantity } } }. */
  fee_rates: Record<string, Record<string, { rateE4: number; monthlyQuantity: DecimalString }>> | null;
  forecast_from: string | null;
  forecast_to: string | null;
  forecast_days: number | null;
  forecast_months: string | number | null;
  month_profile: { month: string; fraction: string | number; orders: number }[] | null;
  population_orders: number | null;
  period_orders: number | null;
  undated_orders: number | null;
  volume_basis: "file" | "stated" | "none" | null;
  monthly_orders: string | number | null;
  monthly_units: string | number | null;
}

export interface RunAssumptions {
  /** Applied when a shipment carries no residential flag; priced as an assumption. null = treat as business, still an assumption. */
  residentialDefault?: boolean | null;
  /** Applied when a shipment carries no origin ZIP; priced as an assumption. */
  originZipDefault?: string | null;
  /** Price every shipment on the override service (what-if), not only unmapped ones. */
  overrideAllServices?: boolean;
  /** The customer's fulfillment answers (validated by start_simulation_run); absent = fees modeled with no answers. */
  fulfillment?: FulfillmentAssumptions | null;
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
  packagingTypeNormalized: string | null;
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
  // --- Milestone 4: the order's content and ordinal, repeated on every shipment row of the order ---
  orderUnits: number | null;
  orderSeq: number | null;
  orderLines: number | null;
  orderSkus: number | null;
  orderNullSkuLines: number | null;
  orderShipments: number;
}

interface BatchInput {
  status: RunRecord["status"];
  fromRow: number;
  toRow: number;
  total: number;
  shipments: BatchShipment[];
  /** The partial summary as of `fromRow`, read in the same statement as the cursor. */
  partialSummary: PartialSummary | null;
}

type ContextLoad = { ok: true; snapshot: LoadedSnapshot } | { ok: false; reason: "no_version_in_effect" };

/** The fee schedule version in effect on one fee date, as `brand_fee_schedule_on` resolved it. */
type FeeContextLoad = { status: "no_schedule" } | { status: "not_effective"; scheduleName: string | null } | { status: "ok"; versionId: string };

interface FeeVersionCache {
  snapshot: FeeScheduleSnapshot;
  rulesByKey: Map<string, FeeRule>;
}

/** Thrown when the batch cannot continue right now (a load failed); the caller retries later without failing the run. */
export class BatchRetryError extends Error {}

/** A database function refused or failed; `code` is the SQLSTATE (class "PC" = permanent) when the database gave one. */
export class RpcError extends Error {
  readonly code: string | null;
  constructor(what: string, error: { message: string; code?: string | null }) {
    super(`${what}: ${error.message}`);
    this.code = error.code ?? null;
  }
}

interface ContextRow {
  ship_date: string;
  rate_card_version_id: string | null;
  rule_version_ids: string[];
  zip_list_ids: string[];
  override_ids: string[];
  load_issues: string[];
  unavailable_reason: string | null;
}

interface FeeContextRow {
  fee_date: string;
  fee_schedule_version_id: string | null;
  unavailable_reason: "no_schedule" | "not_effective" | null;
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

/** One row of `advance_simulation_run(p_order_results)`: the order's content as echoed to the database and its fee result. */
interface OrderResultRow {
  order_id: string;
  first_row_no: number;
  order_month: string | null;
  fee_date: string | null;
  fee_schedule_version_id: string | null;
  units: number | null;
  lines: number | null;
  distinct_skus: number | null;
  packages: number;
  shipments: number;
  assumed: FoldOrderFees["assumed"];
  fee_status: FeeStatus;
  processing_definite: number;
  processing_estimated: number;
  fee_lines: FoldOrderFees["lines"];
  unresolved: FoldOrderFees["unresolved"];
  warning_codes: string[];
}

export interface BatchCaches {
  pricing: PricingLoadCache;
  contexts: Map<string, ContextLoad>;
  catalog: ServiceCatalogEntry[] | null;
  /** Fee schedule version per fee date, and the snapshots per version id, for this run. */
  feeContexts: Map<string, FeeContextLoad>;
  feeVersions: Map<string, FeeVersionCache>;
  apportionment: Apportionment | null;
}

export function createBatchCaches(): BatchCaches {
  return { pricing: createPricingLoadCache(), contexts: new Map(), catalog: null, feeContexts: new Map(), feeVersions: new Map(), apportionment: null };
}

const ZERO = "0.00";

/** Validation findings that make a shipment unpriceable whatever the run settings (a run can supply an origin, a service or a residential default, but not a weight the file contradicts). */
const BLOCKING_ISSUES: Record<string, ExclusionReason> = {
  order_inconsistent: "order_inconsistent",
  package_inconsistent: "package_inconsistent",
  destination_invalid: "destination_invalid",
  destination_short: "destination_invalid",
  destination_not_us: "destination_not_us",
  weight_invalid: "weight_invalid",
  weight_unit_invalid: "weight_invalid",
  nothing_to_ship: "nothing_to_ship",
  sku_unknown: "sku_unknown",
  value_out_of_range: "value_out_of_range",
};

function unavailableResult(reason: CompactResult["unavailableReason"], shipDate: string | null, serviceId: string | null): CompactResult {
  return { status: "unavailable", unavailableReason: reason, rateCardVersionId: null, shipDate, zone: null, serviceId, billableLb: [], definite: ZERO, estimated: ZERO, expected: ZERO, conditionalExposure: ZERO, unresolved: ZERO, lines: [], warningCodes: [] };
}

function unmodeledFees(status: FeeStatus, assumed: FoldOrderFees["assumed"]): FoldOrderFees {
  return { status, lines: [], unresolved: [], warnings: [], definiteE4: 0, estimatedE4: 0, assumed };
}

function versionCacheOf(snapshot: FeeScheduleSnapshot): FeeVersionCache {
  for (const rule of snapshot.rules) if (!rule.id) throw new RangeError(`fee schedule "${snapshot.name}" returned a rule without an id`);
  return { snapshot, rulesByKey: new Map(snapshot.rules.map((r) => [r.key, r])) };
}

function numericText(value: string | number | null): DecimalString | null {
  return value === null || value === undefined ? null : String(value);
}

/** The forecast period and volume as `start_simulation_run` stored them on the run row; never recomputed here. */
function periodOf(run: RunRecord): RunPeriod {
  const population = run.population_orders ?? 0;
  const undated = run.undated_orders ?? 0;
  const inPeriod = run.period_orders ?? 0;
  return {
    from: run.forecast_from,
    to: run.forecast_to,
    days: run.forecast_days,
    months: numericText(run.forecast_months),
    population,
    inPeriod,
    trimmed: Math.max(0, population - undated - inPeriod),
    undated,
    volumeBasis: run.volume_basis ?? "none",
    monthlyOrders: numericText(run.monthly_orders),
    monthlyUnits: numericText(run.monthly_units),
    monthProfile: (run.month_profile ?? []).map((m) => ({ month: m.month, fraction: String(m.fraction), orders: m.orders })),
  };
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
  const fulfillment = assumptions.fulfillment ?? null;
  const skipFees = fulfillment?.skip === true;
  const contentRows = fulfillment?.orderContent?.rows ?? null;
  if (contentRows?.length && !caches.apportionment) caches.apportionment = createApportionment(contentRows);
  const packagingDefault = fulfillment?.packagingDefault ? normalisePackaging(fulfillment.packagingDefault) || null : null;

  let status = run.status;
  let nextRow = run.next_row_no;
  let processed = run.processed_shipments;
  const total = run.total_shipments;
  let partial: PartialSummary = run.partial_summary ?? emptyPartial();
  let applied = true;

  const loadContext = async (shipDate: string): Promise<ContextLoad> => {
    const hit = caches.contexts.get(shipDate);
    if (hit) return hit;
    const loaded = await loadPricingContext(db, { rateCardId: project.rate_card_id, shipDate, brandId: run.brand_id, cache: caches.pricing });
    let entry: ContextLoad;
    if (loaded.ok) entry = { ok: true, snapshot: loaded.snapshot };
    else if (loaded.error === "no_version_in_effect") entry = { ok: false, reason: "no_version_in_effect" };
    else if (loaded.error === "load_failed") throw new BatchRetryError("pricing context load failed");
    else throw new Error(`pricing context unavailable (${loaded.error})`);
    caches.contexts.set(shipDate, entry);
    return entry;
  };

  /** The customer-facing snapshot of one fee schedule version (customer-safe by construction: no sources or notes). */
  const loadFeeSnapshot = async (versionId: string): Promise<FeeScheduleSnapshot> => {
    const hit = caches.feeVersions.get(versionId);
    if (hit) return hit.snapshot;
    const { data, error } = await db.rpc("fee_schedule_snapshot", { p_version: versionId });
    if (error) throw new RpcError("fee schedule", error);
    const snapshot = data as FeeScheduleSnapshot;
    caches.feeVersions.set(versionId, versionCacheOf(snapshot));
    return snapshot;
  };

  /** The version of the brand's schedule in effect on a fee date, resolved once per date. */
  const loadFeeContext = async (feeDate: string): Promise<FeeContextLoad> => {
    const hit = caches.feeContexts.get(feeDate);
    if (hit) return hit;
    const { data, error } = await db.rpc("brand_fee_schedule_on", { p_brand: run.brand_id, p_date: feeDate });
    if (error) throw new RpcError("fee schedule", error);
    const payload = data as { status: "no_schedule" } | { status: "not_effective"; name?: string | null } | { status: "ok"; snapshot: FeeScheduleSnapshot };
    let entry: FeeContextLoad;
    if (payload.status === "ok") {
      const snapshot = payload.snapshot;
      // The run pinned the brand's schedule when it started; a different one now means the assignment changed mid-run.
      if (snapshot.scheduleId !== run.fee_schedule_id) throw new RangeError("the customer's fee schedule changed while the run was in progress; start it again");
      if (!caches.feeVersions.has(snapshot.versionId)) caches.feeVersions.set(snapshot.versionId, versionCacheOf(snapshot));
      entry = { status: "ok", versionId: snapshot.versionId };
    } else if (payload.status === "not_effective") entry = { status: "not_effective", scheduleName: payload.name ?? null };
    else entry = { status: "no_schedule" };
    caches.feeContexts.set(feeDate, entry);
    return entry;
  };

  const feeContextFor = (versionId: string): OrderFeeContext => ({
    orderShares: fulfillment?.orderShares ?? {},
    pinnedRates: run.fee_rates?.[versionId] ?? {},
    packagingDefault,
  });

  while (status === "running" && nextRow <= total && Date.now() - started < budget) {
    const { data, error } = await db.rpc("simulation_batch_input", { p_run: run.id, p_limit: limit });
    if (error) throw new RpcError("batch input", error);
    const input = data as BatchInput;
    if (input.status !== "running") {
      status = input.status;
      break;
    }
    if (!input.shipments.length) break;
    // The partial that belongs to this cursor position: another caller (a second tab, a retry whose
    // first request was still pricing) may have advanced the run since this call read the row.
    partial = input.partialSummary ?? emptyPartial();
    nextRow = input.fromRow;
    if (partial.version !== 2) throw new RangeError("this run was started by an older release of the modeling engine; start it again");

    const dictionary = partial.dictionary.length ? [...partial.dictionary] : createDictionary();
    const feeDictionary: FeeDictionaryEntry[] = [...partial.feeDictionary];
    const contextRows = new Map<string, ContextRow>();
    const feeContextRows = new Map<string, FeeContextRow>();
    const results: ResultRow[] = [];
    const orderResults: OrderResultRow[] = [];
    const orders = new Map<string, { rows: BatchShipment[]; shipments: FoldShipment[] }>();

    for (const s of input.shipments) {
      const order = orders.get(s.orderId) ?? { rows: [], shipments: [] };
      orders.set(s.orderId, order);
      order.rows.push(s);

      const shipDate = run.pricing_basis === "fixed_date" ? run.as_of_date : (s.shipDate ?? s.orderDate);
      const assumed: AssumedInputs = {};
      let excludedReason: ExclusionReason | null = null;

      // Service: the file's mapping, the run's override for unmapped (or all) shipments, else excluded.
      let serviceId = s.serviceId;
      if (run.service_override_id && (assumptions.overrideAllServices || (!serviceId && run.unmapped_policy === "use_override"))) serviceId = run.service_override_id;
      const blocking = [...(s.orderIssues ?? []), ...(s.shipmentIssues ?? [])].map((i) => BLOCKING_ISSUES[i]).find((r): r is ExclusionReason => r !== undefined);
      if (s.cancelled) excludedReason = "order_cancelled";
      else if (blocking) excludedReason = blocking;
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
        if (ctx.ok) for (const issue of ctx.snapshot.issues) if (!partial.loadIssues.includes(issue)) partial = { ...partial, loadIssues: [...partial.loadIssues, issue] };
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

    // Fees: one result per order of the window. The fee date is the as-of date (fixed-date basis) or the
    // order date, else the first ship date; the version in effect on it is resolved once per date.
    const foldOrders: FoldOrder[] = [];
    for (const [orderId, order] of orders) {
      const first = order.rows[0]!;
      if (order.rows.length !== first.orderShipments) throw new RangeError(`order ${first.externalOrderId}: the window carries ${order.rows.length} of its ${first.orderShipments} shipments`);
      const firstRowNo = order.rows.reduce((n, r) => Math.min(n, r.rowNo), first.rowNo);
      const shipDates = order.rows.map((r) => r.shipDate).filter((d): d is string => d !== null).sort();
      const firstShipDate = shipDates[0] ?? null;
      const orderMonth = orderMonthOf(first.orderDate, firstShipDate);
      const feeDate = run.pricing_basis === "fixed_date" ? run.as_of_date : (first.orderDate ?? firstShipDate);
      const content = buildOrderFeeInput(
        {
          orderUnits: first.orderUnits,
          orderLines: first.orderLines,
          orderSkus: first.orderSkus,
          orderShipments: first.orderShipments,
          orderSeq: first.orderSeq,
          packages: order.rows.flatMap((r) => r.packages.map((p) => ({ packagingTypeNormalized: p.packagingTypeNormalized }))),
        },
        buildOrderShippingInput(order.shipments),
        caches.apportionment,
      );

      let fees: FoldOrderFees;
      let feeDateRow: string | null = null;
      let versionId: string | null = null;
      if (skipFees) fees = unmodeledFees("skipped", content.assumed);
      else if (!feeDate) fees = unmodeledFees("date_missing", content.assumed);
      else {
        feeDateRow = feeDate;
        const ctx: FeeContextLoad = run.fee_schedule_id ? await loadFeeContext(feeDate) : { status: "no_schedule" };
        if (!feeContextRows.has(feeDate)) {
          feeContextRows.set(feeDate, { fee_date: feeDate, fee_schedule_version_id: ctx.status === "ok" ? ctx.versionId : null, unavailable_reason: ctx.status === "ok" ? null : ctx.status });
        }
        if (ctx.status !== "ok") fees = unmodeledFees(ctx.status, content.assumed);
        else {
          const version = caches.feeVersions.get(ctx.versionId)!;
          versionId = ctx.versionId;
          const result = calculateOrderFees(content, version.snapshot, feeContextFor(ctx.versionId));
          const assumed: FoldOrderFees["assumed"] = { ...content.assumed, ...(result.warnings.includes("packaging_defaulted") ? { packaging: true } : {}) };
          fees = encodeOrderFees(result, version.rulesByKey, feeDictionary, result.status, assumed);
        }
      }

      foldOrders.push({ orderKey: first.externalOrderId, orderDate: first.orderDate, orderMonth, cancelled: first.cancelled, shipments: order.shipments, fees });
      orderResults.push({
        order_id: orderId,
        first_row_no: firstRowNo,
        order_month: orderMonth,
        fee_date: feeDateRow,
        fee_schedule_version_id: versionId,
        units: content.units,
        lines: content.lines,
        distinct_skus: content.distinctSkus,
        packages: content.packages.length,
        shipments: content.shipments,
        assumed: content.assumed,
        fee_status: fees.status,
        processing_definite: fees.definiteE4,
        processing_estimated: fees.estimatedE4,
        fee_lines: fees.lines,
        unresolved: fees.unresolved,
        warning_codes: fees.warnings,
      });
    }

    partial = foldBatch({ ...partial, dictionary, feeDictionary }, foldOrders);
    const { data: adv, error: advError } = await db.rpc("advance_simulation_run", {
      p_run: run.id,
      p_from_row: input.fromRow,
      p_to_row: input.toRow,
      p_results: results,
      p_partial: partial,
      p_contexts: [...contextRows.values()],
      p_order_results: orderResults,
      p_fee_contexts: [...feeContextRows.values()],
    });
    if (advError) throw new RpcError("advance", advError);
    const progress = adv as { applied: boolean; status: RunRecord["status"]; nextRow: number; processed: number; total: number };
    status = progress.status;
    nextRow = progress.nextRow;
    processed = progress.processed;
    applied = progress.applied;
    // Not applied: another caller committed this window first. Its partial is now the truth; this call stops here.
    if (!applied) break;
  }

  if (status === "running" && applied && nextRow > total) {
    if (partial.version !== 2) throw new RangeError("this run was started by an older release of the modeling engine; start it again");
    const { data: ds, error: dsError } = await db.from("order_datasets").select("row_count, order_count, shipment_count, package_count").eq("id", project.dataset_id!).maybeSingle();
    if (dsError || !ds) throw new BatchRetryError("dataset counts could not be read");
    const counts: DatasetCounts = { rows: ds.row_count, orders: ds.order_count, shipments: ds.shipment_count, packages: ds.package_count };

    const mode: FinalizeFeeInput["mode"] = skipFees ? "skipped" : run.fee_schedule_id ? "modeled" : "no_schedule";
    const monthlySchedule = run.monthly_fee_schedule_version_id ? await loadFeeSnapshot(run.monthly_fee_schedule_version_id) : null;
    const provenance = run.fee_schedule_id ? await loadProvenance(db, run, caches, monthlySchedule, loadFeeSnapshot) : null;
    const feeInput: FinalizeFeeInput = {
      mode,
      feeEngineVersion: FEE_ENGINE_VERSION,
      monthlySchedule,
      answers: { drivers: fulfillment?.drivers ?? {}, orderShares: fulfillment?.orderShares ?? {} },
      period: periodOf(run),
      provenance,
    };
    const summary = finalizeSummary(partial, counts, [], ENGINE_VERSION, feeInput);
    const ruleIdOf = (key: string): string => {
      const rule = monthlySchedule?.rules.find((r) => r.key === key);
      if (!rule?.id) throw new RangeError(`monthly fee rule "${key}" is not in the pinned version`);
      return rule.id;
    };
    const monthlyLines = summary.monthly
      ? [
          ...summary.monthly.lines.map((l) => ({ rule_id: ruleIdOf(l.ruleKey), quantity: l.quantity, amount_e4: l.amountE4, status: "priced" as const })),
          ...summary.monthly.notModeled.map((n) => ({ rule_id: ruleIdOf(n.ruleKey), status: "not_modeled" as const })),
        ]
      : [];
    const { error: finError } = await db.rpc("finish_simulation_run", {
      p_run: run.id,
      p_summary: summary,
      p_reference_data: { dictionary: summary.dictionary, feeDictionary: summary.feeDictionary, pricingBasis: run.pricing_basis, asOfDate: run.as_of_date },
      p_engine_version: ENGINE_VERSION,
      p_monthly_lines: monthlyLines,
    });
    // "run is completed": a concurrent caller finished it between this call's last window and now.
    if (finError && !/run is completed/.test(finError.message)) throw new RpcError("finish", finError);
    status = "completed";
  }

  return { status, nextRow, processed, total, batchMs: Date.now() - started };
}

/**
 * What the customer is told about the fee schedule: its name and the version(s) orders were priced with
 * (every version named by a fee context of this run, with its effective date). Read from the run's stored
 * contexts, not from this call's caches, because earlier calls priced the earlier windows.
 */
async function loadProvenance(
  db: SupabaseClient,
  run: RunRecord,
  caches: BatchCaches,
  monthlySchedule: FeeScheduleSnapshot | null,
  loadFeeSnapshot: (versionId: string) => Promise<FeeScheduleSnapshot>,
): Promise<FinalizeFeeInput["provenance"]> {
  const { data, error } = await db.from("simulation_run_fee_contexts").select("fee_schedule_version_id").eq("run_id", run.id).not("fee_schedule_version_id", "is", null);
  if (error) throw new BatchRetryError("fee contexts could not be read");
  const versionIds = [...new Set((data ?? []).map((row: { fee_schedule_version_id: string | null }) => row.fee_schedule_version_id).filter((id): id is string => id !== null))];
  const versions: { versionId: string; effectiveDate: string; name: string }[] = [];
  for (const versionId of versionIds) {
    const snapshot = monthlySchedule?.versionId === versionId ? monthlySchedule : await loadFeeSnapshot(versionId);
    versions.push({ versionId, effectiveDate: snapshot.effectiveDate, name: snapshot.name });
  }
  versions.sort((a, b) => (a.effectiveDate < b.effectiveDate ? -1 : a.effectiveDate > b.effectiveDate ? 1 : a.versionId < b.versionId ? -1 : 1));
  let scheduleName: string | null = monthlySchedule?.name ?? versions[0]?.name ?? null;
  if (scheduleName === null) {
    for (const ctx of caches.feeContexts.values()) if (ctx.status === "not_effective" && ctx.scheduleName) scheduleName = ctx.scheduleName;
  }
  if (scheduleName === null && run.fee_schedule_id) {
    const { data: schedule } = await db.from("fee_schedules").select("name").eq("id", run.fee_schedule_id).maybeSingle();
    scheduleName = (schedule as { name: string } | null)?.name ?? null;
  }
  if (scheduleName === null) return null;
  return { scheduleName, versions: versions.map(({ versionId, effectiveDate }) => ({ versionId, effectiveDate })) };
}
