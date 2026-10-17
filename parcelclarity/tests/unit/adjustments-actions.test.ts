import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectAdjustmentFile, toStoredMapping } from "@/lib/adjustments/mapping";
import { parseAdjustmentFile } from "@/lib/adjustments/parse";
import { applyAdjustmentMapping } from "@/lib/adjustments/validate";
import {
  BASELINE,
  BRAND,
  BRAND_B,
  CATALOG_ROWS,
  EXAMPLE,
  FILE,
  FOREIGN_BRAND,
  IMPORT,
  NEW_ID,
  OTHER_TENANT,
  POLICY,
  SCENARIO,
  TENANT,
  adminSession,
  appendEmulator,
  brandSession,
  csvFile,
  employeeSession,
  fixtureText,
  historyCsv,
  makeDb,
  storedUploadRow,
  type FakeDb,
  type Row,
} from "./adjustments-actions-support";

/**
 * The adjustment server actions that change things: who may call them, what they send to the database, what they refuse before
 * sending anything, and how the database's refusals read. The session, the database client, the rate limiter and the service catalog are
 * replaced; the import library, the engine and the schemas are the real ones. Every figure and name is fictional.
 */
const h = vi.hoisted(() => ({
  ctx: null as unknown,
  db: null as unknown,
  limitOk: true,
  limits: [] as string[],
  revalidated: [] as unknown[][],
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => h.revalidated.push(args) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("@/lib/auth/session", () => ({ requireUser: async () => undefined, getContext: async () => h.ctx, requireBrandContext: async () => h.ctx }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => (h.db as { client: unknown }).client }));
vi.mock("@/lib/rate-limit", () => ({
  RATE_LIMITED_MESSAGE: "limited",
  withinRateLimit: async (_c: unknown, action: string) => {
    h.limits.push(action);
    return h.limitOk;
  },
}));
vi.mock("@/lib/pricing/catalog", async () => {
  const s = await import("./adjustments-actions-support");
  return { loadServiceCatalog: async () => s.CATALOG_ROWS };
});

const actions = await import("@/app/actions/adjustments");

const db = () => h.db as FakeDb;
const install = (opts: Parameters<typeof makeDb>[0] = {}) => {
  h.db = makeDb(opts);
  return h.db as FakeDb;
};
beforeEach(() => {
  h.ctx = adminSession;
  h.limitOk = true;
  h.limits = [];
  h.revalidated = [];
  install();
});

const form = (file?: File) => {
  const f = new FormData();
  if (file) f.append("file", file);
  return f;
};
const initial = { ok: false };
const brandsTable = (): Row[] => [
  { id: BRAND, tenant_id: TENANT, name: "Alpha Apparel", status: "active" },
  { id: BRAND_B, tenant_id: TENANT, name: "Beta Beverages", status: "active" },
  { id: FOREIGN_BRAND, tenant_id: OTHER_TENANT, name: "Somebody Else", status: "active" },
];
const importRow = (over: Row = {}): Row => ({
  id: IMPORT,
  tenant_id: TENANT,
  name: "history",
  status: "uploaded",
  row_count: 0,
  accepted_count: 0,
  committed_count: 0,
  skipped_count: 0,
  attested_at: null,
  created_at: "2026-10-15T10:00:00Z",
  committed_at: null,
  range_min: null,
  range_max: null,
  file_id: FILE,
  duplicate_handling: "refuse",
  detected: {},
  mapping: null,
  validation: null,
  ...over,
});

/** The mapping the wizard would propose for a file, in the stored (compact) form, and the validation of it. */
async function proposal(text: string) {
  const parsed = await parseAdjustmentFile(new TextEncoder().encode(text), "csv");
  if (parsed.status !== "ok") throw new Error("fixture file refused");
  const detection = detectAdjustmentFile(parsed.tables, { catalog: CATALOG_ROWS, brands: [{ id: BRAND, name: "Alpha Apparel" }, { id: BRAND_B, name: "Beta Beverages" }] });
  const headers = parsed.tables.find((t) => t.name === detection.suggestion.sheet)!.rows[detection.suggestion.headerRow]!;
  const result = applyAdjustmentMapping(parsed.tables, detection.suggestion, { catalog: CATALOG_ROWS, brands: [{ id: BRAND, name: "Alpha Apparel" }, { id: BRAND_B, name: "Beta Beverages" }], today: new Date().toISOString().slice(0, 10) });
  return { mapping: detection.suggestion, stored: toStoredMapping(detection.suggestion, headers), result };
}

// ---------------------------------------------------------------------------
// Who may call what
// ---------------------------------------------------------------------------
const policyInput = { brandId: null, adjustmentType: "reweight", component: "postage_difference", handling: "pass_through" };
const baselineInput = { brandId: null, carrierCode: null, serviceId: null, periodStart: "2026-09-01", periodEnd: "2026-09-30", packagesTotal: 1000, labelsMissingWeight: null };
const scenarioForm = { brandId: BRAND, serviceId: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1", originZip: "90001", destinationZip: "85001", residential: false, declaredSource: "entered", packages: [{ declared: { weight: "3", weightUnit: "lb" }, correction: { weight: "5", weightUnit: "lb" } }] };
const riskForm = { brandId: null, adjustmentType: "reweight", basis: "declared_weights", volume: { source: "entered", packagesPerMonth: "1000" }, incidence: { source: "entered", pct: "2" }, severity: { postage_difference: { source: "entered", amount: "10.00" }, separate_fee: { source: "entered", amount: "5.00" } }, credits: "exclude" };
const filtersInput = { brandId: null };

const EVERY_ACTION: [string, () => Promise<unknown>][] = [
  ["setPolicy", () => actions.setPolicy(policyInput)],
  ["endPolicy", () => actions.endPolicy(POLICY)],
  ["uploadAdjustmentFile", () => actions.uploadAdjustmentFile(initial, form(csvFile(historyCsv(3))))],
  ["saveImportMapping", () => actions.saveImportMapping(IMPORT, {})],
  ["validateImport", () => actions.validateImport(IMPORT, true)],
  ["commitImport", () => actions.commitImport(IMPORT)],
  ["discardImport", () => actions.discardImport(IMPORT)],
  ["withdrawImport", () => actions.withdrawImport(IMPORT)],
  ["saveBaseline", () => actions.saveBaseline(baselineInput)],
  ["deleteBaseline", () => actions.deleteBaseline(BASELINE)],
  ["loadHistoryStatistics", () => actions.loadHistoryStatistics(filtersInput)],
  ["evaluateScenario", () => actions.evaluateScenario(scenarioForm)],
  ["saveScenario", () => actions.saveScenario(scenarioForm, "A name")],
  ["archiveScenario", () => actions.archiveScenario(SCENARIO)],
  ["previewExample", () => actions.previewExample(SCENARIO, BRAND)],
  ["publishExample", () => actions.publishExample({ scenarioId: SCENARIO, brandId: BRAND, title: "If a package is corrected" })],
  ["retireExample", () => actions.retireExample(EXAMPLE)],
  ["listExamples", () => actions.listExamples()],
  ["forecastRisk", () => actions.forecastRisk(riskForm)],
  ["saveRiskEstimate", () => actions.saveRiskEstimate(riskForm, "A name")],
  ["archiveRiskEstimate", () => actions.archiveRiskEstimate("efefefef-efef-4fef-8fef-efefefefefef")],
];

describe("who may call what", () => {
  it("exports exactly the actions the screens call, all of them async functions", () => {
    expect(Object.keys(actions).sort()).toEqual(EVERY_ACTION.map(([name]) => name).sort());
    for (const [name, fn] of Object.entries(actions)) expect(typeof fn, name).toBe("function");
  });

  for (const [label, session] of [["no session", null], ["a 3PL employee", employeeSession], ["a customer's administrator", brandSession]] as const) {
    it(`refuses every action to ${label}, before the database, the rate limiter or any file is touched`, async () => {
      h.ctx = session;
      for (const [name, call] of EVERY_ACTION) {
        const result = (await call()) as { ok?: boolean; status?: string; message?: string };
        expect(result.ok === false || result.status === "error", name).toBe(true);
        expect(result.message, name).toMatch(/permission/i);
      }
      expect(db().calls, "no query").toEqual([]);
      expect(db().rpcs, "no function call").toEqual([]);
      expect(h.limits, "no rate limit consumed").toEqual([]);
      expect(h.revalidated).toEqual([]);
    });
  }

  it("lets the administrator through to the database for every action (the permission is the only gate here)", async () => {
    install({ tables: { brands: brandsTable() } });
    for (const [name, call] of EVERY_ACTION) {
      const result = await call().catch((e: Error) => ({ ok: true, redirected: e.message }));
      const r = result as { message?: string };
      expect(r.message ?? "", name).not.toMatch(/don't have permission/i);
    }
    expect(db().calls.length + db().rpcs.length).toBeGreaterThan(5);
  });
});

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------
describe("setPolicy and endPolicy", () => {
  it("sets a decision for all customers with the tenant from the session, and no start date (a decision takes effect today)", async () => {
    install({ rpc: { set_adjustment_policy: { data: POLICY, error: null } } });
    expect(await actions.setPolicy(policyInput)).toEqual({ ok: true, policyId: POLICY, message: "Saved." });
    expect(db().rpcNamed("set_adjustment_policy")).toEqual([{ p_tenant: TENANT, p_brand: null, p_type: "reweight", p_component: "postage_difference", p_handling: "pass_through", p_note: null }]);
    expect(h.revalidated.length).toBeGreaterThan(0);
  });

  it("sets one customer's own decision after checking the customer against the session's workspace", async () => {
    install({ tables: { brands: brandsTable() }, rpc: { set_adjustment_policy: { data: POLICY, error: null } } });
    const r = await actions.setPolicy({ ...policyInput, brandId: BRAND, handling: "absorbed", note: "  agreed on a call  " });
    expect(r.ok).toBe(true);
    const lookup = db().on("brands")[0]!;
    expect(lookup.filters).toContainEqual({ op: "eq", column: "id", value: BRAND });
    expect(lookup.filters).toContainEqual({ op: "eq", column: "tenant_id", value: TENANT });
    expect(db().rpcNamed("set_adjustment_policy")[0]).toMatchObject({ p_brand: BRAND, p_handling: "absorbed", p_note: "agreed on a call" });
  });

  it("never takes the tenant from the request, and a customer of another account is not found (nothing is sent)", async () => {
    install({ tables: { brands: brandsTable() } });
    expect(await actions.setPolicy({ ...policyInput, tenantId: OTHER_TENANT })).toMatchObject({ ok: false });
    expect(await actions.setPolicy({ ...policyInput, brandId: FOREIGN_BRAND })).toEqual({ ok: false, message: "Customer not found." });
    expect(db().rpcs).toEqual([]);
  });

  it("refuses what the form should have caught, field by field, without calling the database", async () => {
    expect(await actions.setPolicy({ ...policyInput, handling: "free" })).toMatchObject({ ok: false, errors: { handling: expect.any(String) } });
    expect(await actions.setPolicy({ ...policyInput, adjustmentType: "correction", component: "postage_difference" })).toMatchObject({ ok: false, errors: { component: expect.stringContaining("correction fee") } });
    expect(await actions.setPolicy({ ...policyInput, note: "x".repeat(1001) })).toMatchObject({ ok: false, errors: { note: expect.any(String) } });
    expect(await actions.setPolicy({ ...policyInput, brandId: "not-a-uuid" })).toMatchObject({ ok: false });
    expect(await actions.setPolicy("nonsense")).toMatchObject({ ok: false });
    expect(db().rpcs).toEqual([]);
  });

  it("says in words what the database refused, never anything it found in a row", async () => {
    const refuse = (error: { code: string; message: string }) => {
      install({ rpc: { set_adjustment_policy: { data: null, error } } });
      return actions.setPolicy(policyInput);
    };
    expect(await refuse({ code: "P0007", message: "this overlaps another decision for the same adjustment" })).toEqual({ ok: false, message: "This overlaps another decision for the same adjustment. End that one first." });
    expect(await refuse({ code: "42501", message: "not allowed" })).toMatchObject({ ok: false, message: expect.stringMatching(/permission/) });
    expect(await refuse({ code: "P0002", message: "not found" })).toEqual({ ok: false, message: "Customer not found." });
    expect(await refuse({ code: "PC001", message: "invalid policy" })).toMatchObject({ ok: false, message: expect.stringMatching(/not accepted/) });
    expect(await refuse({ code: "53400", message: "too many" })).toEqual({ ok: false, message: expect.stringMatching(/too often/) });
    expect(await refuse({ code: "XX000", message: "SECRET internal detail 7.3719" })).toEqual({ ok: false, message: "Something went wrong. Please try again." });
  });

  it("ends a decision of this workspace only", async () => {
    install({ tables: { adjustment_policies: [{ id: POLICY, tenant_id: TENANT }] }, rpc: { end_adjustment_policy: { data: null, error: null } } });
    expect(await actions.endPolicy(POLICY)).toEqual({ ok: true, message: "Decision ended." });
    expect(db().rpcNamed("end_adjustment_policy")).toEqual([{ p_policy: POLICY }]);
    // The same decision id under another account: nothing is sent.
    install({ tables: { adjustment_policies: [{ id: POLICY, tenant_id: OTHER_TENANT }] }, rpc: { end_adjustment_policy: { data: null, error: null } } });
    expect(await actions.endPolicy(POLICY)).toEqual({ ok: false, message: "Decision not found." });
    expect(db().rpcs).toEqual([]);
    expect(await actions.endPolicy("nope")).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------
describe("saveBaseline and deleteBaseline", () => {
  it("saves a baseline with the tenant from the session and every argument the database function takes", async () => {
    install({ rpc: { save_adjustment_baseline: { data: BASELINE, error: null } } });
    const r = await actions.saveBaseline({ ...baselineInput, labelsMissingWeight: 40, note: " shipped from the east warehouse " });
    expect(r).toEqual({ ok: true, baselineId: BASELINE, message: "Baseline saved." });
    expect(db().rpcNamed("save_adjustment_baseline")).toEqual([
      { p_tenant: TENANT, p_brand: null, p_carrier: null, p_service: null, p_start: "2026-09-01", p_end: "2026-09-30", p_packages: 1000, p_missing: 40, p_note: "shipped from the east warehouse", p_id: null },
    ]);
  });

  it("edits only a baseline of this workspace, and a customer of another account is not found", async () => {
    install({ tables: { adjustment_baselines: [{ id: BASELINE, tenant_id: OTHER_TENANT }], brands: brandsTable() } });
    expect(await actions.saveBaseline({ ...baselineInput, id: BASELINE })).toEqual({ ok: false, message: "Baseline not found." });
    expect(await actions.saveBaseline({ ...baselineInput, brandId: FOREIGN_BRAND })).toEqual({ ok: false, message: "Customer not found." });
    expect(db().rpcs).toEqual([]);
  });

  it("refuses an impossible baseline in the form's own words", async () => {
    expect(await actions.saveBaseline({ ...baselineInput, periodEnd: "2026-08-31" })).toMatchObject({ ok: false, errors: { periodEnd: "The period ends before it starts." } });
    expect(await actions.saveBaseline({ ...baselineInput, labelsMissingWeight: 1001 })).toMatchObject({ ok: false, errors: { labelsMissingWeight: expect.stringContaining("cannot be more than the packages") } });
    expect(await actions.saveBaseline({ ...baselineInput, packagesTotal: 0 })).toMatchObject({ ok: false, errors: { packagesTotal: expect.any(String) } });
    expect(await actions.saveBaseline({ ...baselineInput, packagesTotal: 1.5 })).toMatchObject({ ok: false, errors: { packagesTotal: expect.any(String) } });
    expect(await actions.saveBaseline({ ...baselineInput, periodStart: "2026-02-30" })).toMatchObject({ ok: false, errors: { periodStart: expect.any(String) } });
    expect(await actions.saveBaseline({ ...baselineInput, periodStart: "2014-12-31" })).toMatchObject({ ok: false, errors: { periodStart: expect.any(String) } });
    expect(db().rpcs).toEqual([]);
  });

  it("reads an overlap as an overlap and a missing customer, carrier or service as not found", async () => {
    install({ rpc: { save_adjustment_baseline: { data: null, error: { code: "P0007", message: "this overlaps another baseline for the same customer, carrier and service" } } } });
    expect(await actions.saveBaseline(baselineInput)).toMatchObject({ ok: false, message: expect.stringContaining("overlaps another baseline") });
    install({ rpc: { save_adjustment_baseline: { data: null, error: { code: "P0002", message: "not found" } } } });
    expect(await actions.saveBaseline(baselineInput)).toMatchObject({ ok: false, message: expect.stringContaining("not found") });
  });

  it("deletes a baseline of this workspace only", async () => {
    install({ tables: { adjustment_baselines: [{ id: BASELINE, tenant_id: TENANT }] }, rpc: { delete_adjustment_baseline: { data: null, error: null } } });
    expect(await actions.deleteBaseline(BASELINE)).toEqual({ ok: true, message: "Baseline deleted." });
    expect(db().rpcNamed("delete_adjustment_baseline")).toEqual([{ p_id: BASELINE }]);
    install({ tables: { adjustment_baselines: [] } });
    expect(await actions.deleteBaseline(BASELINE)).toEqual({ ok: false, message: "Baseline not found." });
    expect(db().rpcs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Upload: the guard runs before anything is stored
// ---------------------------------------------------------------------------
describe("uploadAdjustmentFile", () => {
  const happyDb = (extra: Parameters<typeof makeDb>[0] = {}) =>
    install({ tables: { adjustment_imports: [], brands: brandsTable() }, rpc: { create_adjustment_import: { data: { ok: true, importId: IMPORT }, error: null } }, inserted: { uploaded_files: { id: FILE } }, ...extra });

  it("refuses a file that looks like carrier cost data and stores NOTHING: no file row, no import row, no function call, no cell value in the answer", async () => {
    happyDb();
    const text = fixtureText("history-carrier-cost.csv");
    const result = await actions.uploadAdjustmentFile(initial, form(csvFile(text, "carrier-invoice.csv")));
    expect(result).toMatchObject({ ok: false, refused: true });
    expect(result.message).toContain("This file looks like carrier cost data");
    expect(result.message).toContain("Carrier Rate");
    expect(result.message).toContain("Nothing from this file was saved");
    expect(result.message).not.toMatch(/77\.31|71\.18|1ZX0000001/);
    expect(db().inserts(), "zero inserts").toHaveLength(0);
    expect(db().writes(), "zero writes of any kind").toHaveLength(0);
    expect(db().rpcs, "no function call").toEqual([]);
    expect(db().on("uploaded_files"), "the files table is not even read").toEqual([]);
    expect(db().on("adjustment_imports"), "the imports table is not touched").toEqual([]);
    expect(h.revalidated).toEqual([]);
  });

  it("refuses every one of the carrier-cost spellings the fixtures list, in a sheet other than the first too", async () => {
    happyDb();
    for (const header of ["Carrier Rate", "Postage Cost", "Label Cost", "Shipping Cost?", "Negotiated Rate", "Postage Paid", "WholesalePrice", "BuyRate"]) {
      const text = `ship_date,carrier,package_ref,${header}\n2026-08-03,UPS,1Z1,12.34\n`;
      const r = await actions.uploadAdjustmentFile(initial, form(csvFile(text)));
      expect(r.refused, header).toBe(true);
    }
    expect(db().writes()).toHaveLength(0);
    expect(db().rpcs).toEqual([]);
  });

  it("stores a good file as the caller (this workspace, adjustment_import, no customer) and then registers it, in that order, and goes to the import's page", async () => {
    happyDb();
    const text = `${fixtureText("history-sample.csv").split("\n")[0]},internal_ref\n${fixtureText("history-sample.csv").split("\n").slice(1, 6).filter(Boolean).map((l) => `${l},SENTINEL_IGNORED_VALUE`).join("\n")}\n`;
    await expect(actions.uploadAdjustmentFile(initial, form(csvFile(text, "August history.csv")))).rejects.toThrow(`NEXT_REDIRECT:/app/adjustments/history/${IMPORT}`);
    const [insert] = db().inserts();
    expect(insert!.table).toBe("uploaded_files");
    const payload = insert!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ tenant_id: TENANT, purpose: "adjustment_import", filename: "August history.csv", mime_type: "text/csv", byte_size: Buffer.byteLength(text) });
    expect(payload).not.toHaveProperty("brand_id");
    expect(payload).not.toHaveProperty("uploaded_by");
    expect(String(payload.content)).toBe(`\\x${Buffer.from(text).toString("hex")}`);
    expect(db().log.indexOf("insert:uploaded_files")).toBeLessThan(db().log.indexOf("rpc:create_adjustment_import"));
    const [args] = db().rpcNamed("create_adjustment_import");
    expect(args).toMatchObject({ p_file: FILE, p_name: "August history" });
    const detected = args!.p_detected as { headers: string[]; sampleRows: Record<string, string>[]; kind: string };
    expect(detected.kind).toBe("csv");
    expect(detected.sampleRows.length).toBeLessThanOrEqual(20);
    // A column nothing reads never has its values stored; its header name is kept (the database tests every header).
    expect(JSON.stringify(detected.sampleRows)).not.toContain("SENTINEL_IGNORED_VALUE");
    expect(detected.headers).toContain("internal_ref");
    expect(h.revalidated.length).toBeGreaterThan(0);
  });

  it("checks the number of imports in progress BEFORE storing the file, so a refused import never leaves a file behind", async () => {
    happyDb({ tables: { adjustment_imports: ["uploaded", "mapped", "validated", "committing", "uploaded"].map((status, i) => importRow({ id: `1000000${i}-0000-4000-8000-000000000000`, status })), brands: brandsTable() } });
    const r = await actions.uploadAdjustmentFile(initial, form(csvFile(historyCsv(3))));
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("five imports in progress") });
    expect(db().inserts()).toHaveLength(0);
    expect(db().rpcs).toEqual([]);
  });

  it("refuses an empty request, a file that is too large, one that is not a spreadsheet and one with too many rows, without storing anything", async () => {
    happyDb();
    expect(await actions.uploadAdjustmentFile(initial, form())).toMatchObject({ ok: false, errors: { file: expect.stringContaining(".csv or .xlsx") } });
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.csv", { type: "text/csv" });
    expect(await actions.uploadAdjustmentFile(initial, form(big))).toMatchObject({ ok: false, errors: { file: expect.stringMatching(/Split it by month/) } });
    expect(await actions.uploadAdjustmentFile(initial, form(new File(["%PDF-1.4"], "x.pdf", { type: "application/pdf" })))).toMatchObject({ ok: false, errors: { file: expect.stringContaining(".csv and .xlsx") } });
    const tooMany = historyCsv(20_001);
    expect(await actions.uploadAdjustmentFile(initial, form(csvFile(tooMany)))).toMatchObject({ ok: false, errors: { file: expect.stringMatching(/more than 20,000 rows.*month/) } });
    expect(db().writes()).toHaveLength(0);
    expect(db().rpcs).toEqual([]);
  });

  it("is rate limited, and says so before reading the file", async () => {
    happyDb();
    h.limitOk = false;
    expect(await actions.uploadAdjustmentFile(initial, form(csvFile(historyCsv(3))))).toEqual({ ok: false, message: "limited" });
    expect(h.limits).toEqual(["adjustment.upload"]);
    expect(db().calls).toEqual([]);
  });

  it("passes on the database's own refusal of a header (it deletes the file itself) as the same refusal, naming the header, and has no file of its own to remove", async () => {
    happyDb({ rpc: { create_adjustment_import: { data: { ok: false, reason: "forbidden_header", header: "Carrier Cost" }, error: null } } });
    const r = await actions.uploadAdjustmentFile(initial, form(csvFile(historyCsv(3))));
    expect(r).toMatchObject({ ok: false, refused: true });
    expect(r.message).toContain("This file looks like carrier cost data");
    expect(r.message).toContain('"Carrier Cost"');
    expect(r.message).toContain("Nothing from this file was saved");
    // The database deleted the file itself when it answered {ok:false}: a second delete would only report "not found".
    expect(db().rpcNamed("discard_unattached_adjustment_file")).toEqual([]);
  });

  it("maps a refusal of the import and a failed file insert to sentences, and removes the stored file after the refusal of the import", async () => {
    happyDb({ rpc: { create_adjustment_import: { data: null, error: { code: "P0001", message: "too many imports are in progress; finish or discard one first" } }, discard_unattached_adjustment_file: { data: null, error: null } } });
    expect(await actions.uploadAdjustmentFile(initial, form(csvFile(historyCsv(3))))).toMatchObject({ ok: false, message: expect.stringContaining("five imports in progress") });
    expect(db().rpcNamed("discard_unattached_adjustment_file")).toEqual([{ p_file: FILE }]);
    happyDb({ errors: { "uploaded_files:insert": { code: "42501", message: "row-level security" } } });
    expect(await actions.uploadAdjustmentFile(initial, form(csvFile(historyCsv(3))))).toEqual({ ok: false, message: "You don't have permission to change adjustments. Only administrators can." });
    happyDb({ errors: { "uploaded_files:insert": { code: "XX000", message: "boom" } } });
    expect(await actions.uploadAdjustmentFile(initial, form(csvFile(historyCsv(3))))).toEqual({ ok: false, message: "Something went wrong. Please try again." });
    expect(db().rpcs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Mapping, validation, commit
// ---------------------------------------------------------------------------
describe("saveImportMapping", () => {
  const text = historyCsv(30);
  const setUp = (over: Row = {}, extra: Parameters<typeof makeDb>[0] = {}) =>
    install({ tables: { adjustment_imports: [importRow(over)], uploaded_files: [storedUploadRow(text)], brands: brandsTable() }, rpc: { set_adjustment_import_mapping: { data: "mapped", error: null } }, ...extra });

  it("re-checks the mapping against the stored file and saves it in the compact form, without a validation and without an attestation", async () => {
    setUp();
    const { mapping, stored } = await proposal(text);
    expect(await actions.saveImportMapping(IMPORT, { ...mapping, duplicateHandling: "sum" })).toEqual({ ok: true, status: "mapped", message: "Mapping saved." });
    const [args] = db().rpcNamed("set_adjustment_import_mapping");
    expect(args).toMatchObject({ p_import: IMPORT, p_validation: null, p_duplicate_handling: "sum", p_attested: false });
    const sent = args!.p_mapping as { columns: Record<string, number>; fields: Record<string, string> };
    expect(sent.columns).toEqual(stored.columns);
    expect(sent.fields.originalCharge).toBe("customer_charge_original");
    expect(h.limits).toEqual(["adjustment.mapping"]);
  });

  it("reads the import and the file under the session's workspace, so another account's import is not found", async () => {
    setUp({ tenant_id: OTHER_TENANT });
    const { mapping } = await proposal(text);
    expect(await actions.saveImportMapping(IMPORT, mapping)).toEqual({ ok: false, message: "Import not found." });
    expect(db().rpcs).toEqual([]);
    expect(db().on("uploaded_files")).toEqual([]);
  });

  it("refuses a mapping that does not fit the file (a column that is not there, a column read twice, no ship date) and names the problem", async () => {
    setUp();
    const { mapping } = await proposal(text);
    const outOfRange = await actions.saveImportMapping(IMPORT, { ...mapping, columns: { ...mapping.columns, originalCharge: 99 } });
    expect(outOfRange).toMatchObject({ ok: false, issues: [expect.objectContaining({ code: "column_out_of_range", field: "originalCharge" })] });
    const twice = await actions.saveImportMapping(IMPORT, { ...mapping, columns: { ...mapping.columns, correctedCharge: mapping.columns.originalCharge } });
    expect(twice).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: "column_mapped_twice" })]) });
    const noDate = await actions.saveImportMapping(IMPORT, { ...mapping, columns: { ...mapping.columns, shipDate: null } });
    expect(noDate).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: "ship_date_missing" })]) });
    expect(db().rpcs).toEqual([]);
  });

  it("refuses to read a stored file whose headers the guard would now refuse (nothing can be mapped from it)", async () => {
    setUp({}, { tables: { adjustment_imports: [importRow()], uploaded_files: [storedUploadRow(fixtureText("history-carrier-cost.csv"))], brands: brandsTable() } });
    const { mapping } = await proposal(text);
    const r = await actions.saveImportMapping(IMPORT, mapping);
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("looks like carrier cost data") });
    expect(db().rpcs).toEqual([]);
  });

  it("refuses an import that is already finished or committing, a malformed mapping, and a stored file that is gone", async () => {
    const { mapping } = await proposal(text);
    setUp({ status: "committed", file_id: null });
    expect(await actions.saveImportMapping(IMPORT, mapping)).toEqual({ ok: false, message: "This import is no longer being edited." });
    setUp({ status: "committing" });
    expect(await actions.saveImportMapping(IMPORT, mapping)).toEqual({ ok: false, message: "This import is no longer being edited." });
    setUp();
    expect(await actions.saveImportMapping(IMPORT, { v: 2 })).toMatchObject({ ok: false, message: expect.stringContaining("The mapping is incomplete") });
    setUp({}, { tables: { adjustment_imports: [importRow()], uploaded_files: [], brands: brandsTable() } });
    expect(await actions.saveImportMapping(IMPORT, mapping)).toMatchObject({ ok: false, message: expect.stringContaining("no longer available") });
    expect(db().rpcs).toEqual([]);
  });

  it("names the header when the database backstop refuses a mapped column, and reads the other refusals in words", async () => {
    const { mapping } = await proposal(text);
    setUp({}, { rpc: { set_adjustment_import_mapping: { data: null, error: { code: "P0001", message: "a column that looks like carrier cost data cannot be mapped", details: "Postage Cost" } } } });
    expect(await actions.saveImportMapping(IMPORT, mapping)).toMatchObject({ ok: false, message: 'The column "Postage Cost" cannot be used for a charge: its name looks like a carrier cost column. Rename it in your file if it is not one.' });
    setUp({}, { rpc: { set_adjustment_import_mapping: { data: null, error: { code: "P0004", message: "this import is no longer being edited" } } } });
    expect(await actions.saveImportMapping(IMPORT, mapping)).toEqual({ ok: false, message: "This import is no longer being edited." });
  });
});

describe("validateImport", () => {
  it("needs the attestation first: without it nothing is read, checked or stored", async () => {
    install();
    const r = await actions.validateImport(IMPORT, false);
    expect(r).toMatchObject({ ok: false, errors: { attested: expect.stringContaining("not what the carrier billed you") } });
    expect(db().calls).toEqual([]);
    expect(db().rpcs).toEqual([]);
    expect(h.limits).toEqual([]);
  });

  it("reads the stored file again, applies the saved mapping and stores the report with the attestation, marking the import validated", async () => {
    const text = historyCsv(30);
    const { stored, result } = await proposal(text);
    install({
      tables: { adjustment_imports: [importRow({ status: "mapped", mapping: stored })], uploaded_files: [storedUploadRow(text)], brands: brandsTable() },
      rpc: { set_adjustment_import_mapping: { data: "validated", error: null } },
    });
    const r = await actions.validateImport(IMPORT, true);
    expect(r).toMatchObject({ ok: true, status: "validated", message: expect.stringContaining("Nothing is imported until you confirm") });
    expect(r.report!.counts.accepted).toBe(30);
    const [args] = db().rpcNamed("set_adjustment_import_mapping");
    expect(args).toMatchObject({ p_import: IMPORT, p_attested: true, p_duplicate_handling: "refuse" });
    expect((args!.p_validation as { counts: { rows: number; accepted: number } }).counts).toMatchObject({ rows: 30, accepted: 30 });
    expect((args!.p_validation as { counts: unknown }).counts).toEqual(result.report.counts);
    // The stored report carries no cell value: only counts, codes and row numbers.
    expect(JSON.stringify(args!.p_validation)).not.toMatch(/1ZT0000001/);
    expect(h.limits).toEqual(["adjustment.validate"]);
  });

  it("returns a report with rows to fix but does not mark the import validated (and takes an old validated mark back)", async () => {
    const text = historyCsv(5).replace("2026-01-01", "not a date");
    const { stored } = await proposal(historyCsv(5));
    install({
      tables: { adjustment_imports: [importRow({ status: "validated", mapping: stored, duplicate_handling: "refuse" })], uploaded_files: [storedUploadRow(text)], brands: brandsTable() },
      rpc: { set_adjustment_import_mapping: { data: "mapped", error: null } },
    });
    const r = await actions.validateImport(IMPORT, true);
    expect(r).toMatchObject({ ok: false, status: "mapped", message: expect.stringContaining("need fixing") });
    expect(r.report!.counts.errorRows).toBe(1);
    expect(r.report!.byCode.invalid_date).toBe(1);
    const sent = db().rpcNamed("set_adjustment_import_mapping");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ p_validation: null, p_attested: false });
  });

  it("counts rows already imported by an earlier file (read through the bulk reader), whatever dates that file covered (review finding F14)", async () => {
    const text = historyCsv(10);
    const { stored } = await proposal(text);
    const overlapping = "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0";
    const elsewhere = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
    const holding = (refs: string[]) => ({ data: refs.map((ref, i) => ({ id: `r${i}`, rowNo: i + 1, brandId: null, carrierCode: "ups", packageRef: ref, adjustmentType: "reweight" })), error: null });
    install({
      tables: {
        adjustment_imports: [
          importRow({ status: "mapped", mapping: stored }),
          importRow({ id: overlapping, status: "committed", committed_count: 3, range_min: "2026-01-01", range_max: "2026-01-31", file_id: null }),
          importRow({ id: elsewhere, status: "committed", committed_count: 2, range_min: "2025-01-01", range_max: "2025-01-31", file_id: null }),
        ],
        uploaded_files: [storedUploadRow(text)],
        brands: brandsTable(),
      },
      rpc: {
        set_adjustment_import_mapping: { data: "validated", error: null },
        // The unique key of a record has no date in it: a late adjustment of a package shipped last year repeats a row of the new file all the same.
        adjustment_records_json: (args) => (args.p_import === overlapping ? holding(["1ZT0000000", "1ZT0000001", "1ZT0000002"]) : args.p_import === elsewhere ? holding(["1ZT0000007", "1ZT0000008"]) : { data: [], error: null }),
      },
    });
    // The two committed imports are listed under their own ids; the mapped one is the file being validated.
    db().tables.adjustment_imports!.forEach((r) => (r.tenant_id = TENANT));
    const r = await actions.validateImport(IMPORT, true);
    expect(r).toMatchObject({ ok: true });
    // Five of the ten rows repeat a package an earlier file added, so they are skipped and counted, and the counts the 3PL approves are the counts that commit.
    expect(r.report!.counts).toMatchObject({ rows: 10, alreadyImported: 5, accepted: 5 });
    expect(db().rpcNamed("adjustment_records_json").map((a) => a.p_import).sort()).toEqual([overlapping, elsewhere].sort());
  });

  it("refuses an import in another workspace, one that is committed, and a mapping that was never saved", async () => {
    const text = historyCsv(3);
    install({ tables: { adjustment_imports: [importRow({ tenant_id: OTHER_TENANT })], uploaded_files: [storedUploadRow(text)] } });
    expect(await actions.validateImport(IMPORT, true)).toEqual({ ok: false, message: "Import not found." });
    install({ tables: { adjustment_imports: [importRow({ status: "committed" })] } });
    expect(await actions.validateImport(IMPORT, true)).toEqual({ ok: false, message: "This import is no longer being edited." });
    install({ tables: { adjustment_imports: [importRow()], uploaded_files: [storedUploadRow(text)], brands: brandsTable() } });
    expect(await actions.validateImport(IMPORT, true)).toEqual({ ok: false, message: "Save the mapping first." });
    expect(db().rpcs).toEqual([]);
  });

  it("says in words when the database refuses the attestation", async () => {
    const text = historyCsv(3);
    const { stored } = await proposal(text);
    install({
      tables: { adjustment_imports: [importRow({ status: "mapped", mapping: stored })], uploaded_files: [storedUploadRow(text)], brands: brandsTable() },
      rpc: { set_adjustment_import_mapping: { data: null, error: { code: "P0001", message: "confirm that the amounts are what your customers were charged" } } },
    });
    expect(await actions.validateImport(IMPORT, true)).toMatchObject({ ok: false, message: expect.stringContaining("not what the carrier billed you") });
  });
});

describe("commitImport", () => {
  /** A validated import of `rows` rows whose stored file is the generated CSV. */
  async function validated(rows: number, over: Row = {}) {
    const text = historyCsv(rows);
    const { stored, result } = await proposal(text);
    return { text, stored, row: importRow({ status: "validated", mapping: stored, row_count: rows, accepted_count: result.report.counts.accepted, attested_at: "2026-10-15T10:05:00Z", ...over }) };
  }
  const withDb = (text: string, row: Row, rpc: Record<string, unknown>) =>
    install({ tables: { adjustment_imports: [row], uploaded_files: [storedUploadRow(text)], brands: brandsTable() }, rpc: rpc as never });

  it("sends 4,500 rows in chunks of 2,000, 2,000 and 500 in order, checks the totals and finalizes last", async () => {
    const { text, row } = await validated(4500);
    const state = { committed: 0, skipped: 0, accepted: 4500 };
    withDb(text, row, { append_adjustment_records: appendEmulator(state), finalize_adjustment_import: { data: { importId: IMPORT, committed: 4500, skipped: 0 }, error: null }, reset_adjustment_import: { data: null, error: null } });
    const r = await actions.commitImport(IMPORT);
    expect(r).toEqual({ ok: true, committed: 4500, skipped: 0, message: "4,500 rows were added." });
    const chunks = db().rpcNamed("append_adjustment_records");
    expect(chunks.map((c) => [c.p_from_row, (c.p_rows as unknown[]).length])).toEqual([[1, 2000], [2001, 2000], [4001, 500]]);
    expect(chunks.every((c) => c.p_import === IMPORT)).toBe(true);
    // Every key the database knows, null for unknown (never 0), in file order.
    const first = (chunks[0]!.p_rows as Record<string, unknown>[])[0]!;
    expect(first).toMatchObject({ carrier_code: "ups", adjustment_type: "reweight", package_ref: "1ZT0000000", original_charge: "10.00", corrected_charge: "11.50", separate_fee: "3.00", brand_id: null, service_id: null, actual_weight_lb: "3" });
    const rpcOrder = db().log.filter((l) => l.startsWith("rpc:"));
    expect(rpcOrder.slice(-4)).toEqual(["rpc:append_adjustment_records", "rpc:append_adjustment_records", "rpc:append_adjustment_records", "rpc:finalize_adjustment_import"]);
    expect(db().rpcNamed("reset_adjustment_import")).toEqual([]);
    expect(h.limits).toEqual(["adjustment.commit"]);
  });

  it("resets the import and stores nothing when a chunk is refused, without sending the rest or finalizing", async () => {
    const { text, row } = await validated(4500);
    let calls = 0;
    withDb(text, row, {
      append_adjustment_records: () => (++calls === 2 ? { data: null, error: { code: "PC001", message: "row 2017: invalid_weight" } } : { data: { applied: true, inserted: 2000, skipped: 0, nextRow: 2001, committed: 2000, skippedTotal: 0 }, error: null }),
      finalize_adjustment_import: { data: {}, error: null },
      reset_adjustment_import: { data: null, error: null },
    });
    const r = await actions.commitImport(IMPORT);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Row 2017 of the file was refused: a weight is zero, negative or unreadable");
    expect(r.message).toContain("Nothing from this import was kept");
    expect(db().rpcNamed("append_adjustment_records")).toHaveLength(2);
    expect(db().rpcNamed("reset_adjustment_import")).toEqual([{ p_import: IMPORT }]);
    expect(db().rpcNamed("finalize_adjustment_import")).toEqual([]);
  });

  it("resets and says so when what was stored plus what was already imported does not equal what was validated", async () => {
    const { text, row } = await validated(10);
    withDb(text, row, {
      append_adjustment_records: { data: { applied: true, inserted: 9, skipped: 0, nextRow: 11, committed: 9, skippedTotal: 0 }, error: null },
      finalize_adjustment_import: { data: {}, error: null },
      reset_adjustment_import: { data: null, error: null },
    });
    const r = await actions.commitImport(IMPORT);
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("do not match the rows checked") });
    expect(db().rpcNamed("reset_adjustment_import")).toHaveLength(1);
    expect(db().rpcNamed("finalize_adjustment_import")).toEqual([]);
  });

  it("resets when the database's cursor does not stand where the chunk ends (rows lost or repeated)", async () => {
    const { text, row } = await validated(10);
    withDb(text, row, { append_adjustment_records: { data: { applied: true, inserted: 10, skipped: 0, nextRow: 5, committed: 10, skippedTotal: 0 }, error: null }, finalize_adjustment_import: { data: {}, error: null }, reset_adjustment_import: { data: null, error: null } });
    expect(await actions.commitImport(IMPORT)).toMatchObject({ ok: false, message: expect.stringContaining("out of step") });
    expect(db().rpcNamed("reset_adjustment_import")).toHaveLength(1);
  });

  it("resets when finalizing is refused, and tells the person when even the reset failed", async () => {
    const { text, row } = await validated(10);
    const state = { committed: 0, skipped: 0, accepted: 10 };
    withDb(text, row, { append_adjustment_records: appendEmulator(state), finalize_adjustment_import: { data: null, error: { code: "PC003", message: "the stored rows do not match the validated count" } }, reset_adjustment_import: { data: null, error: null } });
    expect(await actions.commitImport(IMPORT)).toMatchObject({ ok: false, message: expect.stringContaining("was not finished") });
    expect(db().rpcNamed("reset_adjustment_import")).toHaveLength(1);
    const state2 = { committed: 0, skipped: 0, accepted: 10 };
    withDb(text, row, { append_adjustment_records: appendEmulator(state2), finalize_adjustment_import: { data: null, error: { code: "XX000", message: "boom" } }, reset_adjustment_import: { data: null, error: { code: "XX000", message: "boom" } } });
    expect(await actions.commitImport(IMPORT)).toMatchObject({ ok: false, message: expect.stringContaining("could not be rolled back automatically") });
  });

  it("counts rows the database skipped as already imported and still reconciles", async () => {
    const { text, row } = await validated(10);
    withDb(text, row, {
      append_adjustment_records: { data: { applied: true, inserted: 8, skipped: 2, nextRow: 11, committed: 8, skippedTotal: 2 }, error: null },
      finalize_adjustment_import: { data: {}, error: null },
      reset_adjustment_import: { data: null, error: null },
    });
    expect(await actions.commitImport(IMPORT)).toEqual({ ok: true, committed: 8, skipped: 2, message: "8 rows were added; 2 were already imported and skipped." });
  });

  it("starts an interrupted commit over: it is reset first, then every chunk is sent from row 1", async () => {
    const { text, row } = await validated(10, { status: "committing", committed_count: 4 });
    const state = { committed: 0, skipped: 0, accepted: 10 };
    withDb(text, row, { append_adjustment_records: appendEmulator(state), finalize_adjustment_import: { data: {}, error: null }, reset_adjustment_import: { data: null, error: null } });
    expect(await actions.commitImport(IMPORT)).toMatchObject({ ok: true });
    expect(db().log.filter((l) => l.startsWith("rpc:")).slice(0, 2)).toEqual(["rpc:reset_adjustment_import", "rpc:append_adjustment_records"]);
    expect(db().rpcNamed("append_adjustment_records")[0]!.p_from_row).toBe(1);
  });

  it("refuses without the attestation, before validation, after commit, and when the file no longer reads as it did when it was approved", async () => {
    const { text, row } = await validated(10);
    withDb(text, { ...row, attested_at: null }, {});
    expect(await actions.commitImport(IMPORT)).toMatchObject({ ok: false, message: expect.stringContaining("not what the carrier billed you") });
    withDb(text, { ...row, status: "mapped" }, {});
    expect(await actions.commitImport(IMPORT)).toMatchObject({ ok: false, message: expect.stringContaining("validated") });
    withDb(text, { ...row, status: "committed" }, {});
    expect(await actions.commitImport(IMPORT)).toEqual({ ok: false, message: "This import has already been committed." });
    // Approved with 11 rows to add; the file now yields 10.
    withDb(text, { ...row, accepted_count: 11, row_count: 11 }, { append_adjustment_records: { data: null, error: null } });
    expect(await actions.commitImport(IMPORT)).toMatchObject({ ok: false, message: expect.stringContaining("reads differently now") });
    expect(db().rpcs).toEqual([]);
  });

  it("refuses an import of another workspace", async () => {
    const { text, row } = await validated(5);
    withDb(text, { ...row, tenant_id: OTHER_TENANT }, {});
    expect(await actions.commitImport(IMPORT)).toEqual({ ok: false, message: "Import not found." });
    expect(db().rpcs).toEqual([]);
  });
});

describe("discardImport and withdrawImport", () => {
  it("discards and withdraws imports of this workspace only", async () => {
    install({ tables: { adjustment_imports: [{ id: IMPORT, tenant_id: TENANT }] }, rpc: { discard_adjustment_import: { data: null, error: null }, withdraw_adjustment_import: { data: { importId: IMPORT, deleted: 40 }, error: null } } });
    expect(await actions.discardImport(IMPORT)).toEqual({ ok: true, message: "Import discarded." });
    expect(await actions.withdrawImport(IMPORT)).toEqual({ ok: true, deleted: 40, message: "Import withdrawn. Its records were deleted." });
    expect(db().rpcNamed("discard_adjustment_import")).toEqual([{ p_import: IMPORT }]);
    install({ tables: { adjustment_imports: [{ id: IMPORT, tenant_id: OTHER_TENANT }] } });
    expect(await actions.discardImport(IMPORT)).toEqual({ ok: false, message: "Import not found." });
    expect(await actions.withdrawImport(IMPORT)).toEqual({ ok: false, message: "Import not found." });
    expect(db().rpcs).toEqual([]);
  });

  it("reads the database's refusals in words", async () => {
    install({ tables: { adjustment_imports: [{ id: IMPORT, tenant_id: TENANT }] }, rpc: { discard_adjustment_import: { data: null, error: { code: "P0004", message: "a committed import is withdrawn, not discarded" } }, withdraw_adjustment_import: { data: null, error: { code: "P0001", message: "saved risk estimates are based on this import; archive them first" } } } });
    expect(await actions.discardImport(IMPORT)).toEqual({ ok: false, message: "A committed import is withdrawn, not discarded." });
    expect(await actions.withdrawImport(IMPORT)).toEqual({ ok: false, message: "Saved risk estimates are based on this import. Archive them first." });
  });
});

describe("a few ids from the browser", () => {
  it("never reaches the database with something that is not an id", async () => {
    for (const bad of ["", "x", "1", "00000000-0000-0000-0000-00000000000"]) {
      expect(await actions.endPolicy(bad)).toMatchObject({ ok: false });
      expect(await actions.discardImport(bad)).toMatchObject({ ok: false });
      expect(await actions.withdrawImport(bad)).toMatchObject({ ok: false });
      expect(await actions.commitImport(bad)).toMatchObject({ ok: false });
      expect(await actions.deleteBaseline(bad)).toMatchObject({ ok: false });
      expect(await actions.archiveScenario(bad)).toMatchObject({ ok: false });
      expect(await actions.retireExample(bad)).toMatchObject({ ok: false });
      expect(await actions.archiveRiskEstimate(bad)).toMatchObject({ ok: false });
    }
    expect(db().calls).toEqual([]);
    expect(db().rpcs).toEqual([]);
    expect(NEW_ID).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The review's findings F2, F3, F9 and the orphaned file, at the action
// ---------------------------------------------------------------------------
describe("uploadAdjustmentFile: nothing is stored for a file the guard cannot vouch for, and nothing is left behind when a later step fails", () => {
  const happyDb = (extra: Parameters<typeof makeDb>[0] = {}) =>
    install({ tables: { adjustment_imports: [], brands: brandsTable() }, rpc: { create_adjustment_import: { data: { ok: true, importId: IMPORT }, error: null }, discard_unattached_adjustment_file: { data: null, error: null } }, inserted: { uploaded_files: { id: FILE } }, ...extra });
  const nothingStored = () => {
    expect(db().writes(), "zero writes of any kind").toEqual([]);
    expect(db().rpcs, "no function call").toEqual([]);
  };

  it("F2: a title row above a cost header, and a headerless export, are refused before anything is stored", async () => {
    happyDb();
    const titled = "Acme Logistics,Weekly report,Run 7\nship_date,carrier,adjustment_type,Net Charge,Carrier Cost\n2026-09-01,UPS,reweight,12.00,9.10\n";
    const r1 = await actions.uploadAdjustmentFile(initial, form(csvFile(titled)));
    expect(r1).toMatchObject({ ok: false, refused: true });
    expect(r1.message).toContain('"Carrier Cost"');
    expect(r1.message).not.toContain("9.10");
    const r2 = await actions.uploadAdjustmentFile(initial, form(csvFile("2026-09-01,UPS Ground,1Z999AA10123456784,12.34,9.10,3.2,reweight\n")));
    expect(r2).toMatchObject({ ok: false, errors: { file: expect.stringContaining("Put the column names in row 1") } });
    nothingStored();
  });

  it("F3: UTF-16 text, a NUL byte and a sheet wider than 200 columns are refused before anything is stored, with the way out in the message", async () => {
    happyDb();
    const text = "ship_date,carrier,adjustment_type,Carrier Cost\r\n2026-01-01,UPS,reweight,9.50\r\n";
    const utf16 = new File([Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])], "x.csv", { type: "text/csv" });
    expect(await actions.uploadAdjustmentFile(initial, form(utf16))).toMatchObject({ ok: false, errors: { file: expect.stringContaining("CSV UTF-8") } });
    const withNul = new File([Buffer.from("ship_date,carrier,adjustment_type\n2026-01-01,UPS,rew\u0000eight\n")], "x.csv", { type: "text/csv" });
    expect(await actions.uploadAdjustmentFile(initial, form(withNul))).toMatchObject({ ok: false, errors: { file: expect.stringContaining("CSV UTF-8") } });
    const wide = ["ship_date", "carrier", "adjustment_type", ...Array.from({ length: 197 }, (_, i) => `c${i}`), "Carrier Cost"];
    expect(await actions.uploadAdjustmentFile(initial, form(csvFile(`${wide.join(",")}\n${wide.map(() => "1").join(",")}\n`)))).toMatchObject({ ok: false, errors: { file: expect.stringContaining("more than 200 columns") } });
    nothingStored();
  });

  it("F13: one refusal names every refused header of the file, not the first only", async () => {
    happyDb();
    const text = "ship_date,carrier,adjustment_type,Net Weight,Carrier Cost,Label Date\n2026-09-01,UPS,reweight,3,9.10,2026-08-30\n";
    const r = await actions.uploadAdjustmentFile(initial, form(csvFile(text)));
    expect(r).toMatchObject({ ok: false, refused: true });
    for (const header of ["Net Weight", "Carrier Cost", "Label Date"]) expect(r.message).toContain(`"${header}"`);
    nothingStored();
  });

  it("F3 (the orphan): when the import cannot be created the stored file is removed through discard_unattached_adjustment_file, once, with its id", async () => {
    happyDb({ rpc: { create_adjustment_import: { data: null, error: { code: "53400", message: "too many imports; try again later" } }, discard_unattached_adjustment_file: { data: null, error: null } } });
    const r = await actions.uploadAdjustmentFile(initial, form(csvFile(historyCsv(3))));
    expect(r).toMatchObject({ ok: false });
    expect(db().log.indexOf("insert:uploaded_files")).toBeLessThan(db().log.indexOf("rpc:create_adjustment_import"));
    expect(db().log.indexOf("rpc:create_adjustment_import")).toBeLessThan(db().log.indexOf("rpc:discard_unattached_adjustment_file"));
    expect(db().rpcNamed("discard_unattached_adjustment_file")).toEqual([{ p_file: FILE }]);
    expect(r.message).not.toContain("still stored");
  });

  it("F3 (the orphan): a thrown error, an answer nobody can read and an import row that is not an id all remove the file too", async () => {
    happyDb({ rpc: { create_adjustment_import: () => { throw new Error("connection reset"); }, discard_unattached_adjustment_file: { data: null, error: null } } });
    expect(await actions.uploadAdjustmentFile(initial, form(csvFile(historyCsv(3))))).toEqual({ ok: false, message: "Something went wrong. Please try again." });
    expect(db().rpcNamed("discard_unattached_adjustment_file")).toEqual([{ p_file: FILE }]);
    happyDb({ rpc: { create_adjustment_import: { data: { ok: true, importId: "not-an-id" }, error: null }, discard_unattached_adjustment_file: { data: null, error: null } } });
    expect(await actions.uploadAdjustmentFile(initial, form(csvFile(historyCsv(3))))).toMatchObject({ ok: false });
    expect(db().rpcNamed("discard_unattached_adjustment_file")).toEqual([{ p_file: FILE }]);
    happyDb({ rpc: { create_adjustment_import: { data: null, error: null }, discard_unattached_adjustment_file: { data: null, error: null } } });
    expect(await actions.uploadAdjustmentFile(initial, form(csvFile(historyCsv(3))))).toMatchObject({ ok: false });
    expect(db().rpcNamed("discard_unattached_adjustment_file")).toEqual([{ p_file: FILE }]);
  });

  it("F3 (the orphan): when even the removal fails the person is told the file is still stored; 'not found' from the removal means there is nothing left to remove", async () => {
    const failing = (code: string) => happyDb({ rpc: { create_adjustment_import: { data: null, error: { code: "P0001", message: "boom" } }, discard_unattached_adjustment_file: { data: null, error: { code, message: "x" } } } });
    failing("XX000");
    expect(await actions.uploadAdjustmentFile(initial, form(csvFile(historyCsv(3))))).toMatchObject({ ok: false, message: expect.stringContaining("could not be removed automatically, so it is still stored") });
    failing("P0002");
    expect(await actions.uploadAdjustmentFile(initial, form(csvFile(historyCsv(3))))).toMatchObject({ ok: false, message: expect.not.stringContaining("still stored") });
    happyDb({ rpc: { create_adjustment_import: { data: null, error: { code: "P0001", message: "boom" } }, discard_unattached_adjustment_file: () => { throw new Error("down"); } } });
    expect(await actions.uploadAdjustmentFile(initial, form(csvFile(historyCsv(3))))).toMatchObject({ ok: false, message: expect.stringContaining("still stored") });
  });

  it("F3: an answer {ok:false} means the database deleted the file itself: an unreadable encoding and an unknown reason are reported without a second delete", async () => {
    happyDb({ rpc: { create_adjustment_import: { data: { ok: false, reason: "unsupported_encoding" }, error: null } } });
    expect(await actions.uploadAdjustmentFile(initial, form(csvFile(historyCsv(3))))).toMatchObject({ ok: false, message: expect.stringContaining("CSV UTF-8") });
    happyDb({ rpc: { create_adjustment_import: { data: { ok: false, reason: "something_new" }, error: null } } });
    expect(await actions.uploadAdjustmentFile(initial, form(csvFile(historyCsv(3))))).toEqual({ ok: false, message: "Something went wrong. Please try again." });
    expect(db().rpcNamed("discard_unattached_adjustment_file")).toEqual([]);
  });

  it("F3: the database's own scan of the stored bytes (an insert trigger) is read as the same refusals, and no import is attempted after it", async () => {
    const refusedWith = (hint: string, details: string | null = null) => happyDb({ errors: { "uploaded_files:insert": { code: "P0001", message: "this file was not saved", hint, details } } });
    refusedWith("forbidden_header", "Postage Cost");
    expect(await actions.uploadAdjustmentFile(initial, form(csvFile(historyCsv(3))))).toMatchObject({ ok: false, refused: true, message: expect.stringContaining('"Postage Cost"') });
    refusedWith("unsupported_encoding");
    expect(await actions.uploadAdjustmentFile(initial, form(csvFile(historyCsv(3))))).toMatchObject({ ok: false, errors: { file: expect.stringContaining("CSV UTF-8") } });
    refusedWith("too_many_unattached_files");
    expect(await actions.uploadAdjustmentFile(initial, form(csvFile(historyCsv(3))))).toMatchObject({ ok: false, message: expect.stringContaining("waiting for an import") });
    expect(db().rpcs).toEqual([]);
  });

  it("F9: the file name, the type and everything sent as JSON carry no NUL character, whatever the file or the browser said", async () => {
    happyDb();
    const text = historyCsv(2);
    const named = new File([text], "Aug\u0000ust history.csv", { type: "text/csv\u0000" });
    await expect(actions.uploadAdjustmentFile(initial, form(named))).rejects.toThrow(`NEXT_REDIRECT:/app/adjustments/history/${IMPORT}`);
    const insert = db().inserts()[0]!.payload as { filename: string; mime_type: string };
    const [args] = db().rpcNamed("create_adjustment_import");
    const everything = JSON.stringify([insert.filename, insert.mime_type, args]);
    expect(everything).not.toContain("\\u0000");
    expect(insert.filename).toBe("Aug ust history.csv");
    expect(args).toMatchObject({ p_name: "Aug ust history" });
  });
});

