import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  evaluateAdjustmentScenario,
  forecastAdjustmentRisk,
  policyFnFor,
  resolveHandling,
  riskStorageResult,
  scenarioStorageInput,
  scenarioStorageResult,
  summariseHistory,
  type AdjustmentScenarioInput,
  type PolicyComponent,
  type PolicyRow,
} from "@/engine/adjustments";
import type { PricingContext, ShipmentInput, SurchargeRule } from "@/engine/types";
import { PUBLISH_REFUSALS, rpcFailure, riskInputsFrom, type RiskFormInput } from "@/lib/adjustments/action-schemas";
import { buildScenarioInput, scenarioPins } from "@/lib/adjustments/context";
import { buildDetected, detectAdjustmentFile, toStoredMapping } from "@/lib/adjustments/mapping";
import { parseAdjustmentFile } from "@/lib/adjustments/parse";
import { buildAppendChunks, reconcileCommit, type AppendResult } from "@/lib/adjustments/payload";
import { projectBrandExamples, toHistoryBaselines, toHistoryRecord, type BulkRecord } from "@/lib/adjustments/queries";
import { applyAdjustmentMapping, toStoredValidation } from "@/lib/adjustments/validate";
import { historyCsv } from "../unit/adjustments-actions-support";
import { SENTINELS, SENTINEL_PATTERN, asUser, buildFixture, sql, type Fixture } from "./adjustments-fixture";
import { buildWorld, type World } from "./world";

// The read models are server-only modules that import the session and the client factory; only their pure functions are used here.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ requireBrandContext: async () => ({}) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/pricing/catalog", () => ({ loadServiceCatalog: async () => [] }));

/**
 * The calls the adjustment server actions make, in the order a 3PL makes them, through the REAL database with the real engine, import
 * library and read models: a policy, an uploaded history file (parsed, guarded, mapped, validated, attested, committed in chunks, its raw file
 * deleted), a baseline, statistics from the bulk reader, an example priced by the engine and saved with its pins, previewed, shared, read by
 * the customer, taken under review by a policy change, an estimate saved from the statistics, and the database's own refusals read through
 * the sentences the screens show. Arguments are exactly those the actions send (a separate unit test holds the actions to the migration's
 * signatures). The customer's projection, built from the database's own output, must never hold a sentinel. Every figure is fictional.
 */
let w: World;
let f: Fixture;
let today: string;
const T = () => w.t1.id;
const admin = () => w.t1.admin.id;

const SENTINEL_PRIVATE = `${SENTINELS.text}_PRIVATE_NOTE`;
const SENTINEL_POLICY = `${SENTINELS.text}_POLICY_NOTE`;
const SENTINEL_BASELINE = `${SENTINELS.text}_BASELINE_NOTE_${SENTINELS.incidence}`;
const SENTINEL_NAME = `${SENTINELS.text}_SCENARIO_NAME_${SENTINELS.severity}`;
const SENTINEL_ESTIMATE = `${SENTINELS.text}_ESTIMATE_${SENTINELS.absorbed}`;
const SENTINEL_IMPORT = `${SENTINELS.text}_IMPORT_NAME`;

beforeAll(async () => {
  w = await buildWorld();
  f = await buildFixture(w);
  today = f.today;
});

/** What PostgREST would hand the application for a refused call: code, message, details and hint. */
async function refusal(promise: Promise<unknown>): Promise<{ code?: string; message: string; details?: string | null; hint?: string | null }> {
  try {
    await promise;
  } catch (err) {
    const e = err as { code?: string; message: string; detail?: string; hint?: string };
    return { code: e.code, message: e.message, details: e.detail ?? null, hint: e.hint ?? null };
  }
  throw new Error("Expected the call to be refused, but it succeeded.");
}

const rpc = <R = unknown>(user: string, name: string, args: Record<string, unknown>): Promise<R> => {
  const keys = Object.keys(args);
  const values = keys.map((k) => {
    const v = args[k];
    return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
  });
  return asUser<{ r: R }>(user, `select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, values).then((rows) => rows[0]!.r);
};

/** The engine's view of the fixture rate card (UPS Ground zone 5: up to 5 lb 9.60, over 5 up to 20 lb 14.50, DIM 139) and a 3.00 reweigh fee. */
function engineContext(): PricingContext {
  const reweigh: SurchargeRule = {
    key: "adjtest.reweigh_fee", ruleId: f.rules.reweigh.ruleId, versionId: f.rules.reweigh.versionId, version: 1, scope: "tenant", brandId: null, carrierCode: "ups", serviceCodes: null,
    category: "reweight", name: "Reweigh fee", chargeClass: "conditional", method: "flat", amount: "3.00", percent: null, perUnit: null, billableWeightFloorLb: null, base: { kind: "base_rate" },
    conditions: [], exclusivityGroup: null, exclusivityPriority: 0, excludesRuleKeys: [], perPackage: false, effectiveDate: "2026-01-01", expirationDate: null, sourceReference: "fixture", sourceUrl: null, verificationStatus: "approved_3pl_config",
  };
  return {
    rateCard: {
      rateCardId: f.cardId, rateCardName: "Adjustment card", versionId: f.v1, versionNumber: 1, currency: "USD", effectiveDate: "2026-01-01", expirationDate: null,
      services: [{
        serviceId: f.upsGround, carrierCode: "ups", serviceCode: "ground", serviceName: "UPS Ground", minCharge: null, includedSurchargeKeys: [], excludedSurchargeKeys: [], zoneChartKey: "default", zoneIndependent: false,
        surchargeMarkupPercent: null, sourceReference: "fixture", termsVersion: "fixture-terms",
        dim: { divisor: "139", thresholdCubicIn: null, dimensionRounding: "nearest_whole", weightRounding: "up_whole_lb", minBillableLb: null, exempt: false },
      }],
      rows: [
        { serviceId: f.upsGround, originPrefix: null, zone: "5", weightMin: "0", weightMax: "5", weightUnit: "lb", price: "9.60", minCharge: null },
        { serviceId: f.upsGround, originPrefix: null, zone: "5", weightMin: "5", weightMax: "20", weightUnit: "lb", price: "14.50", minCharge: null },
      ],
      zones: [{ carrierCode: "ups", originPrefix: "900", destPrefixFrom: "800", destPrefixTo: "899", zone: "5", zoneChartKey: "default" }],
    },
    rules: [reweigh],
    zipLists: [],
    overrides: [],
  };
}

const policyRows = async (): Promise<PolicyRow[]> =>
  (await asUser<{ brand_id: string | null; adjustment_type: string; component: string; handling: string; valid_from: string; valid_to: string | null }>(admin(), "select brand_id, adjustment_type, component, handling, valid_from::text as valid_from, valid_to::text as valid_to from public.adjustment_policies where tenant_id = $1", [T()])).map(
    (r) => ({ brandId: r.brand_id, adjustmentType: r.adjustment_type, component: r.component, handling: r.handling, validFrom: r.valid_from, validTo: r.valid_to }),
  );

// ---------------------------------------------------------------------------
// 1. Who pays
// ---------------------------------------------------------------------------
describe("the flow, through the real database", () => {
  let importId = "";
  let fileId = "";
  let scenarioId = "";
  let exampleId = "";
  let estimateId = "";
  let k = 0;
  let N = 0;

  it("sets who pays for everyone (no start date: a decision takes effect today) and a private note stays private", async () => {
    await rpc(admin(), "set_adjustment_policy", { p_tenant: T(), p_brand: null, p_type: "reweight", p_component: "postage_difference", p_handling: "pass_through", p_note: SENTINEL_POLICY });
    await rpc(admin(), "set_adjustment_policy", { p_tenant: T(), p_brand: null, p_type: "reweight", p_component: "separate_fee", p_handling: "pass_through", p_note: null });
    const rows = await policyRows();
    expect(rows.filter((r) => r.brandId === null && r.adjustmentType === "reweight")).toHaveLength(2);
    expect(rows.every((r) => r.validFrom === today)).toBe(true);
    expect(resolveHandling(rows, w.brandA.id, "reweight", "postage_difference", today)).toBe("pass_through");
  });

  // -------------------------------------------------------------------------
  // 2. History: upload, guard, mapping, validation, attestation, chunked commit
  // -------------------------------------------------------------------------
  it("imports a history file: parsed and guarded, stored as the caller, mapped, validated, attested, sent in order, finalized, its raw file deleted", async () => {
    const text = historyCsv(40, { brand: "Alpha Apparel" });
    const bytes = new TextEncoder().encode(text);
    const parsed = await parseAdjustmentFile(bytes, "csv");
    if (parsed.status !== "ok") throw new Error(parsed.status === "refused" ? parsed.message : "unreadable");

    const catalog = (await sql<{ id: string; carrier_code: string; carrier_name: string; code: string; name: string }>("select s.id, s.carrier_code, c.name as carrier_name, s.code, s.name from public.shipping_services s join public.carriers c on c.code = s.carrier_code where s.is_active")).map((s) => ({ id: s.id, carrierCode: s.carrier_code, carrierName: s.carrier_name, code: s.code, name: s.name }));
    const brands = [{ id: w.brandA.id, name: "Alpha Apparel" }, { id: w.brandB.id, name: "Beta Beverages" }];
    const detection = detectAdjustmentFile(parsed.tables, { catalog, brands });
    expect(detection.suggestion.brandMap["alpha apparel"]).toBe(w.brandA.id);
    expect(detection.suggestion.carrierMap.ups).toBe("ups");

    // Stored as the caller: this workspace, the import purpose, no customer.
    const [stored] = await asUser<{ id: string }>(
      admin(),
      "insert into public.uploaded_files (tenant_id, purpose, filename, mime_type, byte_size, sha256, content) values ($1, 'adjustment_import', 'history.csv', 'text/csv', $2, decode($3, 'hex'), $4) returning id",
      [T(), bytes.length, createHash("sha256").update(bytes).digest("hex"), Buffer.from(bytes)],
    );
    fileId = stored!.id;
    const created = await rpc<{ ok: boolean; importId: string }>(admin(), "create_adjustment_import", { p_file: fileId, p_name: SENTINEL_IMPORT, p_detected: { ...buildDetected(parsed.tables, detection.suggestion), kind: "csv" } });
    expect(created.ok).toBe(true);
    importId = created.importId;

    const headers = parsed.tables[0]!.rows[detection.suggestion.headerRow]!;
    expect(await rpc<string>(admin(), "set_adjustment_import_mapping", { p_import: importId, p_mapping: toStoredMapping(detection.suggestion, headers), p_validation: null, p_duplicate_handling: "refuse", p_attested: false })).toBe("mapped");

    const result = applyAdjustmentMapping(parsed.tables, detection.suggestion, { catalog, brands, today });
    expect(result.report).toMatchObject({ ok: true, committable: true, counts: { rows: 40, accepted: 40, alreadyImported: 0 } });
    // Without the attestation the database refuses to mark the import validated (the message the screen shows).
    const noAttestation = await refusal(rpc(admin(), "set_adjustment_import_mapping", { p_import: importId, p_mapping: toStoredMapping(detection.suggestion, headers), p_validation: toStoredValidation(result.report), p_duplicate_handling: "refuse", p_attested: false }));
    expect(noAttestation.code).toBe("P0001");
    expect(rpcFailure(noAttestation)).toContain("not what the carrier billed you");
    expect(await rpc<string>(admin(), "set_adjustment_import_mapping", { p_import: importId, p_mapping: toStoredMapping(detection.suggestion, headers), p_validation: toStoredValidation(result.report), p_duplicate_handling: "refuse", p_attested: true })).toBe("validated");

    // Sent in order from row 1 in chunks of at most 2,000, then checked and finalized.
    const plan = buildAppendChunks(result);
    let last: AppendResult | null = null;
    for (const chunk of plan.chunks) {
      last = await rpc<AppendResult>(admin(), "append_adjustment_records", { p_import: importId, p_from_row: chunk.fromRow, p_rows: chunk.rows });
      expect(last.nextRow).toBe(chunk.fromRow + chunk.rows.length);
    }
    const reconciled = reconcileCommit(plan.accepted, last);
    expect(reconciled).toMatchObject({ ok: true, committed: 40, skipped: 0 });
    expect(await rpc(admin(), "finalize_adjustment_import", { p_import: importId })).toMatchObject({ committed: 40, skipped: 0 });

    const [row] = await sql<{ status: string; file_id: string | null }>("select status, file_id from public.adjustment_imports where id = $1", [importId]);
    expect(row).toEqual({ status: "committed", file_id: null });
    expect(await sql("select 1 from public.uploaded_files where id = $1", [fileId])).toHaveLength(0);
    expect(await sql("select 1 from public.adjustment_records where import_id = $1", [importId])).toHaveLength(40);
  });

  it("refuses a file whose header looks like carrier cost data, deletes it, and says what the screen says", async () => {
    const bytes = Buffer.from("ship_date,carrier,package_ref,Carrier Rate\n2026-08-03,UPS,1ZX1,12.34\n");
    const [stored] = await asUser<{ id: string }>(admin(), "insert into public.uploaded_files (tenant_id, purpose, filename, mime_type, byte_size, sha256, content) values ($1, 'adjustment_import', 'x.csv', 'text/csv', $2, decode($3, 'hex'), $4) returning id", [T(), bytes.length, createHash("sha256").update(bytes).digest("hex"), bytes]);
    const r = await rpc<{ ok: boolean; reason: string; header: string }>(admin(), "create_adjustment_import", { p_file: stored!.id, p_name: "cost", p_detected: { headers: [], sampleRows: [] } });
    expect(r).toMatchObject({ ok: false, reason: "forbidden_header" });
    expect(r.header).toBe("Carrier Rate");
    expect(await sql("select 1 from public.uploaded_files where id = $1", [stored!.id])).toHaveLength(0);
    expect(await sql("select 1 from public.adjustment_imports where name = 'cost' and tenant_id = $1", [T()])).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 3. Baselines and statistics through the bulk reader
  // -------------------------------------------------------------------------
  it("reads the history through the bulk reader and the baselines, and gets the statistics the numbers imply", async () => {
    await rpc(admin(), "save_adjustment_baseline", { p_tenant: T(), p_brand: w.brandA.id, p_carrier: null, p_service: null, p_start: "2026-01-01", p_end: "2026-01-31", p_packages: 1000, p_missing: null, p_note: SENTINEL_BASELINE, p_id: null });
    const bulk = await rpc<BulkRecord[]>(admin(), "adjustment_records_json", { p_import: importId, p_from: 1, p_limit: 1000 });
    expect(bulk).toHaveLength(40);
    const baselines = (await asUser<{ id: string; brand_id: string | null; carrier_code: string | null; service_id: string | null; period_start: string; period_end: string; packages_total: number; labels_missing_weight: number | null }>(
      admin(), "select id, brand_id, carrier_code, service_id, period_start::text as period_start, period_end::text as period_end, packages_total, labels_missing_weight from public.adjustment_baselines where tenant_id = $1", [T()],
    )).map((b) => ({ id: b.id, brandId: b.brand_id, carrierCode: b.carrier_code, serviceId: b.service_id, periodStart: b.period_start, periodEnd: b.period_end, packagesTotal: b.packages_total, labelsMissingWeight: b.labels_missing_weight, note: null, createdAt: "" }));
    const stats = summariseHistory(bulk.map(toHistoryRecord), toHistoryBaselines(baselines), { brandId: w.brandA.id, today });
    if (stats.status !== "ok") throw new Error(stats.message);
    expect(stats).toMatchObject({ scope: "brand", affected: 40, recordsInScope: 40, incidence: { k: 40, N: 1000, pct4dp: "4.0000" } });
    // 1.50 postage and 3.00 fee on every record: charges only, in whole ten-thousandths of a dollar.
    expect(stats.severity.increase.postage).toMatchObject({ n: 40, meanE4: 15000 });
    expect(stats.severity.increase.fee).toMatchObject({ n: 40, meanE4: 30000 });
    k = stats.affected;
    N = stats.baseline.packagesTotal!;
    // A record's money comes back as decimal text, never a float; an unknown amount would come back null.
    expect(bulk[0]!.originalCharge).toBe("10.00");
    expect(bulk[0]!.postageDifference).toBe("1.50");
  });

  // -------------------------------------------------------------------------
  // 4. An example: price, save with pins, preview, share, read by the customer
  // -------------------------------------------------------------------------
  it("prices an example with the engine, saves it with its pins, previews what a customer would read, and shares it", async () => {
    const ctx = engineContext();
    const shipment: ShipmentInput = { shipDate: today, originZip: "90001", destinationZip: "85001", residential: false, carrierCode: "ups", serviceCode: "ground", packages: [{ weight: "5", weightUnit: "lb", length: "10", width: "8", height: "6" }] };
    const input: AdjustmentScenarioInput = { shipment, corrections: [{ weight: "12", weightUnit: "lb" }], declaredSource: "entered" };
    const result = evaluateAdjustmentScenario(input, ctx, policyFnFor(await policyRows(), w.brandA.id, today), {});
    expect(result).toMatchObject({ status: "ok", adjustmentType: "reweight", direction: "increase", basis: "exact" });
    const pd = result.components!.postage_difference;
    const fee = result.components!.separate_fee;
    expect([pd.amount, fee.amount]).toEqual(["4.90", "3.00"]);

    const storedInput = scenarioStorageInput(input, result);
    const storedResult = scenarioStorageResult(result);
    if (!storedInput.ok || !storedResult.ok) throw new Error("not storable");
    const pins = scenarioPins({ context: ctx, pins: { rateCardVersionId: f.v1, ruleVersionIds: [f.rules.reweigh.versionId], zipListIds: [], overrideIds: [] } }, shipment, storedResult.value.adjustmentType, w.brandA.id);
    expect(pins).toEqual({ rateCardVersionId: f.v1, ruleVersionIds: [f.rules.reweigh.versionId], overrideIds: [], pricedOn: today });
    scenarioId = await rpc<string>(admin(), "save_adjustment_scenario", { p_tenant: T(), p_brand: w.brandA.id, p_name: SENTINEL_NAME, p_type: storedResult.value.adjustmentType, p_input: storedInput.value, p_result: storedResult.value, p_pins: pins, p_engine_version: "adjustments-1.0.0" });

    const preview = await rpc<{ ok: boolean; problems: unknown[]; payload: { components: { kind: string; amount: string }[] }; hidden: unknown[] }>(admin(), "preview_customer_example", { p_source: scenarioId, p_brand: w.brandA.id });
    expect(preview.ok, JSON.stringify(preview.problems)).toBe(true);
    expect(preview.payload.components.map((c) => [c.kind, c.amount])).toEqual([["postage_difference", pd.amount], ["separate_fee", fee.amount]]);
    expect(JSON.stringify(preview)).not.toMatch(SENTINEL_PATTERN);

    exampleId = await rpc<string>(admin(), "publish_customer_example", { p_source: scenarioId, p_brand: w.brandA.id, p_title: "If a 5 lb package is corrected to 12 lb", p_note: "Ask us if anything is unclear.", p_valid_through: null, p_internal_note: SENTINEL_PRIVATE });
    expect(exampleId).toBeTruthy();
  });

  it("gives the customer exactly the projection, and the page's own projection accepts what the database sends and holds no sentinel", async () => {
    for (const user of [w.brandA.admin.id, w.brandA.employee.id]) {
      const raw = await rpc<unknown>(user, "brand_adjustment_examples", { p_brand: w.brandA.id });
      expect(JSON.stringify(raw)).not.toMatch(SENTINEL_PATTERN);
      const projected = projectBrandExamples(raw);
      expect(projected, "the page accepts the database's own output").not.toBeNull();
      expect(projected).toHaveLength(1);
      expect(projected![0]).toMatchObject({ id: exampleId, title: "If a 5 lb package is corrected to 12 lb", note: "Ask us if anything is unclear.", state: "current", payload: { adjustmentType: "reweight", input: { service: { carrier: "UPS", service: "UPS Ground" }, zone: 5 } } });
      expect(JSON.stringify(projected)).not.toMatch(SENTINEL_PATTERN);
      expect(Object.keys(projected![0]!).sort()).toEqual(["id", "note", "payload", "pricedOn", "publishedAt", "ratesEffectiveFrom", "state", "title", "validThrough"]);
      expect(projected![0]!.payload!.components.map((c) => c.handling)).toEqual(["pass_through", "pass_through"]);
    }
    // Another customer, another account and anyone outside see nothing at all.
    for (const [user, brand] of [[w.brandB.admin.id, w.brandA.id], [w.brandC.admin.id, w.brandA.id], [w.outsider.id, w.brandA.id], [w.brandB.admin.id, w.brandB.id]] as const) {
      expect(projectBrandExamples(await rpc<unknown>(user, "brand_adjustment_examples", { p_brand: brand }))).toEqual([]);
    }
  });

  it("gives a customer's member no row of any staff-only table, whatever they select", async () => {
    const tables = ["adjustment_policies", "adjustment_imports", "adjustment_records", "adjustment_baselines", "adjustment_scenarios", "risk_estimates", "published_adjustment_examples", "uploaded_files"];
    for (const user of [w.brandA.admin.id, w.brandA.employee.id, w.brandB.admin.id]) {
      for (const t of tables) {
        const rows = await asUser(user, `select * from public.${t}`).catch(() => []);
        expect(rows, `${t} for a customer`).toEqual([]);
      }
    }
    // The staff's own administrator reads them: the same statements are not empty for the 3PL.
    expect((await asUser(admin(), "select id from public.published_adjustment_examples")).length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 5. A change of decision takes the example under review
  // -------------------------------------------------------------------------
  it("takes the shared example under review when the decision on who pays changes: the customer's amounts are hidden at once, with one neutral state", async () => {
    await rpc(admin(), "set_adjustment_policy", { p_tenant: T(), p_brand: w.brandA.id, p_type: "reweight", p_component: "postage_difference", p_handling: "absorbed", p_note: null });
    expect(await rpc(admin(), "adjustment_example_state", { p_example: exampleId })).toEqual({ state: "under_review", causes: ["policy_changed"] });
    const states = await rpc<{ id: string; brandId: string; state: string; causes: string[] }[]>(admin(), "adjustment_example_states", { p_tenant: T() });
    expect(states.find((s) => s.id === exampleId)).toMatchObject({ brandId: w.brandA.id, state: "under_review", causes: ["policy_changed"] });
    const raw = await rpc<unknown>(w.brandA.admin.id, "brand_adjustment_examples", { p_brand: w.brandA.id });
    const projected = projectBrandExamples(raw)!;
    expect(projected[0]).toMatchObject({ id: exampleId, state: "under_review", payload: null });
    expect(JSON.stringify(raw)).not.toMatch(/policy|absorb|rate_card|cause/i);
    expect(JSON.stringify(raw)).not.toMatch(SENTINEL_PATTERN);
  });

  it("refuses to share it again until it is priced again, and the sentence says why", async () => {
    const r = await refusal(rpc(admin(), "publish_customer_example", { p_source: scenarioId, p_brand: w.brandA.id, p_title: "Again", p_note: null, p_valid_through: null, p_internal_note: null }));
    expect(r.code).toBe("P0001");
    expect(r.hint).toBe("policy_changed");
    expect(rpcFailure(r)).toBe(PUBLISH_REFUSALS.policy_changed);
  });

  // -------------------------------------------------------------------------
  // 6. A risk estimate from the statistics, and what it blocks
  // -------------------------------------------------------------------------
  it("calculates an estimate from the statistics with the decisions as they stand and saves it citing the import; a withdrawal is refused while it is cited", async () => {
    const rows = await policyRows();
    const handling = Object.fromEntries((["postage_difference", "separate_fee"] as PolicyComponent[]).map((c) => [c, resolveHandling(rows, w.brandA.id, "reweight", c, today)])) as Record<PolicyComponent, "pass_through" | "absorbed" | "manual_approval" | "unconfigured">;
    expect(handling).toEqual({ postage_difference: "absorbed", separate_fee: "pass_through" });
    const form = { brandId: w.brandA.id, adjustmentType: "reweight", basis: "declared_weights", volume: { source: "entered", packagesPerMonth: "2000" }, incidence: { source: "entered", pct: "4" }, severity: { postage_difference: { source: "entered", amount: "1.50" }, separate_fee: { source: "entered", amount: "3.00" } }, credits: "exclude" } as RiskFormInput;
    const built = riskInputsFrom(form, { volume: "2000", handling, statistics: null, exampleSeverity: {} });
    if (!built.ok) throw new Error(built.problems.join());
    const forecast = forecastAdjustmentRisk(built.inputs);
    if (forecast.status !== "ok") throw new Error(forecast.message);
    // 2,000 x 4% = 80 packages: postage 80 x 1.50 = 120.00 (not billed), fee 80 x 3.00 = 240.00 (customer pays).
    expect(forecast.buckets).toEqual({ customerPays: 2_400_000, decidedCaseByCase: 0, notBilledToCustomer: 1_200_000, notDecided: 0 });
    estimateId = await rpc<string>(admin(), "save_risk_estimate", {
      p_tenant: T(),
      p_brand: w.brandA.id,
      p_name: SENTINEL_ESTIMATE,
      p_inputs: { v: 1, adjustmentType: "reweight", basis: "declared_weights", importIds: [importId], incidence: { source: "history", k, N } },
      p_result: riskStorageResult(forecast),
      p_engine_version: "adjustments-1.0.0",
    });
    const refused = await refusal(rpc(admin(), "withdraw_adjustment_import", { p_import: importId }));
    expect(refused.code).toBe("P0001");
    expect(rpcFailure(refused, { notFound: "Import not found." })).toBe("Saved risk estimates are based on this import. Archive them first.");
    await rpc(admin(), "archive_risk_estimate", { p_id: estimateId });
    const done = await rpc<{ deleted: number }>(admin(), "withdraw_adjustment_import", { p_import: importId });
    expect(done.deleted).toBe(40);
    expect(await sql("select 1 from public.adjustment_records where import_id = $1", [importId])).toHaveLength(0);
  });

  it("does not let an estimate be saved against a decision that has changed since it was made (the sentence tells the person to calculate again)", async () => {
    const stale = await refusal(
      rpc(admin(), "save_risk_estimate", { p_tenant: T(), p_brand: w.brandA.id, p_name: "Stale", p_inputs: { v: 1, adjustmentType: "reweight" }, p_result: { v: 1, handling: { postage_difference: "pass_through", separate_fee: "pass_through" } }, p_engine_version: "adjustments-1.0.0" }),
    );
    expect(stale.code).toBe("PC003");
    expect(rpcFailure(stale, { reconcile: "The decision on who pays changed while the estimate was being made. Calculate it again." })).toBe("The decision on who pays changed while the estimate was being made. Calculate it again.");
  });

  // -------------------------------------------------------------------------
  // 7. The database's refusals, read through the sentences the screens show
  // -------------------------------------------------------------------------
  it("reads the real refusals of the policy and baseline functions in words", async () => {
    // A 3PL employee cannot change a decision (42501); an administrator of another account cannot find one (P0002).
    const noRight = await refusal(rpc(w.t1.employee.id, "set_adjustment_policy", { p_tenant: T(), p_brand: null, p_type: "reweight", p_component: "postage_difference", p_handling: "absorbed", p_note: null }));
    expect(noRight.code).toBe("42501");
    expect(rpcFailure(noRight)).toMatch(/permission/);
    const [policy] = await sql<{ id: string }>("select id from public.adjustment_policies where tenant_id = $1 limit 1", [T()]);
    const foreign = await refusal(rpc(w.t2.admin.id, "end_adjustment_policy", { p_policy: policy!.id }));
    expect(foreign.code).toBe("P0002");
    expect(rpcFailure(foreign, { notFound: "Decision not found." })).toBe("Decision not found.");
    const customer = await refusal(rpc(w.brandA.admin.id, "set_adjustment_policy", { p_tenant: T(), p_brand: w.brandA.id, p_type: "reweight", p_component: "separate_fee", p_handling: "absorbed", p_note: null }));
    expect(customer.code).toBe("42501");
    // An overlapping baseline (P0007).
    const overlap = await refusal(rpc(admin(), "save_adjustment_baseline", { p_tenant: T(), p_brand: w.brandA.id, p_carrier: null, p_service: null, p_start: "2026-01-15", p_end: "2026-02-15", p_packages: 500, p_missing: null, p_note: null, p_id: null }));
    expect(overlap.code).toBe("P0007");
    expect(rpcFailure(overlap, { overlap: "This overlaps another baseline for the same customer, carrier and service. Change the dates or edit that one." })).toContain("overlaps another baseline");
  });

  it("reads the real refusals of the import functions in words: a finished import, a refused row, rows the file never promised", async () => {
    const finished = await refusal(rpc(admin(), "append_adjustment_records", { p_import: importId, p_from_row: 1, p_rows: [{ ship_date: "2026-01-01", carrier_code: "ups", adjustment_type: "reweight", cause: "other" }] }));
    expect(finished.code).toBe("P0004");
    expect(rpcFailure(finished, { state: "This import is not accepting rows." })).toBe("This import is not accepting rows.");

    // A fresh import with one bad row: the database names the row and the reason, never the value.
    const text = historyCsv(3, { brand: "Alpha Apparel", start: "2026-02-01" });
    const bytes = new TextEncoder().encode(text);
    const parsed = await parseAdjustmentFile(bytes, "csv");
    if (parsed.status !== "ok") throw new Error("refused");
    const catalog = (await sql<{ id: string; carrier_code: string; carrier_name: string; code: string; name: string }>("select s.id, s.carrier_code, c.name as carrier_name, s.code, s.name from public.shipping_services s join public.carriers c on c.code = s.carrier_code where s.is_active")).map((s) => ({ id: s.id, carrierCode: s.carrier_code, carrierName: s.carrier_name, code: s.code, name: s.name }));
    const brands = [{ id: w.brandA.id, name: "Alpha Apparel" }];
    const detection = detectAdjustmentFile(parsed.tables, { catalog, brands });
    const [stored] = await asUser<{ id: string }>(admin(), "insert into public.uploaded_files (tenant_id, purpose, filename, mime_type, byte_size, sha256, content) values ($1, 'adjustment_import', 'second.csv', 'text/csv', $2, decode($3, 'hex'), $4) returning id", [T(), bytes.length, createHash("sha256").update(bytes).digest("hex"), Buffer.from(bytes)]);
    const created = await rpc<{ importId: string }>(admin(), "create_adjustment_import", { p_file: stored!.id, p_name: "Second", p_detected: buildDetected(parsed.tables, detection.suggestion) });
    const headers = parsed.tables[0]!.rows[0]!;
    const result = applyAdjustmentMapping(parsed.tables, detection.suggestion, { catalog, brands, today });
    await rpc(admin(), "set_adjustment_import_mapping", { p_import: created.importId, p_mapping: toStoredMapping(detection.suggestion, headers), p_validation: toStoredValidation(result.report), p_duplicate_handling: "refuse", p_attested: true });
    const chunk = buildAppendChunks(result).chunks[0]!;
    const bad = await refusal(rpc(admin(), "append_adjustment_records", { p_import: created.importId, p_from_row: 1, p_rows: chunk.rows.map((r, i) => (i === 1 ? { ...r, declared_weight_lb: "-4" } : r)) }));
    expect(bad.code).toBe("PC001");
    expect(bad.message).toMatch(/^row 2: [a-z_]+$/);
    expect(bad.message).not.toContain("-4");
    expect(rpcFailure(bad)).toMatch(/^Row 2 of the file was refused: .*Nothing from this import was kept\.$/);
    const tooMany = await refusal(rpc(admin(), "append_adjustment_records", { p_import: created.importId, p_from_row: 1, p_rows: [...chunk.rows, ...chunk.rows] }));
    expect(tooMany.code).toBe("PC003");
    expect(rpcFailure(tooMany)).toMatch(/did not reconcile/);
    // Out of step: starting somewhere other than the cursor.
    const outOfStep = await refusal(rpc(admin(), "append_adjustment_records", { p_import: created.importId, p_from_row: 5, p_rows: chunk.rows }));
    expect(outOfStep.code).toBe("PC002");
    expect(rpcFailure(outOfStep)).toMatch(/Start the import again/);
    // The import can be thrown away; its raw file goes with it.
    await rpc(admin(), "discard_adjustment_import", { p_import: created.importId });
    expect(await sql("select 1 from public.uploaded_files where id = $1", [stored!.id])).toHaveLength(0);
  });

  it("leaves no raw history file behind in any state of any import of this account", async () => {
    const left = await sql<{ n: string }>("select count(*)::text as n from public.uploaded_files where tenant_id = $1 and purpose = 'adjustment_import'", [T()]);
    expect(left[0]!.n).toBe("0");
    expect(buildScenarioInput).toBeTypeOf("function");
  });
});
