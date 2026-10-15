import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { asUser, expectDenied, sql } from "./harness";
import { buildWorld, type World } from "./world";

/**
 * Fee schedules, assignments, fees in bulk runs and forecasts (Milestone 4). Builds fee schedules
 * through the real flow as the 3PL administrator (create → rules → activate → assign), runs an orders
 * file of brand A against one and checks what every role can see and what the database recomputes
 * before it trusts a caller's summary. Every expected figure below was derived by hand from the
 * fixtures in this file, never from the SQL. All names, rates and quantities are fictional.
 */
let w: World;
let upsGround: string;
let cardId: string;
let rcVersion: string;
let fileA: string;
/** The schedule brand A is modeled on: pick fee, a monthly-volume tier, storage (with long-term), receiving, a $500 minimum. */
let main: { scheduleId: string; versionId: string; rules: Record<string, string> };
let emptySchedule: string;

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
const E4 = (dollars: number) => Math.round(dollars * 10000);
const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

/** Asserts a statement is rejected by Postgres with the given SQLSTATE (and a message matching `pattern`). */
async function expectCode(promise: Promise<unknown>, code: string, pattern: RegExp = /./): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code !== code || !pattern.test(e.message ?? "")) throw new Error(`Rejected, but with ${e.code ?? "no code"}: ${e.message}`);
    return;
  }
  throw new Error("Expected the statement to be rejected, but it succeeded.");
}

// ---------------------------------------------------------------------------
// Fixture builders: rules, schedules, order files, run inputs
// ---------------------------------------------------------------------------
interface RuleInput {
  key: string; name?: string; category?: string; scope?: string; basis?: string; method?: string; amount?: string | null; percent?: string | null; percentBase?: string | null;
  tiers?: unknown; includedQuantity?: string | null; includedPer?: string | null; minimumCharge?: string | null; conditions?: unknown; exclusiveGroup?: string | null; priority?: number | null;
  driver?: unknown; minimum?: unknown; position?: number;
}

async function insertRule(userId: string, versionId: string, r: RuleInput): Promise<string> {
  const method = r.method ?? "flat";
  const [row] = await asUser<{ id: string }>(
    userId,
    `insert into public.fee_rules (version_id, tenant_id, position, key, name, category, scope, basis, method, amount, percent, percent_base, tiers, included_quantity, included_per, minimum_charge, conditions, exclusive_group, priority, driver, minimum)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17::jsonb, $18, $19, $20::jsonb, $21::jsonb) returning id`,
    [versionId, w.t1.id, r.position ?? 0, r.key, r.name ?? r.key, r.category ?? "pick_pack", r.scope ?? "order", r.basis ?? "unit", method,
      r.amount === undefined ? (method === "flat" ? "1.00" : null) : r.amount, r.percent ?? null, r.percentBase ?? null, json(r.tiers), r.includedQuantity ?? null, r.includedPer ?? null,
      r.minimumCharge ?? null, json(r.conditions), r.exclusiveGroup ?? null, r.priority ?? null, json(r.driver), json(r.minimum)],
  );
  return row!.id;
}

const driverRule = (key: string, driverKey: string, amount: string, extra: Partial<RuleInput> & { longTerm?: unknown } = {}): RuleInput => {
  const { longTerm, ...rest } = extra;
  return { key, category: "storage", scope: "monthly", basis: "driver", amount, driver: { key: driverKey, label: `${driverKey.replace(/_/g, " ")}, on average`, unit: "pallets", kind: "monthly_quantity", ...(longTerm ? { longTerm } : {}) }, ...rest };
};
const minimumRule = (key: string, amount: string, categories: string[] = [], includeRuleKeys: string[] = []): RuleInput => ({
  key, category: "account", scope: "monthly", basis: "minimum", method: "minimum", amount: null, minimum: { amount, appliesTo: { categories, includeRuleKeys, excludeRuleKeys: [] }, includesShipping: false },
});

/** Inserts rules into a draft, tries to activate it, removes the rules again; returns the activation error. */
async function activationProblem(versionId: string, rules: RuleInput[]): Promise<string> {
  const inserted: string[] = [];
  for (const r of rules) inserted.push(await insertRule(w.t1.admin.id, versionId, r));
  let message = "";
  try {
    await asUser(w.t1.admin.id, "select public.activate_fee_schedule_version($1, '2026-01-01')", [versionId]);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  } finally {
    await asUser(w.t1.admin.id, "delete from public.fee_rules where id = any ($1::uuid[])", [inserted]);
  }
  if (!message) throw new Error("activation succeeded although the rules were invalid");
  return message;
}

async function createSchedule(name: string, rounding = "invoice_line"): Promise<{ scheduleId: string; versionId: string }> {
  const [r] = await asUser<{ r: { scheduleId: string; versionId: string } }>(w.t1.admin.id, "select public.create_fee_schedule($1, $2, null, $3) as r", [w.t1.id, name, rounding]);
  return r!.r;
}

async function buildMainSchedule(): Promise<typeof main> {
  const { scheduleId, versionId } = await createSchedule("Northwind standard fees");
  const defs: RuleInput[] = [
    { key: "pick", name: "Pick fee", basis: "unit", amount: "1.00", position: 0 },
    { key: "volume_pick", name: "Order handling (volume tier)", category: "other", basis: "order", method: "tiered", amount: null, position: 1,
      tiers: { on: "monthly_quantity", mode: "graduated", pricing: "rate", brackets: [{ upTo: "1000", amount: "3.00" }, { upTo: null, amount: "2.50" }] } },
    driverRule("storage_pallet", "pallets_stored", "18.00", { name: "Pallet storage", position: 2 }),
    driverRule("storage_long_term", "pallets_long_term", "25.00", { name: "Long-term pallet storage", position: 3, longTerm: { mode: "replace", replacesRuleKey: "storage_pallet", thresholdDays: 90 } }),
    driverRule("receiving_pallet", "pallets_received", "15.00", { name: "Pallet receiving", category: "receiving", position: 4 }),
    { ...minimumRule("account_minimum", "500.00", ["pick_pack"]), name: "Monthly minimum", position: 5 },
  ];
  const rules: Record<string, string> = {};
  for (const d of defs) rules[d.key] = await insertRule(w.t1.admin.id, versionId, d);
  await asUser(w.t1.admin.id, "select public.activate_fee_schedule_version($1, '2026-01-01')", [versionId]);
  return { scheduleId, versionId, rules };
}

interface OrderSpec { id: string; date: string | null; units: number | null; lines: [string | null, number][]; ships: { date: string | null; pkgs: (string | null)[] }[] }
/** What the database must derive for an order from the file (hand-derived here from the spec). */
interface OrderFacts { ext: string; firstRow: number; month: string | null; units: number | null; lines: number | null; skus: number | null; packages: number; shipments: number }

function rowsFor(specs: OrderSpec[]) {
  let row = 0;
  const facts: OrderFacts[] = [];
  const orders: Record<string, unknown>[] = [], lines: Record<string, unknown>[] = [], shipments: Record<string, unknown>[] = [], packages: Record<string, unknown>[] = [];
  for (const o of specs) {
    const firstRow = row + 1;
    orders.push({ external_order_id: o.id, order_date: o.date, destination_zip: "85001", origin_zip: "90001", residential: true, units: o.units, line_count: o.lines.length, cancelled: false, issues: [] });
    o.lines.forEach(([sku, units], i) => lines.push({ external_order_id: o.id, line_no: i + 1, sku, units }));
    o.ships.forEach((s, i) => {
      shipments.push({ external_order_id: o.id, seq: i + 1, row_no: ++row, external_shipment_id: `${o.id}-${i + 1}`, service_text: "UPS Ground", service_id: upsGround, origin_zip: null, destination_zip: null, ship_date: s.date, residential: null, issues: [] });
      s.pkgs.forEach((type, j) => packages.push({ external_order_id: o.id, shipment_seq: i + 1, seq: j + 1, weight: "1", weight_unit: "lb", length_in: null, width_in: null, height_in: null, declared_value: null, packaging_type: type, weight_derived: false, dimensions_derived: false }));
    });
    // RULES.md A2: lines = lines with units > 0, unknown (null) when there are none; distinct SKUs unknown when any counted line has no SKU.
    const counted = o.lines.filter(([, units]) => units > 0);
    const skus = counted.length === 0 || counted.some(([sku]) => sku === null) ? null : new Set(counted.map(([sku]) => sku)).size;
    const firstShip = o.ships.map((s) => s.date).filter((d): d is string => d !== null).sort()[0] ?? null;
    facts.push({ ext: o.id, firstRow, month: (o.date ?? firstShip)?.slice(0, 7) ?? null, units: o.units, lines: counted.length || null, skus, packages: o.ships.reduce((n, s) => n + s.pkgs.length, 0), shipments: o.ships.length });
  }
  return { orders, lines, shipments, packages, facts };
}

interface Shipment { id: string; order_id: string; row_no: number; packages: number }
interface Dataset { id: string; shipments: Shipment[]; orders: Record<string, { id: string } & OrderFacts> }

async function buildDataset(name: string, specs: OrderSpec[]): Promise<Dataset> {
  const rows = rowsFor(specs);
  const me = w.brandA.admin.id;
  const [ds] = await asUser<{ id: string }>(me, "insert into public.order_datasets (tenant_id, brand_id, file_id, name, detected) values ($1, $2, $3, $4, '{}') returning id", [w.t1.id, w.brandA.id, fileA, name]);
  const id = ds!.id;
  await asUser(me, "update public.order_datasets set status = 'mapped' where id = $1", [id]);
  await asUser(me, `update public.order_datasets set status = 'validated', mapping = '{}', validation = '{"counts": {"rows": 9}}' where id = $1`, [id]);
  await asUser(me, "select public.materialise_order_rows($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb)", [id, JSON.stringify(rows.orders), JSON.stringify(rows.lines), JSON.stringify(rows.shipments), JSON.stringify(rows.packages)]);
  await asUser(me, "select public.finalize_order_dataset($1)", [id]);
  const shipments = await asUser<Shipment & { ext: string }>(me, "select s.id, s.order_id, s.row_no::int as row_no, o.external_order_id as ext, (select count(*) from public.packages p where p.shipment_id = s.id)::int as packages from public.shipments s join public.orders o on o.id = s.order_id where s.dataset_id = $1 order by s.row_no", [id]);
  const orders: Dataset["orders"] = {};
  for (const f of rows.facts) orders[f.ext] = { id: shipments.find((s) => s.ext === f.ext)!.order_id, ...f };
  return { id, shipments, orders };
}

/** A shipping result as the shipping engine would report it: UPS Ground zone 5, $9.60 per shipment; undated shipments cannot be priced. */
const shipResult = (s: Shipment, ok: boolean) => ({
  shipment_id: s.id, order_id: s.order_id, row_no: s.row_no, status: ok ? "ok" : "unavailable", unavailable_reason: ok ? null : "date_missing",
  rate_card_version_id: ok ? rcVersion : null, ship_date: ok ? "2026-03-15" : null, zone: ok ? "5" : null, service_id: upsGround,
  billable_lb: Array.from({ length: s.packages }, () => "1.0"), definite: ok ? "9.60" : "0.00", estimated: "0.00", expected: ok ? "9.60" : "0.00",
  conditional_exposure: "0.00", unresolved: "0.00", lines: ok ? [[0, 960, "c", "d", 0]] : [], warning_codes: [],
});

type FeeLine = [number, number, "d" | "e"];
interface FeeSpec { status: string; lines?: FeeLine[]; unresolved?: { ruleKey: string; reason: string }[]; feeDate?: string | null; version?: string | null; month?: string | null; firstRow?: number; units?: number | null; definite?: number }
/** One order result; every quantity comes from the hand-derived facts unless the test overrides it to provoke a refusal. */
function orderResult(o: { id: string } & OrderFacts, f: FeeSpec) {
  const lines = f.lines ?? [];
  const sum = (cls: string) => lines.filter((l) => l[2] === cls).reduce((n, l) => n + l[1], 0);
  return {
    order_id: o.id, first_row_no: f.firstRow ?? o.firstRow, order_month: f.month === undefined ? o.month : f.month, fee_date: f.feeDate === undefined ? "2026-03-15" : f.feeDate,
    fee_schedule_version_id: f.version === undefined ? main.versionId : f.version, units: f.units === undefined ? o.units : f.units, lines: o.lines, distinct_skus: o.skus, packages: o.packages, shipments: o.shipments,
    assumed: {}, fee_status: f.status, processing_definite: f.definite ?? sum("d"), processing_estimated: sum("e"), fee_lines: lines, unresolved: f.unresolved ?? [], warning_codes: [],
  };
}
/** Dictionary index 0 = pick ($1.00 per unit, definite), 1 = volume_pick (pinned rate $3.00 at 3 orders a month, estimated). */
const feesFor = (units: number): FeeLine[] => [[0, E4(units), "d"], [1, 30000, "e"]];
const mainDictionary = () => [
  { ruleId: main.rules.pick, key: "pick", name: "Pick fee", category: "pick_pack", basis: "unit", scope: "order" },
  { ruleId: main.rules.volume_pick, key: "volume_pick", name: "Order handling (volume tier)", category: "other", basis: "order", scope: "order" },
];
const shipContexts = () => [{ ship_date: "2026-03-15", rate_card_version_id: rcVersion, rule_version_ids: [], zip_list_ids: [], override_ids: [], load_issues: [], unavailable_reason: null }];
const mainFeeContexts = () => [{ fee_date: "2026-03-15", fee_schedule_version_id: main.versionId, unavailable_reason: null }];

const advance = (userId: string, runId: string, from: number, to: number, results: unknown[], orderResults: unknown[], opts: { partial?: unknown; feeContexts?: unknown[] } = {}) =>
  asUser<{ r: { applied: boolean; status: string; nextRow: number; processed: number } }>(
    userId, "select public.advance_simulation_run($1, $2::bigint, $3::bigint, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb) as r",
    [runId, from, to, JSON.stringify(results), JSON.stringify(opts.partial ?? { version: 2, shipments: { seen: to } }), JSON.stringify(shipContexts()), JSON.stringify(orderResults), JSON.stringify(opts.feeContexts ?? mainFeeContexts())],
  );
interface FinishResult { modeledOrders: number; modeledShipments: number; modeledPackages: number; okShipments: number; unavailableShipments: number; expected: string; processingOrders: number; processingDefinite: string; processingEstimated: string; monthlyFixed: string | null; minimumTopUp: string | null; minimumStatus: string | null }
const finish = (userId: string, runId: string, summary: unknown, monthlyLines: unknown[], referenceData: unknown = { dictionary: [], feeDictionary: mainDictionary() }) =>
  asUser<{ r: FinishResult }>(userId, "select public.finish_simulation_run($1, $2::jsonb, $3::jsonb, '2.2.0', $4::jsonb) as r", [runId, JSON.stringify(summary), JSON.stringify(referenceData), JSON.stringify(monthlyLines)]);
const startRun = (userId: string, projectId: string, assumptions: unknown, basis = "fixed_date", asOf: string | null = "2026-03-15") =>
  asUser<{ id: string }>(userId, "select public.start_simulation_run($1, $2, $3, null, 'exclude', $4::jsonb) as id", [projectId, basis, asOf, JSON.stringify(assumptions)]);
const createProject = async (datasetId: string, name: string) => {
  const [p] = await asUser<{ id: string }>(w.brandA.admin.id, "insert into public.simulation_projects (tenant_id, brand_id, kind, name, dataset_id, rate_card_id) values ($1, $2, 'bulk', $3, $4, $5) returning id", [w.t1.id, w.brandA.id, name, datasetId, cardId]);
  return p!.id;
};

/** The answers of the main runs: 12 pallets stored of which 2 long-term (replace), receiving left unanswered. */
const answers = { fulfillment: { drivers: { pallets_stored: "12", pallets_long_term: "2" } } };
/** Hand-derived monthly lines for those answers: storage 10 × $18.00, long-term 2 × $25.00, receiving not modeled. */
const mainMonthlyLines = () => [
  { rule_id: main.rules.storage_pallet, quantity: "10", amount_e4: 1800000, status: "priced" },
  { rule_id: main.rules.storage_long_term, quantity: "2", amount_e4: 500000, status: "priced" },
  { rule_id: main.rules.receiving_pallet, quantity: null, amount_e4: null, status: "not_modeled" },
];
const minimum = (status: string, countedE4: number) => ({ ruleKey: "account_minimum", status, minimumE4: 5000000, countedE4, topUpE4: 5000000 - countedE4 });
/** `projected` = the monthly total the engine allocates (RULES.md D3–D5), which finish recomputes from the stored rows. */
const summaryFor = (s: { orders: number; shipments: number; expected: string; processing: { orders: number; definite: string; estimated: string }; minimums: unknown[]; minimumStatus: string; projected: string }) => ({
  version: 2, modeled: { orders: s.orders, shipments: s.shipments }, totals: { expected: s.expected, definite: s.expected, estimated: "0.00" }, processing: s.processing,
  monthly: { totalE4: 2300000 }, minimums: s.minimums, minimumStatus: s.minimumStatus, allocation: { monthly: { total: s.projected } }, feeEngineVersion: "1.0.0",
});

/** Four orders over the whole of March 2026 (380 units in the period) plus one undated order with a line that has no SKU. */
const MAIN_ORDERS: OrderSpec[] = [
  { id: "O-1", date: "2026-03-01", units: 100, lines: [["SKU-A", 100]], ships: [{ date: "2026-03-01", pkgs: ["box"] }] },
  { id: "O-2", date: "2026-03-10", units: 80, lines: [["SKU-B", 50], ["SKU-C", 30]], ships: [{ date: "2026-03-10", pkgs: ["Poly  Mailer"] }, { date: "2026-03-11", pkgs: [null] }] },
  { id: "O-3", date: "2026-03-31", units: 200, lines: [["SKU-A", 120], ["SKU-A", 80]], ships: [{ date: "2026-03-31", pkgs: ["box", "box"] }] },
  { id: "O-4", date: null, units: 5, lines: [["SKU-D", 3], [null, 2]], ships: [{ date: null, pkgs: ["box"] }] },
];

beforeAll(async () => {
  w = await buildWorld();
  [{ id: upsGround }] = (await sql<{ id: string }>("select id from public.shipping_services where carrier_code = 'ups' and code = 'ground'")) as [{ id: string }];
  const [card] = await asUser<{ id: string }>(w.t1.admin.id, "insert into public.rate_cards (tenant_id, name) values ($1, 'Fees card') returning id", [w.t1.id]);
  cardId = card!.id;
  const [v] = await asUser<{ id: string }>(w.t1.admin.id, "insert into public.rate_card_versions (rate_card_id, tenant_id, version_number) values ($1, $2, 1) returning id", [cardId, w.t1.id]);
  rcVersion = v!.id;
  await asUser(w.t1.admin.id, "insert into public.rate_card_service_terms (version_id, service_id, dim_divisor) values ($1, $2, 139)", [rcVersion, upsGround]);
  await asUser(w.t1.admin.id, "insert into public.rate_card_rows (version_id, service_id, zone, weight_min, weight_max, weight_unit, price) values ($1, $2, '5', 0, 1, 'lb', 9.60)", [rcVersion, upsGround]);
  await asUser(w.t1.admin.id, "insert into public.rate_card_zones (version_id, carrier_code, origin_prefix, dest_prefix_from, dest_prefix_to, zone) values ($1, 'ups', '900', '800', '899', '5')", [rcVersion]);
  await asUser(w.t1.admin.id, "select public.activate_rate_card_version($1, '2026-01-01')", [rcVersion]);
  await asUser(w.t1.admin.id, "insert into public.brand_rate_card_assignments (tenant_id, brand_id, rate_card_id) values ($1, $2, $3)", [w.t1.id, w.brandA.id, cardId]);
  const content = Buffer.from("order_id,destination_zip,weight\nX-1,85001,3\n");
  const [file] = await asUser<{ id: string }>(w.brandA.admin.id, "insert into public.uploaded_files (tenant_id, brand_id, purpose, filename, mime_type, byte_size, sha256, content) values ($1, $2, 'order_import', 'orders.csv', 'text/csv', $3, decode($4, 'hex'), $5) returning id", [w.t1.id, w.brandA.id, content.length, createHash("sha256").update(content).digest("hex"), content]);
  fileA = file!.id;
  main = await buildMainSchedule();
  emptySchedule = (await createSchedule("Nothing in it yet")).scheduleId;
});

// ---------------------------------------------------------------------------
// (a) Lifecycle
// ---------------------------------------------------------------------------
describe("fee schedule lifecycle", () => {
  let life: { scheduleId: string; versionId: string };
  let pickFee: string;
  let draft: string;

  it("create_fee_schedule makes an active schedule with an empty draft version 1, for fee managers only", async () => {
    life = await createSchedule("  Lifecycle fees ", "transaction");
    const [v] = await sql<{ version_number: number; status: string; rounding: string; rule_count: number; effective_date: string | null }>("select version_number, status, rounding, rule_count, effective_date from public.fee_schedule_versions where id = $1", [life.versionId]);
    expect(v).toEqual({ version_number: 1, status: "draft", rounding: "transaction", rule_count: 0, effective_date: null });
    expect((await sql<{ name: string; status: string }>("select name, status from public.fee_schedules where id = $1", [life.scheduleId]))[0]).toEqual({ name: "Lifecycle fees", status: "active" });
    await expectCode(asUser(w.t1.employee.id, "select public.create_fee_schedule($1, 'Nope')", [w.t1.id]), "42501", /not allowed/);
    await expectCode(asUser(w.t2.admin.id, "select public.create_fee_schedule($1, 'Nope')", [w.t1.id]), "42501", /not allowed/);
    await expectCode(asUser(w.brandA.admin.id, "select public.create_fee_schedule($1, 'Nope')", [w.t1.id]), "42501", /not allowed/);
    await expectDenied(asUser(w.t1.admin.id, "select public.create_fee_schedule($1, 'Bad rounding', null, 'nearest')", [w.t1.id]), /rounding must be/);
    await expectDenied(asUser(w.t1.admin.id, "select public.create_fee_schedule($1, 'Lifecycle fees')", [w.t1.id]), /fee_schedules_tenant_name_key|duplicate/);
  });

  it("the row trigger validates each rule with the validator's messages; only fee managers write rules", async () => {
    const admin = w.t1.admin.id;
    pickFee = await insertRule(admin, life.versionId, { key: "pick_fee", name: "Pick fee", amount: "1.25", includedQuantity: "1", includedPer: "order" });
    const bad: [RuleInput, RegExp][] = [
      [{ key: "Bad Key" }, /key must be a short slug/],
      [{ key: "pct", percent: "10" }, /percent applies to percent-of-shipping rules only/],
      [{ key: "pct2", basis: "shipping_percent", method: "flat" }, /percent method is for percent-of-shipping rules only/],
      [{ key: "t1", method: "tiered", tiers: { on: "order_quantity", mode: "graduated", pricing: "rate", brackets: [{ upTo: "5", amount: "1" }, { upTo: "3", amount: "0.5" }, { upTo: null, amount: "0.4" }] } }, /bracket edges must ascend/],
      [{ key: "t2", method: "tiered", tiers: { on: "order_quantity", mode: "graduated", pricing: "rate", brackets: [{ upTo: "5", amount: "1" }, { upTo: "9", amount: "0.5" }] } }, /last bracket must be open-ended/],
      [{ key: "t3", method: "tiered", tiers: { on: "order_quantity", mode: "volume", pricing: "rate", brackets: [{ upTo: null, amount: "1" }] }, includedQuantity: "1" }, /tiered rule has no free allowance/],
      [{ key: "t4", method: "tiered", tiers: { on: "order_quantity", mode: "graduated", pricing: "flat", brackets: [{ upTo: null, amount: "1" }] } }, /graduated tiers are priced per unit/],
      [{ key: "t5", method: "tiered", tiers: { on: "order_quantity", mode: "volume", pricing: "rate", brackets: [{ upTo: null, amount: "1", extra: true }] } }, /bracket has an unknown field/],
      [{ key: "pk", conditions: { packagingTypes: ["box"] } }, /packaging types condition applies to per-package rules only/],
      [{ key: "pk2", basis: "package", conditions: { packagingTypes: ["Box "] } }, /packaging types must be normalised/],
      [{ key: "d1", scope: "monthly", basis: "driver", category: "storage" }, /driver is required for driver rules and not allowed otherwise/],
      [{ key: "d2", driver: { key: "x", label: "x", unit: "x", kind: "order_share" } }, /driver is required for driver rules and not allowed otherwise/],
      [driverRule("d3", "pallets", "1", { driver: { key: "pallets", label: "Pallets", unit: "pallets", kind: "monthly_quantity", bonus: 1 } }), /driver has an unknown field/],
      [{ key: "d4", basis: "order_driver", driver: { key: "inserts", label: "Inserts", unit: "inserts", kind: "monthly_quantity" } }, /per-order driver is answered as a share of orders/],
      [{ ...minimumRule("m1", "100"), minimum: { amount: "100", appliesTo: { categories: [], includeRuleKeys: [], excludeRuleKeys: [] }, includesShipping: "yes" } }, /minimum.includesShipping must be true or false/],
      [{ ...minimumRule("m2", "100"), minimum: { amount: "1e3", appliesTo: { categories: [], includeRuleKeys: [], excludeRuleKeys: [] }, includesShipping: false } }, /minimum.amount must be a number/],
      [{ ...minimumRule("m3", "100"), minimum: { amount: "100", appliesTo: { categories: ["shipping"], includeRuleKeys: [], excludeRuleKeys: [] }, includesShipping: false } }, /unknown category/],
      [{ key: "m4", minimum: { amount: "100", appliesTo: { categories: [], includeRuleKeys: [], excludeRuleKeys: [] }, includesShipping: false } }, /minimum is required for account minimums and not allowed otherwise/],
      [{ key: "x1", exclusiveGroup: "grp" }, /needs a priority/],
      [{ key: "x2", priority: 1 }, /priority applies to rules in an exclusive group only/],
    ];
    for (const [rule, pattern] of bad) await expectCode(insertRule(admin, life.versionId, rule), "22023", pattern);
    expect(await sql("select 1 from public.fee_rules where version_id = $1", [life.versionId])).toHaveLength(1);
    // Staff-only text lives beside the rule, in tables brands have no policy for.
    await asUser(admin, "insert into public.fee_rule_sources (rule_id, tenant_id, source_reference) values ($1, $2, 'SENTINEL_SOURCE_7731: MSA clause 4.2')", [pickFee, w.t1.id]);
    await asUser(admin, "insert into public.fee_schedule_version_notes (version_id, tenant_id, notes) values ($1, $2, 'SENTINEL_NOTE_9942: approved by ops')", [life.versionId, w.t1.id]);
    // An employee with ratecard.view reads but never writes; brand users neither.
    await expectDenied(insertRule(w.t1.employee.id, life.versionId, { key: "emp" }), /row-level security/);
    expect(await asUser(w.t1.employee.id, "update public.fee_rules set amount = 9 where id = $1 returning id", [pickFee])).toHaveLength(0);
    expect(await asUser(w.t1.employee.id, "delete from public.fee_rules where id = $1 returning id", [pickFee])).toHaveLength(0);
    await expectDenied(asUser(w.t1.employee.id, "insert into public.fee_rule_sources (rule_id, tenant_id, source_reference) values ($1, $2, 'x')", [pickFee, w.t1.id]), /row-level security/);
    expect(await asUser(w.t1.employee.id, "select source_reference from public.fee_rule_sources where rule_id = $1", [pickFee])).toHaveLength(1);
    await expectDenied(insertRule(w.brandA.admin.id, life.versionId, { key: "brand" }), /row-level security/);
    expect(await asUser(w.brandA.admin.id, "select id from public.fee_schedule_versions where id = $1", [life.versionId])).toHaveLength(0);
    expect((await sql<{ amount: string }>("select amount::text as amount from public.fee_rules where id = $1", [pickFee]))[0]?.amount).toBe("1.2500");
  });

  it("activation checks the version as a whole, resolves the minimums, then freezes rules, sources and notes", async () => {
    const admin = w.t1.admin.id;
    const v1 = life.versionId;
    await expectCode(asUser(admin, "select public.activate_fee_schedule_version($1, '2026-01-01')", [(await sql<{ id: string }>("select id from public.fee_schedule_versions where schedule_id = $1", [emptySchedule]))[0]!.id]), "P0005", /at least one rule/);
    await insertRule(admin, v1, { key: "box_fee", name: "Box", category: "packaging", basis: "package", amount: "0.80", conditions: { packagingTypes: ["box"] }, position: 1 });
    await insertRule(admin, v1, { ...minimumRule("account_min", "250.00"), name: "Account minimum", position: 2 });
    expect(await activationProblem(v1, [minimumRule("m2", "1", ["other"]), minimumRule("m3", "1", ["other"]), minimumRule("m4", "1", ["other"])])).toMatch(/at most three account minimums/);
    expect(await activationProblem(v1, [minimumRule("m2", "1", ["pick_pack"])])).toMatch(/two account minimums count the same rule/);
    expect(await activationProblem(v1, [minimumRule("m2", "1", ["other"])])).toMatch(/counts no rule/);
    expect(await activationProblem(v1, [minimumRule("m2", "1", [], ["nope"])])).toMatch(/names a rule that is not in this version/);
    expect(await activationProblem(v1, [driverRule("lt", "lt_pallets", "20", { longTerm: { mode: "replace", replacesRuleKey: "nowhere", thresholdDays: 90 } })])).toMatch(/refers to a rule that is not in this version/);
    expect(await activationProblem(v1, [driverRule("lt", "lt_pallets", "20", { longTerm: { mode: "replace", replacesRuleKey: "pick_fee", thresholdDays: 90 } })])).toMatch(/must refer to a standard monthly-quantity rule/);
    expect(await activationProblem(v1, [driverRule("bins", "bins_stored", "2", { driver: { key: "bins_stored", label: "Bins", unit: "bins", kind: "monthly_quantity" } }), driverRule("lt", "lt_bins", "3", { longTerm: { mode: "surcharge", replacesRuleKey: "bins", thresholdDays: 60 } })])).toMatch(/must use the unit and billing period/);
    expect(await activationProblem(v1, [{ key: "box_fee2", category: "packaging", basis: "package", amount: "0.90", conditions: { packagingTypes: ["*", "box"] } }])).toMatch(/two packaging rules price the same packaging type/);
    expect(await activationProblem(v1, [{ key: "g1", basis: "package", exclusiveGroup: "pk", priority: 1 }, { key: "g2", basis: "unit", exclusiveGroup: "pk", priority: 2 }])).toMatch(/must share a basis/);
    expect(await activationProblem(v1, [{ key: "g1", basis: "package", exclusiveGroup: "pk", priority: 1 }, { key: "g2", basis: "package", exclusiveGroup: "pk", priority: 1 }])).toMatch(/distinct priorities/);
    expect(await activationProblem(v1, [driverRule("q1", "pallets", "1"), driverRule("q2", "pallets", "2", { driver: { key: "pallets", label: "Pallets", unit: "cases", kind: "monthly_quantity" } })])).toMatch(/share a driver key must ask the same question/);
    await expectDenied(asUser(admin, "select public.activate_fee_schedule_version($1, null)", [v1]), /effective date is required/);
    await expectDenied(asUser(admin, "select public.activate_fee_schedule_version($1, '2026-01-01', '2025-12-31')", [v1]), /must not precede/);
    await expectCode(asUser(w.t1.employee.id, "select public.activate_fee_schedule_version($1, '2026-01-01')", [v1]), "P0003", /version not found/);

    await asUser(admin, "select public.activate_fee_schedule_version($1, '2026-01-01')", [v1]);
    const [v] = await sql<{ status: string; effective_date: string; rule_count: number; activated_by: string }>("select status, effective_date::text, rule_count, activated_by from public.fee_schedule_versions where id = $1", [v1]);
    expect(v).toEqual({ status: "active", effective_date: "2026-01-01", rule_count: 3, activated_by: admin });
    expect((await sql<{ k: string[] }>("select resolved_rule_keys as k from public.fee_rules where version_id = $1 and key = 'account_min'", [v1]))[0]?.k).toEqual(["pick_fee", "box_fee"]);
    // Frozen: rules, sources and notes of a non-draft version cannot change, even by their manager.
    await expectCode(asUser(admin, "update public.fee_rules set amount = 2 where id = $1", [pickFee]), "42501", /not a draft/);
    await expectCode(asUser(admin, "delete from public.fee_rules where id = $1", [pickFee]), "42501", /not a draft/);
    await expectCode(asUser(admin, "insert into public.fee_rules (version_id, tenant_id, key, name, category, scope, basis, method, amount) values ($1, $2, 'late', 'Late', 'other', 'order', 'order', 'flat', 1)", [v1, w.t1.id]), "42501", /not a draft/);
    await expectCode(asUser(admin, "update public.fee_rule_sources set source_reference = 'x' where rule_id = $1", [pickFee]), "42501", /not a draft/);
    await expectCode(asUser(admin, "update public.fee_schedule_version_notes set notes = 'x' where version_id = $1", [v1]), "42501", /not a draft/);
    await expectCode(sql("delete from public.fee_rule_sources where rule_id = $1", [pickFee]), "42501", /not a draft/);
    // The resolved set and the lifecycle columns are the database's, not the client's.
    await expectCode(asUser(admin, "update public.fee_rules set resolved_rule_keys = '{pick_fee}' where id = $1", [pickFee]), "42501", /permission denied/);
    await expectCode(asUser(admin, "update public.fee_schedule_versions set status = 'draft' where id = $1", [v1]), "42501", /permission denied/);
    await expectCode(sql("update public.fee_schedule_versions set status = 'draft' where id = $1", [v1]), "42501", /lifecycle functions/);
    await expectCode(sql("update public.fee_schedule_versions set effective_date = '2026-02-01' where id = $1", [v1]), "42501", /lifecycle functions/);
    await expectCode(asUser(admin, "select public.activate_fee_schedule_version($1, '2026-01-01')", [v1]), "P0004", /only a draft/);
  });

  it("copy_fee_schedule_version copies rules under new ids with their sources and notes; one draft at a time", async () => {
    const admin = w.t1.admin.id;
    const [c] = await asUser<{ id: string }>(admin, "select public.copy_fee_schedule_version($1, $2) as id", [life.scheduleId, life.versionId]);
    draft = c!.id;
    const [v] = await sql<{ version_number: number; status: string; rounding: string }>("select version_number, status, rounding from public.fee_schedule_versions where id = $1", [draft]);
    expect(v).toEqual({ version_number: 2, status: "draft", rounding: "transaction" });
    const copied = await sql<{ id: string; key: string; amount: string | null; resolved_rule_keys: string[] | null }>("select id, key, amount::text as amount, resolved_rule_keys from public.fee_rules where version_id = $1 order by position", [draft]);
    expect(copied.map((r) => [r.key, r.amount, r.resolved_rule_keys])).toEqual([["pick_fee", "1.2500", null], ["box_fee", "0.8000", null], ["account_min", null, null]]);
    expect(copied.map((r) => r.id)).not.toContain(pickFee);
    expect(await sql("select 1 from public.fee_rule_sources s join public.fee_rules r on r.id = s.rule_id where r.version_id = $1 and r.key = 'pick_fee' and s.source_reference like 'SENTINEL_SOURCE_7731%'", [draft])).toHaveLength(1);
    expect(await sql("select 1 from public.fee_schedule_version_notes where version_id = $1 and notes like 'SENTINEL_NOTE_9942%'", [draft])).toHaveLength(1);
    await expectDenied(asUser(admin, "select public.copy_fee_schedule_version($1)", [life.scheduleId]), /already has a draft/);
    await expectCode(asUser(w.t1.employee.id, "select public.copy_fee_schedule_version($1)", [life.scheduleId]), "P0002", /not found/);
    await expectCode(asUser(w.t2.admin.id, "select public.copy_fee_schedule_version($1)", [life.scheduleId]), "P0002", /not found/);
    // The draft is editable again; its rounding can be changed directly, nothing else about the version.
    expect(await asUser(admin, "update public.fee_rules set amount = 1.30 where id = $1 returning id", [copied[0]!.id])).toHaveLength(1);
    expect(await asUser(admin, "update public.fee_schedule_versions set rounding = 'invoice_line' where id = $1 returning id", [draft])).toHaveLength(1);
    await expectCode(asUser(admin, "update public.fee_schedule_versions set version_number = 7 where id = $1", [draft]), "42501", /permission denied/);
    await asUser(admin, "select public.reorder_fee_rules($1, $2::uuid[])", [draft, [copied[2]!.id, copied[0]!.id, copied[1]!.id]]);
    expect((await sql<{ key: string }>("select key from public.fee_rules where version_id = $1 order by position", [draft])).map((r) => r.key)).toEqual(["account_min", "pick_fee", "box_fee"]);
    await expectDenied(asUser(admin, "select public.reorder_fee_rules($1, $2::uuid[])", [draft, [copied[0]!.id]]), /exactly once/);
  });

  it("versions are ended and archived through the lifecycle functions; a schedule in use cannot be archived", async () => {
    const admin = w.t1.admin.id;
    await expectDenied(asUser(admin, "select public.end_fee_schedule_version($1, '2025-12-31')", [life.versionId]), /must not precede/);
    await expectCode(asUser(admin, "select public.end_fee_schedule_version($1, '2026-12-31')", [draft]), "P0004", /only an active version/);
    await asUser(admin, "select public.end_fee_schedule_version($1, '2026-12-31')", [life.versionId]);
    expect((await sql<{ status: string; expiration_date: string }>("select status, expiration_date::text from public.fee_schedule_versions where id = $1", [life.versionId]))[0]).toEqual({ status: "active", expiration_date: "2026-12-31" });
    await expectCode(asUser(w.t1.employee.id, "select public.archive_fee_schedule_version($1)", [draft]), "P0003", /version not found/);
    await asUser(admin, "select public.archive_fee_schedule_version($1)", [draft]);
    expect((await sql<{ status: string }>("select status from public.fee_schedule_versions where id = $1", [draft]))[0]?.status).toBe("discarded");
    await expectCode(asUser(admin, "select public.archive_fee_schedule_version($1)", [draft]), "P0004", /already closed/);
    await expectCode(sql("update public.fee_schedule_versions set status = 'draft' where id = $1", [draft]), "42501", /archived or discarded version cannot change status/);
    // Brand A goes on the schedule now (so the visibility tests below can look at it); while it is, the schedule stays.
    const [a] = await asUser<{ id: string }>(admin, "select public.assign_fee_schedule($1, $2) as id", [w.brandA.id, life.scheduleId]);
    expect(a!.id).toMatch(/^[0-9a-f-]{36}$/);
    await expectCode(asUser(admin, "select public.archive_fee_schedule($1)", [life.scheduleId]), "P0001", /still on this fee schedule/);
    await expectCode(asUser(w.t1.employee.id, "select public.archive_fee_schedule($1)", [life.scheduleId]), "P0002", /not found/);
  });

  // ---------------------------------------------------------------------------
  // (b) Assignment and visibility
  // ---------------------------------------------------------------------------
  describe("assignments and what each role sees", () => {
    it("an assigned brand sees the schedule, its active version and rules; staff-only text never reaches it", async () => {
      const v1 = life.versionId;
      expect(ids(await asUser(w.brandA.admin.id, "select id from public.fee_schedules"))).toEqual([life.scheduleId]);
      expect(await asUser(w.brandA.employee.id, "select id, status from public.fee_schedule_versions where schedule_id = $1", [life.scheduleId])).toEqual([{ id: v1, status: "active" }]);
      expect(await asUser(w.brandA.admin.id, "select id from public.fee_schedule_versions where id = $1", [draft])).toHaveLength(0);
      expect(await asUser(w.brandA.employee.id, "select id from public.fee_rules where version_id = $1", [v1])).toHaveLength(3);
      expect(await asUser(w.brandA.admin.id, "select id from public.fee_rules where version_id = $1", [draft])).toHaveLength(0);
      expect(await asUser(w.brandA.admin.id, "select * from public.fee_rule_sources")).toHaveLength(0);
      expect(await asUser(w.brandA.admin.id, "select * from public.fee_schedule_version_notes")).toHaveLength(0);
      expect(await asUser(w.brandA.admin.id, "select id from public.brand_fee_schedule_assignments where schedule_id = $1 and unassigned_at is null", [life.scheduleId])).toHaveLength(1);
      type Snap = { name: string; versionId: string; rounding: string; rules: { key: string; resolvedRuleKeys?: string[]; description?: string }[] };
      const [snap] = await asUser<{ s: Snap }>(w.brandA.admin.id, "select public.fee_schedule_snapshot($1) as s", [v1]);
      expect(snap!.s).toMatchObject({ name: "Lifecycle fees", versionId: v1, rounding: "transaction" });
      expect(snap!.s.rules.map((r) => r.key)).toEqual(["pick_fee", "box_fee", "account_min"]);
      expect(snap!.s.rules[2]!.resolvedRuleKeys).toEqual(["pick_fee", "box_fee"]);
      expect(JSON.stringify(snap!.s)).not.toMatch(/SENTINEL/);
      const [on] = await asUser<{ s: { status: string; snapshot: Snap } }>(w.brandA.employee.id, "select public.brand_fee_schedule_on($1, '2026-03-15') as s", [w.brandA.id]);
      expect(on!.s.status).toBe("ok");
      expect(on!.s.snapshot.versionId).toBe(v1);
      expect(JSON.stringify(on!.s)).not.toMatch(/SENTINEL/);
      const [off] = await asUser<{ s: { status: string; name: string } }>(w.brandA.admin.id, "select public.brand_fee_schedule_on($1, '2027-01-01') as s", [w.brandA.id]);
      expect(off!.s).toEqual({ status: "not_effective", scheduleId: life.scheduleId, name: "Lifecycle fees" });
      // Staff see the staff-only text (and can ask on the brand's behalf); brand members write nothing.
      expect(await asUser(w.t1.employee.id, "select 1 from public.fee_rule_sources where source_reference like 'SENTINEL%'")).toHaveLength(2);
      expect(await asUser(w.t1.employee.id, "select 1 from public.fee_schedule_version_notes where notes like 'SENTINEL%'")).toHaveLength(2);
      expect((await asUser<{ s: { status: string } }>(w.t1.employee.id, "select public.brand_fee_schedule_on($1, '2026-03-15') as s", [w.brandA.id]))[0]!.s.status).toBe("ok");
      await expectDenied(asUser(w.brandA.admin.id, "insert into public.brand_fee_schedule_assignments (tenant_id, brand_id, schedule_id) values ($1, $2, $3)", [w.t1.id, w.brandA.id, main.scheduleId]), /permission denied/);
      await expectDenied(asUser(w.t1.admin.id, "insert into public.brand_fee_schedule_assignments (tenant_id, brand_id, schedule_id) values ($1, $2, $3)", [w.t1.id, w.brandB.id, main.scheduleId]), /permission denied/);
      await expectCode(asUser(w.brandA.admin.id, "select public.assign_fee_schedule($1, $2)", [w.brandA.id, main.scheduleId]), "P0002", /customer not found/);
      expect(await asUser(w.brandA.admin.id, "update public.fee_schedules set name = 'Mine' where id = $1 returning id", [life.scheduleId])).toHaveLength(0);
    });

    it("an unassigned brand of the same tenant, another tenant and an outsider see nothing", async () => {
      for (const user of [w.brandB.admin, w.brandC.admin, w.t2.admin, w.outsider, w.platformAdmin]) {
        expect(await asUser(user.id, "select id from public.fee_schedules"), user.email).toHaveLength(0);
        expect(await asUser(user.id, "select id from public.fee_schedule_versions"), user.email).toHaveLength(0);
        expect(await asUser(user.id, "select id from public.fee_rules"), user.email).toHaveLength(0);
        expect(await asUser(user.id, "select id from public.brand_fee_schedule_assignments"), user.email).toHaveLength(0);
        await expectCode(asUser(user.id, "select public.fee_schedule_snapshot($1)", [life.versionId]), "P0002", /not found/);
        await expectCode(asUser(user.id, "select public.brand_fee_schedule_on($1, '2026-03-15')", [w.brandA.id]), "P0002", /customer not found/);
      }
      expect((await asUser<{ s: { status: string } }>(w.brandB.admin.id, "select public.brand_fee_schedule_on($1, '2026-03-15') as s", [w.brandB.id]))[0]!.s).toEqual({ status: "no_schedule" });
      await expectCode(asUser(w.t2.admin.id, "select public.assign_fee_schedule($1, $2)", [w.brandC.id, main.scheduleId]), "P0002", /fee schedule not found/);
    });

    it("assign_fee_schedule needs an active version, replaces the current assignment in one transaction; unassign ends it", async () => {
      const admin = w.t1.admin.id;
      const [first] = await sql<{ id: string }>("select id from public.brand_fee_schedule_assignments where brand_id = $1 and unassigned_at is null", [w.brandA.id]);
      await expectCode(asUser(admin, "select public.assign_fee_schedule($1, $2)", [w.brandA.id, emptySchedule]), "P0001", /activate a version/);
      await expectCode(asUser(w.t1.employee.id, "select public.assign_fee_schedule($1, $2)", [w.brandA.id, main.scheduleId]), "P0002", /customer not found/);
      const [a2] = await asUser<{ id: string }>(admin, "select public.assign_fee_schedule($1, $2) as id", [w.brandA.id, main.scheduleId]);
      expect(a2!.id).not.toBe(first!.id);
      const [old] = await sql<{ ended: boolean; unassigned_by: string }>("select unassigned_at is not null as ended, unassigned_by from public.brand_fee_schedule_assignments where id = $1", [first!.id]);
      expect(old).toEqual({ ended: true, unassigned_by: admin });
      expect(ids(await asUser(w.brandA.admin.id, "select id from public.fee_schedules"))).toEqual([main.scheduleId]);
      expect(await asUser(w.brandA.admin.id, "select id from public.fee_rules where version_id = $1", [life.versionId])).toHaveLength(0);
      expect(await asUser(w.brandA.admin.id, "select id from public.fee_rules where version_id = $1", [main.versionId])).toHaveLength(6);
      // Assigning the schedule the brand is already on changes nothing.
      expect((await asUser<{ id: string }>(admin, "select public.assign_fee_schedule($1, $2) as id", [w.brandA.id, main.scheduleId]))[0]!.id).toBe(a2!.id);
      await asUser(admin, "select public.unassign_fee_schedule($1)", [a2!.id]);
      expect(await asUser(w.brandA.admin.id, "select id from public.fee_schedules")).toHaveLength(0);
      await asUser(admin, "select public.unassign_fee_schedule($1)", [a2!.id]); // already ended: no-op
      await expectCode(asUser(w.brandA.admin.id, "select public.unassign_fee_schedule($1)", [a2!.id]), "P0002", /assignment not found/);
      const [a3] = await asUser<{ id: string }>(admin, "select public.assign_fee_schedule($1, $2) as id", [w.brandA.id, main.scheduleId]);
      expect(a3!.id).not.toBe(a2!.id);
      expect(ids(await asUser(w.brandA.employee.id, "select id from public.fee_schedules"))).toEqual([main.scheduleId]);
      // A schedule nobody is on can be archived: its versions stay for history, it takes no new versions or customers.
      await asUser(admin, "select public.archive_fee_schedule($1)", [life.scheduleId]);
      expect((await sql<{ status: string }>("select status from public.fee_schedules where id = $1", [life.scheduleId]))[0]?.status).toBe("archived");
      expect((await sql<{ status: string }>("select status from public.fee_schedule_versions where id = $1", [life.versionId]))[0]?.status).toBe("active");
      await expectCode(asUser(admin, "select public.copy_fee_schedule_version($1)", [life.scheduleId]), "P0001", /archived schedule/);
      await expectCode(asUser(admin, "select public.assign_fee_schedule($1, $2)", [w.brandA.id, life.scheduleId]), "P0001", /archived schedule cannot be assigned/);
      await expectCode(asUser(admin, "update public.fee_schedules set status = 'active' where id = $1", [life.scheduleId]), "42501", /permission denied/);
      await expectCode(sql("update public.fee_schedules set status = 'active' where id = $1", [life.scheduleId]), "42501", /archive_fee_schedule/);
    });
  });

  // ---------------------------------------------------------------------------
  // (c) Audit
  // ---------------------------------------------------------------------------
  it("lifecycle and assignment events are written by triggers with the actor; nobody can forge them", async () => {
    const rows = await sql<{ action: string; actor_id: string | null; entity_id: string; brand_id: string | null }>("select action, actor_id, entity_id, brand_id from public.audit_events where tenant_id = $1 and action like 'ratecard.fee_%' order by id", [w.t1.id]);
    const by = (action: string) => rows.filter((r) => r.action === action);
    expect(by("ratecard.fee_schedule_created").map((r) => r.entity_id)).toEqual(expect.arrayContaining([main.scheduleId, life.scheduleId, emptySchedule]));
    expect(by("ratecard.fee_version_active").map((r) => r.entity_id)).toEqual([main.versionId, life.versionId]);
    expect(by("ratecard.fee_version_ended").map((r) => r.entity_id)).toEqual([life.versionId]);
    expect(by("ratecard.fee_version_discarded").map((r) => r.entity_id)).toEqual([draft]);
    expect(by("ratecard.fee_schedule_updated").map((r) => r.entity_id)).toEqual([life.scheduleId]);
    expect(by("ratecard.fee_assigned").map((r) => [r.entity_id, r.brand_id])).toEqual([[life.scheduleId, w.brandA.id], [main.scheduleId, w.brandA.id], [main.scheduleId, w.brandA.id]]);
    expect(by("ratecard.fee_unassigned").map((r) => r.entity_id)).toEqual([life.scheduleId, main.scheduleId]);
    expect(rows.every((r) => r.actor_id === w.t1.admin.id)).toBe(true);
    await expectCode(asUser(w.t1.admin.id, "select public.log_audit_event($1, $2, 'ratecard.fee_assigned', 'fee_schedule', $3)", [w.t1.id, w.brandA.id, main.scheduleId]), "42501", /not permitted/);
    await expectCode(asUser(w.brandA.admin.id, "select public.log_audit_event($1, $2, 'ratecard.fee_version_active', 'fee_schedule_version', $3)", [w.t1.id, w.brandA.id, main.versionId]), "42501", /not permitted/);
  });
});

// ---------------------------------------------------------------------------
// (d) One overload per function
// ---------------------------------------------------------------------------
describe("function signatures", () => {
  it("no function in the public schema has more than one overload", async () => {
    expect(await sql("select proname from pg_proc where pronamespace = 'public'::regnamespace group by proname having count(*) > 1")).toEqual([]);
    for (const fn of ["advance_simulation_run", "finish_simulation_run", "start_simulation_run", "save_forecast_run"]) {
      expect(await sql("select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = $1", [fn]), fn).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// (e) Runs
// ---------------------------------------------------------------------------
describe("runs with fees", () => {
  let ds: Dataset;
  let projectId: string;
  let runId: string;

  beforeAll(async () => {
    ds = await buildDataset("March, whole month", MAIN_ORDERS);
    projectId = await createProject(ds.id, "March with fees");
  });

  it("finalize assigns a dense order ordinal by first row; the forecast period is read from the file", async () => {
    const seqs = await asUser<{ ext: string; seq: number }>(w.brandA.admin.id, "select external_order_id as ext, seq from public.orders where dataset_id = $1 order by seq", [ds.id]);
    expect(seqs).toEqual([{ ext: "O-1", seq: 1 }, { ext: "O-2", seq: 2 }, { ext: "O-3", seq: 3 }, { ext: "O-4", seq: 4 }]);
    const [p] = await asUser<{ r: Record<string, unknown> }>(w.brandA.employee.id, "select public.dataset_forecast_period($1) as r", [ds.id]);
    expect(p!.r).toEqual({ population: 4, dated: 3, undated: 1, from: "2026-03-01", to: "2026-03-31", days: 31, months: 1, inPeriod: 3, trimmed: 0, units: 380, packages: 5, shipments: 4, monthProfile: [{ month: "2026-03", fraction: "1.000000", orders: 3 }] });
    await expectCode(asUser(w.brandB.admin.id, "select public.dataset_forecast_period($1)", [ds.id]), "P0002", /dataset not found/);
    await expectCode(asUser(w.t2.admin.id, "select public.dataset_forecast_period($1)", [ds.id]), "P0002", /dataset not found/);
  });

  it("start_simulation_run validates the fulfillment answers (PC001) and stores the period, the volume and the pinned rates", async () => {
    const start = (a: unknown) => startRun(w.brandA.admin.id, projectId, a);
    await expectCode(start({ fulfillment: { bogus: 1 } }), "PC001", /unknown field/);
    await expectCode(start({ fulfillment: { drivers: { nope: "1" } } }), "PC001", /not a question of this fee schedule/);
    await expectCode(start({ fulfillment: { drivers: { pallets_stored: "2", pallets_long_term: "5" } } }), "PC001", /exceeds the total stored/);
    await expectCode(start({ fulfillment: { orderContent: { rows: [{ units: 2, lines: 1, sharePct: "60.00" }, { units: 1, lines: 1, sharePct: "30.00" }] } } }), "PC001", /add up to exactly 100/);
    await expectCode(start({ fulfillment: { orderShares: { nope: { sharePct: "10.00", countPerOrder: 1 } } } }), "PC001", /not a question of this fee schedule/);
    await expectCode(start({ fulfillment: { monthlyOrders: "0" } }), "PC001", /monthly orders must be between/);
    await expectCode(start({ fulfillment: { drivers: { pallets_stored: "abc" } } }), "PC001", /must be a number/);
    expect(await sql("select 1 from public.simulation_runs where project_id = $1", [projectId])).toHaveLength(0);
    const [r] = await start(answers);
    runId = r!.id;
    const [run] = await asUser<Record<string, unknown>>(w.brandA.employee.id,
      `select forecast_from::text, forecast_to::text, forecast_days, forecast_months::text, month_profile, population_orders, period_orders, undated_orders, volume_basis,
              monthly_orders::text, monthly_units::text, monthly_packages::text, monthly_shipments::text, fee_schedule_id, monthly_fee_schedule_version_id, fee_rates
       from public.simulation_runs where id = $1`, [runId]);
    expect(run).toEqual({
      forecast_from: "2026-03-01", forecast_to: "2026-03-31", forecast_days: 31, forecast_months: "1.000000", month_profile: [{ month: "2026-03", fraction: "1.000000", orders: 3 }],
      population_orders: 4, period_orders: 3, undated_orders: 1, volume_basis: "file", monthly_orders: "3.0000", monthly_units: "380.0000", monthly_packages: "5.0000", monthly_shipments: "4.0000",
      fee_schedule_id: main.scheduleId, monthly_fee_schedule_version_id: main.versionId, fee_rates: { [main.versionId]: { volume_pick: { rateE4: 30000, monthlyQuantity: "3.0000" } } },
    });
    const [audit] = await sql<{ metadata: Record<string, unknown> }>("select metadata from public.audit_events where action = 'modeling.run_started' and entity_id = $1", [runId]);
    expect(audit!.metadata).toMatchObject({ fee_schedule_id: main.scheduleId, monthly_fee_schedule_version_id: main.versionId, volume_basis: "file" });
  });

  it("a short span has no file volume; a stated volume pins the monthly-volume tier at that volume", async () => {
    const short = await buildDataset("Three days", [
      { id: "S-1", date: "2026-03-02", units: 1, lines: [["SKU-A", 1]], ships: [{ date: "2026-03-02", pkgs: [null] }] },
      { id: "S-2", date: "2026-03-04", units: 2, lines: [["SKU-B", 2]], ships: [{ date: "2026-03-04", pkgs: [null] }] },
    ]);
    const project = await createProject(short.id, "Short span");
    const [r1] = await startRun(w.brandA.admin.id, project, {});
    const [none] = await asUser<Record<string, unknown>>(w.brandA.admin.id, "select volume_basis, monthly_orders, forecast_days, forecast_months::text, period_orders, fee_rates from public.simulation_runs where id = $1", [r1!.id]);
    expect(none).toEqual({ volume_basis: "none", monthly_orders: null, forecast_days: 3, forecast_months: "0.096774", period_orders: 2, fee_rates: { [main.versionId]: {} } });
    await asUser(w.brandA.admin.id, "select public.cancel_simulation_run($1)", [r1!.id]);
    const [r2] = await startRun(w.brandA.admin.id, project, { fulfillment: { monthlyOrders: "3000" } });
    const [stated] = await asUser<Record<string, unknown>>(w.brandA.admin.id, "select volume_basis, monthly_orders::text, fee_rates from public.simulation_runs where id = $1", [r2!.id]);
    // graduated: 1,000 × $3.00 + 2,000 × $2.50 = $8,000 over 3,000 orders = $2.6667 an order.
    expect(stated).toEqual({ volume_basis: "stated", monthly_orders: "3000.0000", fee_rates: { [main.versionId]: { volume_pick: { rateE4: 26667, monthlyQuantity: "3000.0000" } } } });
    await asUser(w.brandA.admin.id, "select public.cancel_simulation_run($1)", [r2!.id]);
  });

  it("batch input carries the order's content and ordinal; advance refuses results that disagree with the file or the fee contexts", async () => {
    type Batch = { fromRow: number; toRow: number; shipments: { rowNo: number; orderSeq: number; orderUnits: number; orderLines: number; orderSkus: number; orderNullSkuLines: number; orderShipments: number; packages: { packagingType: string | null; packagingTypeNormalized: string | null }[] }[] };
    const [b] = await asUser<{ r: Batch }>(w.brandA.admin.id, "select public.simulation_batch_input($1, 2) as r", [runId]);
    expect([b!.r.fromRow, b!.r.toRow]).toEqual([1, 3]);
    expect(b!.r.shipments[1]).toMatchObject({ rowNo: 2, orderSeq: 2, orderUnits: 80, orderLines: 2, orderSkus: 2, orderNullSkuLines: 0, orderShipments: 2, packages: [{ packagingType: "Poly  Mailer", packagingTypeNormalized: "poly mailer" }] });
    expect(b!.r.shipments[2]!.packages).toEqual([expect.objectContaining({ packagingType: null, packagingTypeNormalized: null })]);
    expect(b!.r.shipments[0]).toMatchObject({ orderSeq: 1, orderLines: 1, orderSkus: 1 });

    const [s1, s2a, s2b] = ds.shipments as [Shipment, Shipment, Shipment];
    const o1 = ds.orders["O-1"]!, o2 = ds.orders["O-2"]!;
    const results = [shipResult(s1, true), shipResult(s2a, true), shipResult(s2b, true)];
    const good = [orderResult(o1, { status: "ok", lines: feesFor(100) }), orderResult(o2, { status: "ok", lines: feesFor(80) })];
    const adv = (orders: unknown[], opts: { partial?: unknown; feeContexts?: unknown[] } = {}) => advance(w.brandA.admin.id, runId, 1, 3, results, orders, opts);
    await expectCode(adv([good[0]]), "PC003", /covers 2 orders, got 1/);
    await expectCode(adv([good[0], orderResult(o2, { status: "ok", lines: feesFor(80), firstRow: 3 })]), "PC003", /does not agree with the orders file/);
    await expectCode(adv([good[0], orderResult(o2, { status: "ok", lines: feesFor(80), month: "2026-04" })]), "PC003", /does not agree/);
    await expectCode(adv([orderResult(o1, { status: "ok", lines: feesFor(100), units: 99 }), good[1]]), "PC003", /does not agree/);
    await expectCode(adv([orderResult(o1, { status: "ok", lines: feesFor(100), definite: 999 }), good[1]]), "PC003", /does not agree/);
    await expectCode(adv(good, { feeContexts: [{ fee_date: "2025-06-01", fee_schedule_version_id: main.versionId, unavailable_reason: null }] }), "PC003", /not in effect on its date/);
    await expectCode(adv([orderResult(o1, { status: "no_schedule", version: null, lines: feesFor(100) }), good[1]]), "PC003", /does not agree/);
    await expectCode(adv([orderResult(o1, { status: "ok", lines: feesFor(100), feeDate: "2026-03-16" }), good[1]]), "PC003", /does not agree/);
    await expectCode(adv([orderResult(o1, { status: "ok", lines: feesFor(100), version: null }), good[1]]), "PC003", /does not agree/);
    await expectCode(adv([good[0], good[0]]), "23505", /simulation_order_results_run_id_order_id_key/);
    await expectCode(adv(good, { partial: { version: 1, shipments: { seen: 3 } } }), "PC002", /older release/);
    await expectCode(adv(good, { partial: { version: 2, shipments: { seen: 2 } } }), "PC003", /does not cover the window/);
    await expectCode(asUser(w.brandB.admin.id, "select public.advance_simulation_run($1, 1, 3, '[]', '{}', '[]', '[]', '[]')", [runId]), "P0002", /run not found/);
    // Nothing of the refused calls was committed.
    expect(await sql("select 1 from public.simulation_order_results where run_id = $1", [runId])).toHaveLength(0);
    expect(await sql("select 1 from public.simulation_run_fee_contexts where run_id = $1", [runId])).toHaveLength(0);
    const [a1] = await adv(good);
    expect(a1!.r).toMatchObject({ applied: true, nextRow: 4, processed: 3 });
    expect((await adv(good))[0]!.r).toMatchObject({ applied: false, nextRow: 4 });
    expect(await asUser(w.t1.employee.id, "select fee_date::text, fee_schedule_version_id, unavailable_reason from public.simulation_run_fee_contexts where run_id = $1", [runId])).toEqual([{ fee_date: "2026-03-15", fee_schedule_version_id: main.versionId, unavailable_reason: null }]);
    // The next window starts at the cursor; O-4's line without a SKU makes its distinct-SKU count unknown, never undercounted.
    const [b2] = await asUser<{ r: Batch }>(w.brandA.admin.id, "select public.simulation_batch_input($1, 100) as r", [runId]);
    expect([b2!.r.fromRow, b2!.r.toRow]).toEqual([4, 5]);
    expect(b2!.r.shipments[1]).toMatchObject({ rowNo: 5, orderSeq: 4, orderUnits: 5, orderLines: 2, orderSkus: null, orderNullSkuLines: 1, orderShipments: 1 });
  });

  it("finishing recomputes processing totals, monthly lines and the minimum top-up, and refuses a summary that disagrees", async () => {
    const [, , , s3, s4] = ds.shipments as [Shipment, Shipment, Shipment, Shipment, Shipment];
    const o3 = ds.orders["O-3"]!, o4 = ds.orders["O-4"]!;
    const [a2] = await advance(w.brandA.admin.id, runId, 4, 5, [shipResult(s3, true), shipResult(s4, false)], [orderResult(o3, { status: "ok", lines: feesFor(200) }), orderResult(o4, { status: "ok", lines: feesFor(5) })]);
    expect(a2!.r).toMatchObject({ applied: true, nextRow: 6, processed: 5 });
    const me = w.brandA.admin.id;
    // Modeled: O-1, O-2, O-3 (4 shipments at $9.60); O-4 is undated and could not be priced. Processing over those three:
    // pick 380 units × $1.00 definite, volume tier 3 × $3.00 estimated. Monthly: $180 + $50 storage, receiving not modeled.
    // Minimum $500 against $380 of pick fees over one full month: $120 top-up, exact. Projected month: 3 of 4 population
    // orders is 75% coverage (< 80%), so shipping + processing are the period's own figures over 1.000000 months:
    // (38.40 + 389.00) / 1 + 230.00 fixed + 120.00 top-up = 777.40.
    const right = summaryFor({ orders: 3, shipments: 4, expected: "38.40", processing: { orders: 3, definite: "380.0000", estimated: "9.0000" }, minimums: [minimum("exact", 3800000)], minimumStatus: "exact", projected: "777.40" });
    const lines = mainMonthlyLines();
    await expectCode(finish(me, runId, { ...right, allocation: { monthly: { total: "700.00" } } }, lines), "PC003", /projected monthly total does not reconcile \(sql 777.40\)/);
    await expectCode(finish(me, runId, { ...right, allocation: undefined }, lines), "PC003", /projected monthly total does not reconcile/);
    await expectCode(finish(me, runId, { ...right, processing: { ...right.processing, orders: 4 } }, lines), "PC003", /processing totals do not reconcile/);
    await expectCode(finish(me, runId, { ...right, processing: { ...right.processing, definite: "385.0000" } }, lines), "PC003", /processing totals do not reconcile/);
    await expectCode(finish(me, runId, { ...right, processing: { ...right.processing, estimated: "0.0000" } }, lines), "PC003", /processing totals do not reconcile/);
    await expectCode(finish(me, runId, right, [{ ...lines[0], amount_e4: 2160000 }, lines[1], lines[2]]), "PC003", /monthly lines do not reconcile/);
    await expectCode(finish(me, runId, right, [{ ...lines[0], quantity: "12" }, lines[1], lines[2]]), "PC003", /monthly lines do not reconcile/);
    await expectCode(finish(me, runId, right, [lines[0], lines[1]]), "PC003", /monthly lines do not reconcile/);
    await expectCode(finish(me, runId, right, [lines[0], lines[1], { ...lines[2], status: "priced", quantity: "0", amount_e4: 0 }]), "PC003", /monthly lines do not reconcile/);
    await expectCode(finish(me, runId, { ...right, monthly: { totalE4: 2160000 } }, lines), "PC003", /monthly total does not reconcile/);
    await expectCode(finish(me, runId, { ...right, minimums: [minimum("upper_bound", 3800000)] }, lines), "PC003", /minimum top-up .* does not reconcile/);
    await expectCode(finish(me, runId, { ...right, minimums: [{ ...minimum("exact", 3800000), topUpE4: 1190000 }] }, lines), "PC003", /minimum top-up .* does not reconcile/);
    await expectCode(finish(me, runId, { ...right, minimums: [] }, lines), "PC003", /minimum top-up .* does not reconcile/);
    await expectCode(finish(me, runId, { ...right, minimumStatus: "upper_bound" }, lines), "PC003", /minimum status does not reconcile/);
    const [foreignRule] = await sql<{ id: string }>("select id from public.fee_rules where key = 'pick_fee' and resolved_rule_keys is null and version_id <> $1 limit 1", [main.versionId]);
    await expectCode(finish(me, runId, right, lines, { dictionary: [], feeDictionary: [...mainDictionary(), { ruleId: foreignRule!.id, key: "pick_fee", name: "Pick fee", category: "pick_pack", basis: "unit", scope: "order" }] }), "PC003", /fee dictionary names a rule/);
    await expectCode(finish(me, runId, right, lines, { dictionary: [], feeDictionary: [{ ...mainDictionary()[0]!, category: "other" }] }), "PC003", /fee dictionary names a rule/);
    await expectCode(finish(me, runId, { ...right, version: 1 }, lines), "PC002", /summary version/);
    await expectCode(finish(w.brandB.admin.id, runId, right, lines), "P0002", /run not found/);
    expect((await sql<{ status: string }>("select status from public.simulation_runs where id = $1", [runId]))[0]?.status).toBe("running");
    // The SQL recomputation of the monthly lines agrees with the hand-derived figures.
    expect(await sql("select rule_key, driver_key, quantity::text, amount::text, status, reason from app.fee_monthly_lines($1, $2::jsonb, 3) order by rule_key", [main.versionId, JSON.stringify(answers.fulfillment)])).toEqual([
      { rule_key: "receiving_pallet", driver_key: "pallets_received", quantity: null, amount: null, status: "not_modeled", reason: "no_answer" },
      { rule_key: "storage_long_term", driver_key: "pallets_long_term", quantity: "2", amount: "50.0000", status: "priced", reason: null },
      { rule_key: "storage_pallet", driver_key: "pallets_stored", quantity: "10", amount: "180.0000", status: "priced", reason: null },
    ]);

    const [fin] = await finish(me, runId, right, lines);
    expect(fin!.r).toEqual({ modeledOrders: 3, modeledShipments: 4, modeledPackages: 5, okShipments: 4, unavailableShipments: 1, expected: "38.40", processingOrders: 3, processingDefinite: "380.0000", processingEstimated: "9.0000", monthlyFixed: "230.0000", minimumTopUp: "120.0000", minimumStatus: "exact", projectedMonthly: "777.40" });
    const [run] = await asUser<Record<string, unknown>>(w.brandA.employee.id, "select status, modeled_orders, processing_orders, processing_definite::text, processing_estimated::text, fee_status_counts, monthly_fixed::text, minimum_topup::text, minimum_status, projected_monthly::text, fee_engine_version, engine_version from public.simulation_runs where id = $1", [runId]);
    expect(run).toEqual({ status: "completed", modeled_orders: 3, processing_orders: 3, processing_definite: "380.0000", processing_estimated: "9.0000", fee_status_counts: { ok: 3 }, monthly_fixed: "230.0000", minimum_topup: "120.0000", minimum_status: "exact", projected_monthly: "777.40", fee_engine_version: "1.0.0", engine_version: "2.2.0" });
    // in_totals marks orders that are both shipping-modeled and fee-priced; O-4's fees were priced but its shipping was not.
    expect(await asUser(w.brandA.employee.id, "select o.external_order_id as ext, x.in_totals, x.fee_status, x.processing_definite::int as d from public.simulation_order_results x join public.orders o on o.id = x.order_id where x.run_id = $1 order by x.first_row_no", [runId]))
      .toEqual([{ ext: "O-1", in_totals: true, fee_status: "ok", d: 1000000 }, { ext: "O-2", in_totals: true, fee_status: "ok", d: 800000 }, { ext: "O-3", in_totals: true, fee_status: "ok", d: 2000000 }, { ext: "O-4", in_totals: false, fee_status: "ok", d: 50000 }]);
    expect(await asUser(w.brandA.employee.id, "select r.key, l.driver_key, l.quantity::text, l.unit_amount::text, l.amount::text, l.charge_class, l.status, l.reason from public.simulation_monthly_lines l join public.fee_rules r on r.id = l.rule_id where l.run_id = $1 order by r.position", [runId])).toEqual([
      { key: "storage_pallet", driver_key: "pallets_stored", quantity: "10.000000", unit_amount: "18.0000", amount: "180.0000", charge_class: "estimated", status: "priced", reason: null },
      { key: "storage_long_term", driver_key: "pallets_long_term", quantity: "2.000000", unit_amount: "25.0000", amount: "50.0000", charge_class: "estimated", status: "priced", reason: null },
      { key: "receiving_pallet", driver_key: "pallets_received", quantity: null, unit_amount: "15.0000", amount: null, charge_class: null, status: "not_modeled", reason: "no_answer" },
    ]);
    for (const table of ["simulation_order_results", "simulation_monthly_lines", "simulation_run_fee_contexts"]) {
      expect(await asUser(w.brandB.admin.id, `select id from public.${table} where run_id = $1`, [runId]), table).toHaveLength(0);
      expect(await asUser(w.t2.admin.id, `select id from public.${table} where run_id = $1`, [runId]), table).toHaveLength(0);
      expect((await asUser(w.t1.employee.id, `select id from public.${table} where run_id = $1`, [runId])).length, table).toBeGreaterThan(0);
      await expectDenied(asUser(w.brandA.admin.id, `delete from public.${table} where run_id = $1`, [runId]), /permission denied/);
    }
    const [audit] = await sql<{ metadata: Record<string, unknown> }>("select metadata from public.audit_events where action = 'modeling.run_completed' and entity_id = $1", [runId]);
    expect(audit!.metadata).toMatchObject({ modeled_orders: 3, processing_orders: 3, minimum_status: "exact", fee_engine_version: "1.0.0" });
    expect((await advance(me, runId, 6, 6, [], []))[0]!.r).toMatchObject({ applied: false, status: "completed" });
    await expectCode(finish(me, runId, right, lines), "P0001", /run is completed/);
  });

  it("an order whose unresolved fees name a member of the minimum set makes the top-up an upper bound", async () => {
    const u = await buildDataset("Units unknown for one order", [
      { id: "U-1", date: "2026-03-01", units: 100, lines: [["SKU-A", 100]], ships: [{ date: "2026-03-01", pkgs: ["box"] }] },
      { id: "U-2", date: "2026-03-10", units: null, lines: [], ships: [{ date: "2026-03-10", pkgs: ["box"] }] },
      { id: "U-3", date: "2026-03-31", units: 200, lines: [["SKU-A", 200]], ships: [{ date: "2026-03-31", pkgs: ["box"] }] },
    ]);
    const me = w.brandA.admin.id;
    const [r] = await startRun(me, await createProject(u.id, "Upper bound"), answers);
    const [u1, u2, u3] = u.shipments as [Shipment, Shipment, Shipment];
    const orders = [
      orderResult(u.orders["U-1"]!, { status: "ok", lines: feesFor(100) }),
      orderResult(u.orders["U-2"]!, { status: "partial", lines: [[1, 30000, "e"]], unresolved: [{ ruleKey: "pick", reason: "units_unknown" }] }),
      orderResult(u.orders["U-3"]!, { status: "ok", lines: feesFor(200) }),
    ];
    expect((await advance(me, r!.id, 1, 3, [shipResult(u1, true), shipResult(u2, true), shipResult(u3, true)], orders))[0]!.r).toMatchObject({ applied: true, processed: 3 });
    // Counted: $100 + $200 of pick fees ($300); the $200 top-up is only an upper bound while U-2's pick fee is unknown.
    // Projected month at 100% coverage: 28.80 × 3/3 + 309.00 × 3/3 + 230.00 fixed, and no top-up (an upper bound is never added) = 567.80.
    const exact = summaryFor({ orders: 3, shipments: 3, expected: "28.80", processing: { orders: 3, definite: "300.0000", estimated: "9.0000" }, minimums: [minimum("exact", 3000000)], minimumStatus: "exact", projected: "567.80" });
    await expectCode(finish(me, r!.id, exact, mainMonthlyLines()), "PC003", /minimum top-up .* does not reconcile \(sql: upper_bound 2000000, counted 3000000\)/);
    const upper = { ...exact, minimums: [minimum("upper_bound", 3000000)], minimumStatus: "upper_bound" };
    await expectCode(finish(me, r!.id, { ...upper, allocation: { monthly: { total: "767.80" } } }, mainMonthlyLines()), "PC003", /projected monthly total does not reconcile \(sql 567.80\)/);
    const [fin] = await finish(me, r!.id, upper, mainMonthlyLines());
    expect(fin!.r).toMatchObject({ processingOrders: 3, processingDefinite: "300.0000", processingEstimated: "9.0000", minimumTopUp: "200.0000", minimumStatus: "upper_bound", projectedMonthly: "567.80" });
    expect((await sql<Record<string, unknown>>("select minimum_status, minimum_topup::text, projected_monthly::text, fee_status_counts, processing_orders from public.simulation_runs where id = $1", [r!.id]))[0])
      .toEqual({ minimum_status: "upper_bound", minimum_topup: "200.0000", projected_monthly: "567.80", fee_status_counts: { ok: 2, partial: 1 }, processing_orders: 3 });
  });

  it("a run that skips fulfillment costs stores skipped results, no fee context and no monthly lines", async () => {
    const [r] = await startRun(w.brandA.admin.id, projectId, { fulfillment: { skip: true } });
    const [run] = await sql<{ monthly_fee_schedule_version_id: string | null; fee_rates: unknown }>("select monthly_fee_schedule_version_id, fee_rates from public.simulation_runs where id = $1", [r!.id]);
    expect(run!.monthly_fee_schedule_version_id).toBe(main.versionId); // the schedule is still pinned; the answers say not to price it
    const skipped = (o: { id: string } & OrderFacts) => orderResult(o, { status: "skipped", feeDate: null, version: null });
    const all = ds.shipments.map((s, i) => shipResult(s, i < 4));
    const ordersAll = ["O-1", "O-2", "O-3", "O-4"].map((k) => skipped(ds.orders[k]!));
    await expectCode(advance(w.brandA.admin.id, r!.id, 1, 5, all, ordersAll.map((o, i) => (i === 0 ? { ...o, fee_lines: feesFor(1), processing_definite: 10000, processing_estimated: 30000 } : o)), { feeContexts: [] }), "PC003", /does not agree/);
    expect((await advance(w.brandA.admin.id, r!.id, 1, 5, all, ordersAll, { feeContexts: [] }))[0]!.r).toMatchObject({ applied: true, processed: 5 });
    const summary = { version: 2, modeled: { orders: 3, shipments: 4 }, totals: { expected: "38.40", definite: "38.40", estimated: "0.00" }, processing: { orders: 0, definite: "0.0000", estimated: "0.0000" }, feeEngineVersion: "1.0.0" };
    await expectCode(finish(w.brandA.admin.id, r!.id, summary, mainMonthlyLines(), { dictionary: [], feeDictionary: [] }), "PC003", /no monthly fees/);
    const [fin] = await finish(w.brandA.admin.id, r!.id, summary, [], { dictionary: [], feeDictionary: [] });
    expect(fin!.r).toMatchObject({ processingOrders: 0, processingDefinite: "0.0000", monthlyFixed: null, minimumTopUp: null, minimumStatus: null, projectedMonthly: null });
    expect(await sql("select 1 from public.simulation_run_fee_contexts where run_id = $1", [r!.id])).toHaveLength(0);
    expect(await sql("select 1 from public.simulation_monthly_lines where run_id = $1", [r!.id])).toHaveLength(0);
    expect((await sql<{ n: number }>("select count(*)::int as n from public.simulation_order_results where run_id = $1 and in_totals", [r!.id]))[0]?.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (f) Forecasts from assumptions
// ---------------------------------------------------------------------------
describe("forecasts from assumptions", () => {
  const assumptions = { monthlyOrders: "1250.00", asOfDate: "2026-03-15", originZip: "90001", fulfillment: { drivers: { pallets_stored: "12" } } };
  const summary = {
    basis: "assumptions", monthlyOrders: "1250.00", weightSum: "1250.00",
    shipping: { definite: "0.00", estimated: "12000.00", perOrder: "9.60" }, processing: { definite: "0.00", estimated: "1250.0000", perOrder: "1.00" },
    allocated: { perOrder: "0.17" }, allIn: { perOrder: "10.77" }, monthly: { total: "216.00", totalE4: 2160000 }, minimum: { topUp: "0.00" }, minimumStatus: "none",
  };
  const pins = () => ({ feeScheduleVersionId: main.versionId, rateCardVersionId: rcVersion, ruleVersionIds: [], zipListIds: [], overrideIds: [], loadIssues: [] });
  const save = (userId: string, a: unknown, s: unknown, p: unknown = pins(), brand = w.brandA.id) =>
    asUser<{ id: string }>(userId, "select public.save_forecast_run($1, $2, 'Next year at 1,250 orders', $3::jsonb, $4::jsonb, $5::jsonb, '2.2.0', '1.0.0') as id", [brand, cardId, JSON.stringify(a), JSON.stringify(s), JSON.stringify(p)]);

  it("saves a forecast project with a completed run and its fee context in one call; other brands cannot read it", async () => {
    const [p] = await save(w.brandA.admin.id, assumptions, summary);
    expect(await asUser(w.brandA.employee.id, "select kind, name, dataset_id from public.simulation_projects where id = $1", [p!.id])).toEqual([{ kind: "forecast", name: "Next year at 1,250 orders", dataset_id: null }]);
    const [run] = await asUser<Record<string, unknown>>(w.brandA.employee.id,
      `select id, kind, status, pricing_basis, as_of_date::text, volume_basis, monthly_orders::text, forecast_months::text, fee_schedule_id, monthly_fee_schedule_version_id,
              processing_orders, processing_definite::text, processing_estimated::text, monthly_fixed::text, minimum_topup::text, minimum_status, fee_engine_version, engine_version, total_shipments, assumptions, reference_data
       from public.simulation_runs where project_id = $1`, [p!.id]);
    expect(run).toMatchObject({
      kind: "forecast", status: "completed", pricing_basis: "fixed_date", as_of_date: "2026-03-15", volume_basis: "stated", monthly_orders: "1250.0000", forecast_months: "1.000000",
      fee_schedule_id: main.scheduleId, monthly_fee_schedule_version_id: main.versionId, processing_orders: null, processing_definite: "0.0000", processing_estimated: "1250.0000",
      monthly_fixed: "216.0000", minimum_topup: "0.0000", minimum_status: "none", fee_engine_version: "1.0.0", engine_version: "2.2.0", total_shipments: 0, assumptions, reference_data: pins(),
    });
    expect(await asUser(w.brandA.admin.id, "select fee_date::text, fee_schedule_version_id, unavailable_reason from public.simulation_run_fee_contexts where run_id = $1", [run!.id])).toEqual([{ fee_date: "2026-03-15", fee_schedule_version_id: main.versionId, unavailable_reason: null }]);
    expect(await asUser(w.t1.employee.id, "select ship_date::text, rate_card_version_id from public.simulation_run_contexts where run_id = $1", [run!.id])).toEqual([{ ship_date: "2026-03-15", rate_card_version_id: rcVersion }]);
    for (const user of [w.brandB.admin, w.t2.admin, w.outsider]) {
      expect(await asUser(user.id, "select id from public.simulation_projects where id = $1", [p!.id]), user.email).toHaveLength(0);
      expect(await asUser(user.id, "select id from public.simulation_runs where id = $1", [run!.id]), user.email).toHaveLength(0);
      expect(await asUser(user.id, "select id from public.simulation_run_fee_contexts where run_id = $1", [run!.id]), user.email).toHaveLength(0);
    }
    expect(await sql("select 1 from public.audit_events where action = 'modeling.run_started' and entity_id = $1 and metadata ->> 'kind' = 'forecast'", [run!.id])).toHaveLength(1);
    // Staff can save one on the brand's behalf; like any staff scenario it stays private until the 3PL shares it.
    const [staff] = await save(w.t1.admin.id, assumptions, summary);
    expect(await asUser(w.brandA.admin.id, "select id from public.simulation_projects where id = $1", [staff!.id])).toHaveLength(0);
    await asUser(w.t1.admin.id, "select public.set_scenario_sharing($1, true)", [staff!.id]);
    expect(await asUser(w.brandA.admin.id, "select id from public.simulation_projects where id = $1", [staff!.id])).toHaveLength(1);
    expect(await asUser(w.brandA.employee.id, "select kind from public.simulation_runs where project_id = $1", [staff!.id])).toEqual([{ kind: "forecast" }]);
  });

  it("refuses summaries that break the forecast identities, pins that do not match the date, and bad assumptions", async () => {
    const me = w.brandA.admin.id;
    await expectCode(save(me, assumptions, { ...summary, weightSum: "1249.00" }), "PC003", /does not satisfy its identities/);
    await expectCode(save(me, assumptions, { ...summary, monthlyOrders: "1200.00", weightSum: "1200.00" }), "PC003", /does not satisfy its identities/);
    await expectCode(save(me, assumptions, { ...summary, shipping: { ...summary.shipping, definite: "1.00" } }), "PC003", /does not satisfy its identities/);
    await expectCode(save(me, assumptions, { ...summary, processing: { ...summary.processing, definite: "0.01" } }), "PC003", /does not satisfy its identities/);
    await expectCode(save(me, assumptions, { ...summary, basis: "file" }), "PC003", /does not satisfy its identities/);
    await expectCode(save(me, assumptions, { ...summary, allIn: { perOrder: "10.80" } }), "PC003", /not the sum of its parts/);
    // Monthly charges are recomputed from the answers: 12 pallets × $18.00 = $216.00.
    await expectCode(save(me, assumptions, { ...summary, monthly: { total: "216.00", totalE4: 2150000 } }), "PC003", /forecast monthly charges do not reconcile \(sql 2160000\)/);
    await expectCode(save(me, { ...assumptions, fulfillment: { drivers: { pallets_stored: "12", pallets_long_term: "2" } } }, summary), "PC003", /forecast monthly charges do not reconcile \(sql 2300000\)/);
    const [lifeV1] = await sql<{ id: string }>("select v.id from public.fee_schedule_versions v join public.fee_schedules s on s.id = v.schedule_id where s.name = 'Lifecycle fees' and v.version_number = 1");
    await expectCode(save(me, assumptions, summary, { ...pins(), feeScheduleVersionId: lifeV1!.id }), "PC003", /not in effect on its date/);
    await expectCode(save(me, assumptions, summary, { ...pins(), feeScheduleVersionId: null }), "PC003", /not in effect on its date/);
    await expectCode(save(me, { ...assumptions, asOfDate: undefined }, summary), "PC001", /as-of date is required/);
    await expectCode(save(me, { ...assumptions, monthlyOrders: "0" }, summary), "PC001", /monthly orders must be between/);
    await expectCode(save(me, { ...assumptions, fulfillment: { drivers: { nope: "1" } } }, summary), "PC001", /not a question of this fee schedule/);
    await expectCode(asUser(me, "select public.save_forecast_run($1, $2, '', $3::jsonb, $4::jsonb, $5::jsonb, '2.2.0', '1.0.0')", [w.brandA.id, cardId, JSON.stringify(assumptions), JSON.stringify(summary), JSON.stringify(pins())]), "PC001", /name must be/);
    await expectCode(save(w.brandB.admin.id, assumptions, summary), "P0002", /customer not found/);
    await expectCode(save(w.brandB.admin.id, assumptions, summary, pins(), w.brandB.id), "PC001", /not assigned/);
    expect(await sql("select 1 from public.simulation_projects where brand_id = $1 and kind = 'forecast'", [w.brandA.id])).toHaveLength(2);
  });
});
