import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POLICY_CELLS, currentPolicyCells, type PolicyRecord } from "@/lib/adjustments/action-schemas";
import {
  BASELINE,
  BRAND,
  BRAND_B,
  CARD,
  CARD_VERSION,
  CATALOG_ROWS,
  EXAMPLE,
  FILE,
  IMPORT,
  OTHER_TENANT,
  RUN,
  SCENARIO,
  TENANT,
  UPS_GROUND,
  brandSession,
  csvFile,
  historyCsv,
  makeDb,
  storedUploadRow,
  type FakeDb,
  type Row,
} from "./adjustments-actions-support";

/**
 * The read models of the adjustment module, run against a fake database client that applies the filters it is given: every query names the
 * session's workspace, long lists are read a Data API page (1,000 rows) at a time and a page that fails is an error rather than an empty
 * list, history comes through the bulk reader and is never truncated, and the one thing a customer can read comes from one function and
 * is projected field by field. Nothing here is a carrier cost.
 */
const h = vi.hoisted(() => ({ ctx: null as unknown, db: null as unknown }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ requireUser: async () => undefined, getContext: async () => h.ctx, requireBrandContext: async () => h.ctx }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => (h.db as { client: unknown }).client }));
vi.mock("@/lib/pricing/catalog", async () => {
  const s = await import("./adjustments-actions-support");
  return { loadServiceCatalog: async () => s.CATALOG_ROWS };
});

const q = await import("@/lib/adjustments/queries");

const db = () => h.db as FakeDb;
const install = (opts: Parameters<typeof makeDb>[0] = {}) => {
  h.db = makeDb(opts);
  return h.db as FakeDb;
};
beforeEach(() => {
  h.ctx = brandSession;
  install();
});
const client = () => db().client;

const policyRow = (n: number, over: Row = {}): Row => ({ id: `p${n}`, tenant_id: TENANT, brand_id: null, adjustment_type: "reweight", component: "postage_difference", handling: "pass_through", valid_from: "2026-01-01", valid_to: null, internal_note: null, created_at: "2026-01-01T00:00:00Z", ...over });
const importRow = (over: Row = {}): Row => ({ id: IMPORT, tenant_id: TENANT, name: "history", status: "committed", row_count: 3, accepted_count: 3, committed_count: 3, skipped_count: 0, attested_at: "2026-10-01T00:00:00Z", created_at: "2026-10-01T00:00:00Z", committed_at: "2026-10-01T00:00:00Z", range_min: "2026-01-01", range_max: "2026-01-31", file_id: null, duplicate_handling: "refuse", detected: {}, mapping: null, validation: null, ...over });
const bulk = (n: number, over: Record<string, unknown> = {}) => ({ id: `r${n}`, rowNo: n, brandId: BRAND, shipDate: "2026-01-05", carrierCode: "ups", serviceId: null, adjustmentType: "reweight", cause: "carrier_reweigh", packageRef: `1ZQ${n}`, originalCharge: "10.00", correctedCharge: "12.00", separateFee: null, postageDifference: "2.00", ...over });

// ---------------------------------------------------------------------------
// Policies and baselines
// ---------------------------------------------------------------------------
describe("loadPolicies, loadBaselines and loadAdjustmentBrands", () => {
  it("reads every decision of the workspace, a page of 1,000 at a time, and nothing of another account", async () => {
    install({ tables: { adjustment_policies: [...Array.from({ length: 2100 }, (_, i) => policyRow(i)), policyRow(9999, { tenant_id: OTHER_TENANT })] } });
    const rows = await q.loadPolicies(client(), TENANT);
    expect(rows).toHaveLength(2100);
    expect(db().on("adjustment_policies").map((c) => c.range)).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
    expect(db().on("adjustment_policies")[0]!.filters).toContainEqual({ op: "eq", column: "tenant_id", value: TENANT });
    expect(rows[0]).toEqual({ id: "p0", brandId: null, adjustmentType: "reweight", component: "postage_difference", handling: "pass_through", validFrom: "2026-01-01", validTo: null, internalNote: null, createdAt: "2026-01-01T00:00:00Z" });
    expect(q.toPolicyRows(rows.slice(0, 1))).toEqual([{ brandId: null, adjustmentType: "reweight", component: "postage_difference", handling: "pass_through", validFrom: "2026-01-01", validTo: null }]);
  });

  it("stops after a short page, and a failed page is an error, never an empty list", async () => {
    install({ tables: { adjustment_policies: Array.from({ length: 1000 }, (_, i) => policyRow(i)) } });
    expect(await q.loadPolicies(client(), TENANT)).toHaveLength(1000);
    expect(db().on("adjustment_policies")).toHaveLength(2);
    install({ errors: { adjustment_policies: { code: "XX000", message: "boom" } } });
    await expect(q.loadPolicies(client(), TENANT)).rejects.toThrow("decisions on who pays could not be loaded");
  });

  it("reads baselines and customers of the workspace", async () => {
    install({
      tables: {
        adjustment_baselines: [{ id: BASELINE, tenant_id: TENANT, brand_id: BRAND, carrier_code: "ups", service_id: null, period_start: "2026-01-01", period_end: "2026-01-31", packages_total: 1000, labels_missing_weight: 40, note: "n", created_at: "2026-02-01T00:00:00Z" }, { id: "other", tenant_id: OTHER_TENANT }],
        brands: [{ id: BRAND, tenant_id: TENANT, name: "Alpha", status: "active" }, { id: BRAND_B, tenant_id: OTHER_TENANT, name: "Elsewhere", status: "active" }],
      },
    });
    const baselines = await q.loadBaselines(client(), TENANT);
    expect(baselines).toEqual([{ id: BASELINE, brandId: BRAND, carrierCode: "ups", serviceId: null, periodStart: "2026-01-01", periodEnd: "2026-01-31", packagesTotal: 1000, labelsMissingWeight: 40, note: "n", createdAt: "2026-02-01T00:00:00Z" }]);
    expect(q.toHistoryBaselines(baselines)[0]).toEqual({ id: BASELINE, brandId: BRAND, carrierCode: "ups", serviceId: null, periodStart: "2026-01-01", periodEnd: "2026-01-31", packagesTotal: 1000, labelsMissingWeight: 40 });
    expect(await q.loadAdjustmentBrands(client(), TENANT)).toEqual([{ id: BRAND, name: "Alpha", status: "active" }]);
  });
});

describe("the policy matrix for a date", () => {
  const rec = (over: Partial<PolicyRecord>): PolicyRecord => ({ id: "x", brandId: null, adjustmentType: "reweight", component: "postage_difference", handling: "pass_through", validFrom: "2026-01-01", validTo: null, internalNote: null, createdAt: "2026-01-01T00:00:00Z", ...over });

  it("has the seven valid cells in the order the screen lists them (a correction fee has no shipping charge difference)", () => {
    expect(POLICY_CELLS.map((c) => `${c.type}/${c.component}`)).toEqual([
      "reweight/postage_difference", "reweight/separate_fee", "remeasure/postage_difference", "remeasure/separate_fee", "combined/postage_difference", "combined/separate_fee", "correction/separate_fee",
    ]);
  });

  it("shows the decision for all customers and each customer's own, in effect on the date (both ends inclusive), and 'not decided' for the rest", () => {
    const rows = [
      rec({ id: "default", handling: "pass_through" }),
      rec({ id: "alpha", brandId: BRAND, handling: "absorbed", validFrom: "2026-03-01", validTo: "2026-03-31" }),
      rec({ id: "ended", component: "separate_fee", validTo: "2026-06-30" }),
      rec({ id: "later", component: "separate_fee", validFrom: "2026-07-01", handling: "manual_approval" }),
    ];
    const on = (date: string) => currentPolicyCells(rows, date);
    expect(on("2026-03-01")[0]).toMatchObject({ type: "reweight", component: "postage_difference", account: { id: "default" }, exceptions: [{ id: "alpha" }] });
    expect(on("2026-03-31")[0]!.exceptions.map((e) => e.id)).toEqual(["alpha"]);
    expect(on("2026-04-01")[0]!.exceptions).toEqual([]);
    expect(on("2026-02-28")[0]!.exceptions).toEqual([]);
    expect(on("2026-06-30")[1]!.account!.id).toBe("ended");
    expect(on("2026-07-01")[1]!.account!.id).toBe("later");
    expect(on("2026-06-30")[2]).toMatchObject({ type: "remeasure", account: null, exceptions: [] });
    expect(on("2025-12-31").every((c) => c.account === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
describe("imports", () => {
  it("lists imports without their wide JSON, with the ship-date range of the validation, for this workspace", async () => {
    install({ tables: { adjustment_imports: [importRow(), importRow({ id: "x", tenant_id: OTHER_TENANT })] } });
    const rows = await q.listImports(client(), TENANT);
    expect(rows).toEqual([{ id: IMPORT, name: "history", status: "committed", rowCount: 3, acceptedCount: 3, committedCount: 3, skippedCount: 0, attestedAt: "2026-10-01T00:00:00Z", createdAt: "2026-10-01T00:00:00Z", committedAt: "2026-10-01T00:00:00Z", shipDateFrom: "2026-01-01", shipDateTo: "2026-01-31" }]);
    const call = db().on("adjustment_imports")[0]!;
    expect(call.columns).toContain("range_min:validation->shipDateRange->>min");
    for (const wide of ["detected", "mapping", "file_id"]) expect(call.columns!.split(",").map((c) => c.trim())).not.toContain(wide);
    expect(call.columns).not.toContain("*");
  });

  it("reads one import with its stored documents, or null for another account's", async () => {
    install({ tables: { adjustment_imports: [importRow({ status: "validated", detected: { headers: ["a"] }, mapping: { v: 1 }, validation: { counts: {} }, file_id: FILE })] } });
    expect(await q.loadImportDetail(client(), TENANT, IMPORT)).toMatchObject({ id: IMPORT, status: "validated", fileId: FILE, duplicateHandling: "refuse", detected: { headers: ["a"] }, mapping: { v: 1 }, validation: { counts: {} } });
    expect(await q.loadImportDetail(client(), OTHER_TENANT, IMPORT)).toBeNull();
    install({ errors: { adjustment_imports: { message: "boom" } } });
    await expect(q.loadImportDetail(client(), TENANT, IMPORT)).rejects.toThrow("could not be loaded");
  });

  it("reads a stored upload only when it is an adjustment file of this workspace, and decodes the bytes", async () => {
    install({ tables: { uploaded_files: [storedUploadRow("a,b\n1,2\n"), storedUploadRow("x", { id: "o", tenant_id: OTHER_TENANT }), storedUploadRow("x", { id: "p", purpose: "rate_card" })] } });
    const file = await q.readStoredUpload(client(), TENANT, FILE);
    expect(file).toMatchObject({ filename: "history.csv", mimeType: "text/csv" });
    expect(new TextDecoder().decode(file!.bytes)).toBe("a,b\n1,2\n");
    const call = db().on("uploaded_files")[0]!;
    expect(call.filters).toEqual(expect.arrayContaining([{ op: "eq", column: "tenant_id", value: TENANT }, { op: "eq", column: "purpose", value: "adjustment_import" }]));
    expect(await q.readStoredUpload(client(), TENANT, "o")).toBeNull();
    expect(await q.readStoredUpload(client(), TENANT, "p")).toBeNull();
  });

  describe("the mapping step", () => {
    const text = historyCsv(12);
    const wizardDb = (over: Row = {}, upload: Row[] = [storedUploadRow(text)]) => install({ tables: { adjustment_imports: [importRow({ status: "uploaded", file_id: FILE, ...over })], uploaded_files: upload, brands: [{ id: BRAND, tenant_id: TENANT, name: "Alpha Apparel", status: "active" }] } });

    it("reads the stored file again for the proposal and the values to match", async () => {
      wizardDb();
      const view = await q.loadImportWizard(client(), TENANT, IMPORT);
      expect(view!.detection).not.toBeNull();
      expect(view!.detectionProblem).toBeNull();
      expect(view!.detection!.suggestion.columns.shipDate).toBe(0);
      expect(view!.detection!.sheets[0]).toMatchObject({ rowCount: 12 });
      expect(view!.brands).toEqual([{ id: BRAND, name: "Alpha Apparel" }]);
      expect(view!.catalog).toEqual(CATALOG_ROWS);
      expect(view!.mapping).toBeNull();
    });

    it("says why there is no proposal: the file is deleted once an import is finished, or cannot be read, or is now refused", async () => {
      wizardDb({ status: "committed", file_id: null });
      expect(await q.loadImportWizard(client(), TENANT, IMPORT)).toMatchObject({ detection: null, detectionProblem: expect.stringContaining("no longer kept") });
      wizardDb({}, []);
      expect(await q.loadImportWizard(client(), TENANT, IMPORT)).toMatchObject({ detection: null, detectionProblem: expect.stringContaining("no longer available") });
      wizardDb({}, [storedUploadRow("ship_date,Carrier Rate\n2026-01-01,12.34\n")]);
      expect(await q.loadImportWizard(client(), TENANT, IMPORT)).toMatchObject({ detection: null, detectionProblem: expect.stringContaining("looks like carrier cost data") });
      expect(await q.loadImportWizard(client(), OTHER_TENANT, IMPORT)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// History through the bulk reader
// ---------------------------------------------------------------------------
describe("history records", () => {
  it("turns a record into the engine's shape without inventing a value: unknown stays null, never 0", () => {
    const r = q.toHistoryRecord({ ...bulk(1), originalCharge: null, correctedCharge: null, separateFee: null, postageDifference: null, packageRef: null, brandId: null, serviceId: null } as never);
    expect(r).toEqual({ id: "r1", brandId: null, carrierCode: "ups", serviceId: null, shipDate: "2026-01-05", adjustmentType: "reweight", cause: "carrier_reweigh", packageRef: null, originalCharge: null, correctedCharge: null, separateFee: null, postageDifference: null });
    expect(q.toHistoryRecord({ ...bulk(2), separateFee: "0.00" } as never).separateFee).toBe("0.00");
  });

  it("applies the numerator filters (customer, carrier, type, cause) and nothing else", () => {
    const keep = q.numeratorKeep({ brandId: BRAND, carrierCode: "ups", adjustmentType: "reweight", cause: "carrier_reweigh" });
    expect(keep(bulk(1) as never)).toBe(true);
    expect(keep(bulk(1, { brandId: BRAND_B }) as never)).toBe(false);
    expect(keep(bulk(1, { carrierCode: "usps" }) as never)).toBe(false);
    expect(keep(bulk(1, { adjustmentType: "remeasure" }) as never)).toBe(false);
    expect(keep(bulk(1, { cause: "scale_error" }) as never)).toBe(false);
    // Dates and services are not part of it: a record outside the window is still needed to count what a baseline leaves out.
    expect(keep(bulk(1, { shipDate: "1999-01-01", serviceId: "anything" }) as never)).toBe(true);
    expect(q.numeratorKeep({ brandId: null })(bulk(1, { brandId: null }) as never)).toBe(true);
  });

  it("reads committed imports in order, skips empty ones, and reports which imports supplied records that were kept", async () => {
    const a = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
    const b = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
    install({
      tables: { adjustment_imports: [importRow({ id: a, committed_count: 2 }), importRow({ id: b, committed_count: 1, created_at: "2026-10-02T00:00:00Z" }), importRow({ id: "e", committed_count: 0 }), importRow({ id: "d", status: "discarded" })] },
      rpc: { adjustment_records_json: (args) => ({ data: args.p_import === a ? [bulk(1), bulk(2)] : [bulk(1, { brandId: BRAND_B })], error: null }) },
    });
    const all = await q.loadCommittedHistory(client(), TENANT);
    expect(all.recordsRead).toBe(3);
    expect(all.importIds).toEqual([a, b]);
    expect(all.records).toHaveLength(3);
    const mine = await q.loadCommittedHistory(client(), TENANT, q.numeratorKeep({ brandId: BRAND }));
    expect(mine.records).toHaveLength(2);
    expect(mine.recordsRead).toBe(3);
    expect(mine.importIds).toEqual([a]);
    expect(db().rpcNamed("adjustment_records_json").every((x) => x.p_limit === 1000)).toBe(true);
  });

  it("reads exactly the committed imports of the workspace, and an unreadable page is an error", async () => {
    install({ tables: { adjustment_imports: [importRow(), importRow({ id: "o", tenant_id: OTHER_TENANT })] }, rpc: { adjustment_records_json: { data: [], error: null } } });
    await q.loadCommittedHistory(client(), TENANT);
    const call = db().on("adjustment_imports")[0]!;
    expect(call.filters).toEqual(expect.arrayContaining([{ op: "eq", column: "tenant_id", value: TENANT }, { op: "eq", column: "status", value: "committed" }]));
    expect(db().rpcNamed("adjustment_records_json")).toHaveLength(1);
    install({ tables: { adjustment_imports: [importRow()] }, rpc: { adjustment_records_json: { data: null, error: { message: "boom" } } } });
    await expect(q.loadCommittedHistory(client(), TENANT)).rejects.toThrow("history records could not be loaded");
    install({ tables: { adjustment_imports: [importRow()] }, rpc: { adjustment_records_json: { data: { not: "a list" }, error: null } } });
    await expect(q.loadCommittedHistory(client(), TENANT)).rejects.toThrow("unexpected answer");
  });

  it("builds the keys of what is already imported: customer, carrier, package reference and type, only for records that have a reference", async () => {
    install({ tables: { adjustment_imports: [importRow()] }, rpc: { adjustment_records_json: { data: [bulk(1), bulk(2, { brandId: null }), bulk(3, { packageRef: null })], error: null } } });
    const keys = await q.loadExistingKeys(client(), TENANT);
    expect([...keys].sort()).toEqual([`-|ups|1ZQ2|reweight`, `${BRAND}|ups|1ZQ1|reweight`].sort());
  });

  it("reads EVERY committed import, whatever its ship-date range: the unique key has no date, so a late adjustment of an old shipment repeats a package of an import that does not overlap the new file in time (review finding F14)", async () => {
    const jan = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
    const mar = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
    const unknown = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
    install({
      tables: { adjustment_imports: [importRow({ id: jan, range_min: "2026-01-01", range_max: "2026-01-31" }), importRow({ id: mar, range_min: "2026-03-01", range_max: "2026-03-31" }), importRow({ id: unknown, range_min: null, range_max: null })] },
      rpc: { adjustment_records_json: { data: [], error: null } },
    });
    await q.loadExistingKeys(client(), TENANT);
    expect(db().rpcNamed("adjustment_records_json").map((a) => a.p_import).sort()).toEqual([jan, mar, unknown].sort());
    // The signature has no date range to filter by any more.
    expect(q.loadExistingKeys.length).toBe(2);
  });

  it("compares references in their canonical form: spellings of one package are one key, so 'already imported' matches the database's unique index", async () => {
    install({ tables: { adjustment_imports: [importRow()] }, rpc: { adjustment_records_json: { data: [bulk(1, { packageRef: "1z0001 ab" }), bulk(2, { packageRef: "1Z0001AB\u200b" })], error: null } } });
    const keys = await q.loadExistingKeys(client(), TENANT);
    expect([...keys]).toEqual([`${BRAND}|ups|1Z0001AB|reweight`]);
  });
});

// ---------------------------------------------------------------------------
// Saved examples, estimates, shared examples
// ---------------------------------------------------------------------------
describe("saved examples and estimates", () => {
  const scenarioRow = (over: Row = {}): Row => ({ id: SCENARIO, tenant_id: TENANT, brand_id: BRAND, name: "Reweigh", adjustment_type: "reweight", priced_on: "2026-10-15", archived_at: null, created_at: "2026-10-15T00:00:00Z", r_status: "ok", r_direction: "increase", r_basis: "exact", input: { v: 1 }, result: { v: 1 }, engine_version: "adjustments-1.0.0", rate_card_version_id: CARD_VERSION, policy_snapshot: { separate_fee: "pass_through" }, ...over });

  it("lists examples of the workspace without their wide JSON; archived ones only when asked for; one customer's when named", async () => {
    install({ tables: { adjustment_scenarios: [scenarioRow(), scenarioRow({ id: "arch", archived_at: "2026-10-16T00:00:00Z" }), scenarioRow({ id: "b", brand_id: BRAND_B }), scenarioRow({ id: "o", tenant_id: OTHER_TENANT })] } });
    expect((await q.listScenarios(client(), TENANT)).map((s) => s.id)).toEqual([SCENARIO, "b"]);
    expect((await q.listScenarios(client(), TENANT, { includeArchived: true })).map((s) => s.id)).toEqual([SCENARIO, "arch", "b"]);
    expect((await q.listScenarios(client(), TENANT, { brandId: BRAND_B })).map((s) => s.id)).toEqual(["b"]);
    expect(await q.listScenarios(client(), TENANT, { limit: 1 })).toHaveLength(1);
    const columns = db().on("adjustment_scenarios")[0]!.columns!.split(",").map((c) => c.trim());
    expect(columns).not.toContain("input");
    expect(columns).not.toContain("result");
    expect((await q.listScenarios(client(), TENANT))[0]).toEqual({ id: SCENARIO, brandId: BRAND, name: "Reweigh", adjustmentType: "reweight", pricedOn: "2026-10-15", archivedAt: null, createdAt: "2026-10-15T00:00:00Z", status: "ok", direction: "increase", basis: "exact" });
  });

  it("reads one example with its stored documents, or null for another account's", async () => {
    install({ tables: { adjustment_scenarios: [scenarioRow()] } });
    expect(await q.loadScenario(client(), TENANT, SCENARIO)).toMatchObject({ id: SCENARIO, input: { v: 1 }, result: { v: 1 }, engineVersion: "adjustments-1.0.0", rateCardVersionId: CARD_VERSION, policySnapshot: { separate_fee: "pass_through" } });
    expect(await q.loadScenario(client(), OTHER_TENANT, SCENARIO)).toBeNull();
  });

  it("reads what an example charges per component as E4: only a charge counts, anything else is unknown (never 0)", () => {
    const result = { components: [{ kind: "postage_difference", state: "conditional", amount: "5.30" }, { kind: "separate_fee", state: "waived_for_customer", amount: null }] };
    expect(q.exampleSeverity(result, "postage_difference")).toBe(53000);
    expect(q.exampleSeverity(result, "separate_fee")).toBeNull();
    expect(q.exampleSeverity({ components: [{ kind: "separate_fee", state: "conditional", amount: "0.00" }] }, "separate_fee")).toBe(0);
    expect(q.exampleSeverity({ components: [{ kind: "separate_fee", state: "undecided", amount: null, upTo: "3.00" }] }, "separate_fee")).toBeNull();
    expect(q.exampleSeverity({ components: [{ kind: "postage_difference", state: "conditional", amount: "-4.90" }] }, "postage_difference")).toBeNull();
    expect(q.exampleSeverity({}, "separate_fee")).toBeNull();
    expect(q.exampleSeverity({ components: "no" }, "separate_fee")).toBeNull();
  });

  it("lists and reads estimates of the workspace with the basis and the counted total from the stored JSON", async () => {
    const est = (over: Row = {}): Row => ({ id: "e1", tenant_id: TENANT, brand_id: null, name: "Typed", created_at: "2026-10-15T00:00:00Z", archived_at: null, i_basis: "declared_weights", r_counted: 3_000_000, inputs: { v: 1 }, result: { v: 1 }, engine_version: "adjustments-1.0.0", ...over });
    install({ tables: { risk_estimates: [est(), est({ id: "e2", archived_at: "2026-10-16T00:00:00Z" }), est({ id: "e3", tenant_id: OTHER_TENANT }), est({ id: "e4", i_basis: null, r_counted: null })] } });
    expect((await q.listRiskEstimates(client(), TENANT)).map((e) => [e.id, e.basis, e.countedE4])).toEqual([["e1", "declared_weights", 3_000_000], ["e4", null, null]]);
    expect((await q.listRiskEstimates(client(), TENANT, { includeArchived: true })).map((e) => e.id)).toEqual(["e1", "e2", "e4"]);
    expect(await q.loadRiskEstimate(client(), TENANT, "e1")).toMatchObject({ id: "e1", inputs: { v: 1 }, result: { v: 1 } });
    expect(await q.loadRiskEstimate(client(), OTHER_TENANT, "e1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
describe("loadOverview", () => {
  const ruleRow = (id: string, category: string, carrier: string, over: Row = {}): Row => ({ id, category, carrier_code: carrier, brand_id: null, archived_at: null, tenant_id: TENANT, surcharge_rule_versions: [{ status: "published", effective_date: "2026-01-01", expiration_date: null }], ...over });
  const cardServices = [{ version_id: "v1", service_id: UPS_GROUND }];
  const world = (over: { policies?: Row[]; rules?: Row[]; assignments?: Row[]; states?: unknown[] } = {}) =>
    install({
      tables: {
        adjustment_policies: over.policies ?? [],
        surcharge_rules: over.rules ?? [ruleRow("r1", "reweight", "ups")],
        brands: [{ id: BRAND, tenant_id: TENANT, name: "Alpha Apparel", status: "active" }, { id: BRAND_B, tenant_id: TENANT, name: "Beta Beverages", status: "active" }, { id: "inactive", tenant_id: TENANT, name: "Dormant", status: "suspended" }],
        brand_rate_card_assignments: over.assignments ?? [{ brand_id: BRAND, rate_card_id: CARD, tenant_id: TENANT }, { brand_id: BRAND_B, rate_card_id: CARD, tenant_id: TENANT }, { brand_id: "inactive", rate_card_id: CARD, tenant_id: TENANT }],
        rate_card_versions: [{ id: "v1", rate_card_id: CARD, tenant_id: TENANT, status: "active" }],
        rate_card_service_terms: cardServices,
        adjustment_scenarios: [{ id: SCENARIO, tenant_id: TENANT }, { id: "s2", tenant_id: TENANT }, { id: "s3", tenant_id: TENANT, archived_at: "2026-10-01T00:00:00Z" }],
        risk_estimates: [{ id: "e1", tenant_id: TENANT, brand_id: null, name: "Typed", created_at: "2026-10-15T00:00:00Z", archived_at: null, i_basis: "actual_weights", r_counted: 12_000 }],
        adjustment_imports: [importRow({ committed_count: 40 }), importRow({ id: "i2", committed_count: 60 }), importRow({ id: "i3", status: "validated", committed_count: 0 })],
      },
      rpc: { adjustment_example_states: { data: over.states ?? [{ id: "x1", state: "current" }, { id: "x2", state: "under_review" }, { id: "x3", state: "expired" }], error: null } },
    });
  const decide = (type: string, component: string, handling: string, brand: string | null = null, over: Row = {}) => policyRow(Math.random() * 1e9, { adjustment_type: type, component, handling, brand_id: brand, ...over });

  it("counts what the checklist needs: fee rules, decisions, examples, saved estimates, committed history", async () => {
    world({ policies: [decide("reweight", "postage_difference", "pass_through"), decide("reweight", "separate_fee", "absorbed"), decide("remeasure", "separate_fee", "manual_approval", BRAND)] });
    const o = await q.loadOverview(client(), TENANT, "2026-10-16");
    expect(o.feeRules).toEqual({ count: 1, byCategory: { reweight: 1 } });
    expect(o.policies).toEqual({ cells: 7, decided: 2, undecided: 5, exceptions: 1 });
    expect(o.scenarios).toEqual({ active: 2 });
    expect(o.examples).toEqual({ live: 3, current: 1, underReview: 1, expired: 1 });
    expect(o.estimates.active).toBe(1);
    expect(o.estimates.latest).toMatchObject({ id: "e1", basis: "actual_weights", countedE4: 12_000 });
    expect(o.imports).toEqual({ committed: 2, records: 100 });
  });

  it("names the customers who read a fee rule although nobody decided who pays it", async () => {
    // The reweigh fee is decided for everyone; a correction fee exists for Beta only (brand scope) and nobody decided it.
    world({ policies: [decide("reweight", "separate_fee", "pass_through")], rules: [ruleRow("r1", "reweight", "ups"), ruleRow("r2", "shipping_charge_correction", "ups", { brand_id: BRAND_B })] });
    const o = await q.loadOverview(client(), TENANT, "2026-10-16");
    expect(o.customersSeeingUndecidedRule).toEqual([{ brandId: BRAND_B, brandName: "Beta Beverages", categories: ["shipping_charge_correction"] }]);
  });

  it("does not name a customer whose fee is absorbed, passed through or decided case by case, or whose card does not carry the rule's carrier", async () => {
    world({ policies: [decide("reweight", "separate_fee", "absorbed", BRAND), decide("reweight", "separate_fee", "manual_approval", BRAND_B)], rules: [ruleRow("r1", "reweight", "ups")] });
    expect((await q.loadOverview(client(), TENANT, "2026-10-16")).customersSeeingUndecidedRule).toEqual([]);
    world({ rules: [ruleRow("r1", "reweight", "fedex")] });
    expect((await q.loadOverview(client(), TENANT, "2026-10-16")).customersSeeingUndecidedRule).toEqual([]);
  });

  it("names every active customer when nothing at all is decided, and leaves a dormant one out", async () => {
    world();
    const o = await q.loadOverview(client(), TENANT, "2026-10-16");
    expect(o.customersSeeingUndecidedRule.map((c) => c.brandName)).toEqual(["Alpha Apparel", "Beta Beverages"]);
    expect(o.policies).toMatchObject({ decided: 0, undecided: 7 });
  });

  it("ignores rules that are archived, not yet in force, expired or not published (a customer cannot read them), and counts none", async () => {
    world({
      rules: [
        ruleRow("future", "reweight", "ups", { surcharge_rule_versions: [{ status: "published", effective_date: "2026-11-01", expiration_date: null }] }),
        ruleRow("expired", "reweight", "ups", { surcharge_rule_versions: [{ status: "published", effective_date: "2026-01-01", expiration_date: "2026-10-15" }] }),
        ruleRow("draft", "reweight", "ups", { surcharge_rule_versions: [{ status: "draft", effective_date: "2026-01-01", expiration_date: null }] }),
      ],
    });
    const o = await q.loadOverview(client(), TENANT, "2026-10-16");
    expect(o.feeRules.count).toBe(0);
    expect(o.customersSeeingUndecidedRule).toEqual([]);
  });

  it("asks for the account's own and platform rules with the explicit embed (two relationships exist), in this workspace only", async () => {
    world();
    await q.loadOverview(client(), TENANT, "2026-10-16");
    const rules = db().on("surcharge_rules")[0]!;
    expect(rules.columns).toContain("surcharge_rule_versions!srv_rule_in_tenant(");
    expect(rules.filters).toContainEqual({ op: "or", column: "", value: `tenant_id.is.null,tenant_id.eq.${TENANT}` });
    for (const table of ["adjustment_policies", "brand_rate_card_assignments", "rate_card_versions", "adjustment_imports", "risk_estimates", "adjustment_scenarios"]) {
      for (const call of db().on(table)) expect(call.filters, table).toContainEqual({ op: "eq", column: "tenant_id", value: TENANT });
    }
    expect(db().rpcNamed("adjustment_example_states")).toEqual([{ p_tenant: TENANT }]);
  });
});

// ---------------------------------------------------------------------------
// Finished runs
// ---------------------------------------------------------------------------
describe("finished runs as a volume", () => {
  const run = (over: Row = {}): Row => ({ id: RUN, project_id: "p1", tenant_id: TENANT, brand_id: BRAND, kind: "bulk", status: "completed", monthly_packages: "1234.5000", finished_at: "2026-10-01T00:00:00Z", assumed_weight: 0, ...over });

  it("lists a customer's finished file runs with a monthly count and whether weights came from product weights", async () => {
    install({ tables: { simulation_runs: [run(), run({ id: "r2", assumed_weight: 3 }), run({ id: "r3", assumed_weight: null }), run({ id: "r4", monthly_packages: null }), run({ id: "r5", status: "running" }), run({ id: "r6", brand_id: BRAND_B }), run({ id: "r7", tenant_id: OTHER_TENANT })], simulation_projects: [{ id: "p1", tenant_id: TENANT, name: "August orders" }] } });
    const options = await q.loadRunVolumeOptions(client(), TENANT, BRAND);
    expect(options.map((o) => [o.runId, o.monthlyPackages, o.weightsFromProductProfiles, o.runName])).toEqual([[RUN, "1234.5", false, "August orders"], ["r2", "1234.5", true, "August orders"], ["r3", "1234.5", null, "August orders"]]);
    const call = db().on("simulation_runs")[0]!;
    expect(call.columns).toContain("assumed_weight:summary->assumptions->weight");
    expect(call.filters).toEqual(expect.arrayContaining([{ op: "eq", column: "tenant_id", value: TENANT }, { op: "eq", column: "brand_id", value: BRAND }, { op: "eq", column: "kind", value: "bulk" }, { op: "eq", column: "status", value: "completed" }]));
  });

  it("reads one run as a volume exactly as stored (trailing zeros dropped), and refuses a count that is zero or not a number", async () => {
    install({ tables: { simulation_runs: [run(), run({ id: "z", monthly_packages: 0 }), run({ id: "n", monthly_packages: "abc" })], simulation_projects: [] } });
    expect(await q.loadRunVolume(client(), TENANT, BRAND, RUN)).toEqual({ runId: RUN, runName: null, monthlyPackages: "1234.5", weightsFromProductProfiles: false });
    expect(await q.loadRunVolume(client(), TENANT, BRAND, "z")).toBeNull();
    expect(await q.loadRunVolume(client(), TENANT, BRAND, "n")).toBeNull();
    expect(await q.loadRunVolume(client(), TENANT, BRAND_B, RUN)).toBeNull();
    install({ tables: { simulation_runs: [run({ monthly_packages: 1200 })] } });
    expect((await q.loadRunVolume(client(), TENANT, BRAND, RUN))!.monthlyPackages).toBe("1200");
  });
});

// ---------------------------------------------------------------------------
// The customer's side
// ---------------------------------------------------------------------------
const goodPayload = { v: 1, adjustmentType: "reweight", pricedOn: "2026-10-15", input: { service: { carrier: "UPS", service: "UPS Ground" }, direction: "increase", residential: false, zone: 5, declared: { packages: [{ weightLb: "3.0", lengthIn: "10.0", widthIn: "8.0", heightIn: "6.0" }] }, corrected: { packages: [{ weightLb: "5.0", lengthIn: "10.0", widthIn: "8.0", heightIn: "6.0" }] } }, components: [{ kind: "postage_difference", handling: "pass_through", amount: "0.56", declaredTotal: "12.79", correctedTotal: "13.35" }, { kind: "separate_fee", handling: "manual_approval", amount: "3.00" }] };
const goodExample = (over: Record<string, unknown> = {}) => ({ id: EXAMPLE, title: "If a 3 lb package is corrected to 5 lb", note: null, payload: goodPayload, pricedOn: "2026-10-15", ratesEffectiveFrom: "2026-01-01", validThrough: "2026-12-14", publishedAt: "2026-10-15T09:00:00.123456+00:00", state: "current", ...over });

describe("the customer's examples", () => {
  it("returns exactly the projection fields, dropping anything else the database might send (a sentinel never gets through)", () => {
    const leaky = { ...goodExample(), incidence: "7.3719", internalNote: "SENTINEL_TEXT", pins: { ruleVersionIds: ["x"] }, payload: { ...goodPayload, absorbed: "91317.29", input: { ...goodPayload.input, ruleKey: "SENTINEL_RULE" }, components: [{ ...goodPayload.components[0], notBilled: "91317.29" }] } };
    const out = q.projectBrandExamples([leaky])!;
    expect(out).toHaveLength(1);
    expect(Object.keys(out[0]!).sort()).toEqual(["id", "note", "payload", "pricedOn", "publishedAt", "ratesEffectiveFrom", "state", "title", "validThrough"]);
    expect(JSON.stringify(out)).not.toMatch(/SENTINEL|7\.3719|91317|ruleKey|incidence/);
    expect(Object.keys(out[0]!.payload!).sort()).toEqual(["adjustmentType", "components", "input", "pricedOn", "v"]);
    expect(Object.keys(out[0]!.payload!.components[0]!).sort()).toEqual(["amount", "correctedTotal", "declaredTotal", "handling", "kind"]);
  });

  it("hides amounts while an example is under review or expired (no payload), and refuses a document that breaks that promise", () => {
    expect(q.projectBrandExamples([goodExample({ state: "under_review", payload: null }), goodExample({ id: "e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2", state: "expired", payload: null })])!.map((e) => [e.state, e.payload])).toEqual([["under_review", null], ["expired", null]]);
    expect(q.projectBrandExamples([goodExample({ state: "current", payload: null })])).toBeNull();
    expect(q.projectBrandExamples([goodExample({ state: "under_review" })])).toBeNull();
  });

  it("refuses anything that is not what the database promises: a bad amount, a handling a customer cannot see, a state it does not know, too many examples", () => {
    expect(q.projectBrandExamples([goodExample({ payload: { ...goodPayload, components: [{ ...goodPayload.components[0], amount: "-0.56" }] } })])).toBeNull();
    expect(q.projectBrandExamples([goodExample({ payload: { ...goodPayload, components: [{ ...goodPayload.components[0], amount: "0.5" }] } })])).toBeNull();
    expect(q.projectBrandExamples([goodExample({ payload: { ...goodPayload, components: [{ ...goodPayload.components[0], handling: "absorbed" }] } })])).toBeNull();
    expect(q.projectBrandExamples([goodExample({ payload: { ...goodPayload, components: [] } })])).toBeNull();
    expect(q.projectBrandExamples([goodExample({ state: "retired", payload: null })])).toBeNull();
    expect(q.projectBrandExamples([goodExample({ id: "not-a-uuid" })])).toBeNull();
    expect(q.projectBrandExamples([goodExample({ title: "" })])).toBeNull();
    expect(q.projectBrandExamples(Array.from({ length: 26 }, () => goodExample()))).toBeNull();
    expect(q.projectBrandExamples("nope")).toBeNull();
    expect(q.projectBrandExamples(null)).toBeNull();
    expect(q.projectBrandExamples([])).toEqual([]);
  });

  it("calls the one function the customer may call, with the brand as the only argument, and selects NO table at all", async () => {
    install({ rpc: { brand_adjustment_examples: { data: [goodExample()], error: null } } });
    const r = await q.loadBrandExamples(client(), BRAND);
    expect(r).toMatchObject({ status: "ok", examples: [{ id: EXAMPLE, state: "current" }] });
    expect(db().rpcs).toEqual([{ name: "brand_adjustment_examples", args: { p_brand: BRAND } }]);
    expect(db().calls).toEqual([]);
    expect(db().touchedTables()).toEqual([]);
  });

  it("says it could not load when the function fails or answers something unexpected, and never shows an unchecked document", async () => {
    install({ rpc: { brand_adjustment_examples: { data: null, error: { message: "boom" } } } });
    expect(await q.loadBrandExamples(client(), BRAND)).toEqual({ status: "load_failed" });
    install({ rpc: { brand_adjustment_examples: { data: [goodExample({ validThrough: "soon" })], error: null } } });
    expect(await q.loadBrandExamples(client(), BRAND)).toEqual({ status: "load_failed" });
    install({ rpc: { brand_adjustment_examples: { data: [], error: null } } });
    expect(await q.loadBrandExamples(client(), BRAND)).toEqual({ status: "ok", examples: [] });
  });

  it("takes the brand from the session, never from a request, and touches no table", async () => {
    h.ctx = brandSession;
    install({ rpc: { brand_adjustment_examples: { data: [goodExample()], error: null } } });
    const r = await q.loadSessionBrandExamples();
    expect(r).toMatchObject({ status: "ok", brandName: "Acme", tenantName: "Fixture 3PL" });
    expect(db().rpcs).toEqual([{ name: "brand_adjustment_examples", args: { p_brand: BRAND } }]);
    expect(db().calls).toEqual([]);
  });

  it("is the only function of the module that serves a customer, and it reads no M5 table (the source says so too)", () => {
    const source = readFileSync(path.resolve(__dirname, "../../src/lib/adjustments/queries.ts"), "utf8");
    const start = source.indexOf("export async function loadBrandExamples");
    const end = source.indexOf("export async function loadSessionBrandExamples");
    const body = source.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(body).toContain('rpc("brand_adjustment_examples"');
    expect(body).not.toMatch(/\.from\(/);
    const session = source.slice(end);
    expect(session).not.toMatch(/\.from\(/);
    expect(session).toContain("requireBrandContext");
    // The upload of a file is not something a customer's code can reach either.
    expect(csvFile).toBeTruthy();
  });
});
