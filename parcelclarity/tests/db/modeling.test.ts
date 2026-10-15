import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { asUser, expectDenied, sql } from "./harness";
import { buildWorld, type World } from "./world";

/**
 * Authorization and integrity of the modeling tables (Milestone 3): order datasets and their rows,
 * product weights, scenarios, runs and results. Builds a rate card through the real flow as the 3PL
 * administrator and assigns it to brand A, then checks what every role can see and do. All values
 * are fictional test data.
 */
let w: World;
let upsGround: string;
let cardId: string;
let versionId: string;
let fileA: string;

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

async function uploadFile(userId: string, tenantId: string, brandId: string | null, purpose: string, name = "orders.csv"): Promise<string> {
  const content = Buffer.from(`order_id,destination_zip,weight\nX-1,85001,3\n`);
  const sha = createHash("sha256").update(content).digest("hex");
  const [row] = await asUser<{ id: string }>(
    userId,
    "insert into public.uploaded_files (tenant_id, brand_id, purpose, filename, mime_type, byte_size, sha256, content) values ($1, $2, $3, $4, 'text/csv', $5, decode($6, 'hex'), $7) returning id",
    [tenantId, brandId, purpose, name, content.length, sha, content],
  );
  return row!.id;
}

async function createDataset(userId: string, tenantId: string, brandId: string, fileId: string, name = "March orders"): Promise<string> {
  const [row] = await asUser<{ id: string }>(userId, "insert into public.order_datasets (tenant_id, brand_id, file_id, name, detected) values ($1, $2, $3, $4, '{}') returning id", [tenantId, brandId, fileId, name]);
  return row!.id;
}

/** Three orders: O-1 (one shipment, one package), O-2 (two shipments), O-3 (one shipment, two packages). */
function sampleRows(serviceId: string, opts: { cancelThird?: boolean } = {}) {
  const orders = [
    { external_order_id: "O-1", order_date: "2026-03-02", destination_zip: "85001", origin_zip: "90001", residential: true, units: 2, line_count: 1, cancelled: false, issues: [] },
    { external_order_id: "O-2", order_date: "2026-03-03", destination_zip: "93101", origin_zip: "90001", residential: false, units: 1, line_count: 1, cancelled: false, issues: [] },
    { external_order_id: "O-3", order_date: "2026-03-04", destination_zip: "85001", origin_zip: "90001", residential: true, units: 3, line_count: 2, cancelled: opts.cancelThird ?? false, issues: [] },
  ];
  const lines = [
    { external_order_id: "O-1", line_no: 1, sku: "SKU-A", units: 2 },
    { external_order_id: "O-2", line_no: 1, sku: "SKU-B", units: 1 },
    { external_order_id: "O-3", line_no: 1, sku: "SKU-A", units: 1 },
    { external_order_id: "O-3", line_no: 2, sku: "SKU-C", units: 2 },
  ];
  const shipments = [
    { external_order_id: "O-1", seq: 1, row_no: 1, external_shipment_id: "S-1", service_text: "UPS Ground", service_id: serviceId, origin_zip: null, destination_zip: null, ship_date: "2026-03-02", residential: null, issues: [] },
    { external_order_id: "O-2", seq: 1, row_no: 2, external_shipment_id: "S-2a", service_text: "UPS Ground", service_id: serviceId, origin_zip: null, destination_zip: null, ship_date: "2026-03-03", residential: null, issues: [] },
    { external_order_id: "O-2", seq: 2, row_no: 3, external_shipment_id: "S-2b", service_text: "UPS Ground", service_id: serviceId, origin_zip: null, destination_zip: null, ship_date: "2026-03-04", residential: null, issues: [] },
    { external_order_id: "O-3", seq: 1, row_no: 4, external_shipment_id: "S-3", service_text: "UPS Ground", service_id: serviceId, origin_zip: null, destination_zip: null, ship_date: "2026-03-04", residential: null, issues: [] },
  ];
  const packages = [
    { external_order_id: "O-1", shipment_seq: 1, seq: 1, weight: "1", weight_unit: "lb", length_in: "6", width_in: "4", height_in: "2", declared_value: null, packaging_type: "box", weight_derived: false, dimensions_derived: false },
    { external_order_id: "O-2", shipment_seq: 1, seq: 1, weight: "1.5", weight_unit: "lb", length_in: null, width_in: null, height_in: null, declared_value: null, packaging_type: null, weight_derived: false, dimensions_derived: false },
    { external_order_id: "O-2", shipment_seq: 2, seq: 1, weight: "0.5", weight_unit: "lb", length_in: null, width_in: null, height_in: null, declared_value: null, packaging_type: null, weight_derived: false, dimensions_derived: false },
    { external_order_id: "O-3", shipment_seq: 1, seq: 1, weight: "1", weight_unit: "lb", length_in: null, width_in: null, height_in: null, declared_value: null, packaging_type: null, weight_derived: false, dimensions_derived: false },
    { external_order_id: "O-3", shipment_seq: 1, seq: 2, weight: "2", weight_unit: "lb", length_in: null, width_in: null, height_in: null, declared_value: null, packaging_type: null, weight_derived: false, dimensions_derived: false },
  ];
  return { orders, lines, shipments, packages };
}

async function materialise(userId: string, datasetId: string, rows: ReturnType<typeof sampleRows>) {
  await asUser(userId, "update public.order_datasets set status = 'mapped' where id = $1", [datasetId]);
  await asUser(userId, "update public.order_datasets set status = 'validated', mapping = '{}', validation = '{\"counts\": {\"rows\": 9}}' where id = $1", [datasetId]);
  await asUser(userId, "select public.materialise_order_rows($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb)", [datasetId, JSON.stringify(rows.orders), JSON.stringify(rows.lines), JSON.stringify(rows.shipments), JSON.stringify(rows.packages)]);
  const [counts] = await asUser<{ r: { orders: number; shipments: number; packages: number; lines: number } }>(userId, "select public.finalize_order_dataset($1) as r", [datasetId]);
  return counts!.r;
}

const result = (shipment: { id: string; order_id: string; row_no: number }, status: "ok" | "unavailable", expected: string, packages = 1) => ({
  shipment_id: shipment.id,
  order_id: shipment.order_id,
  row_no: shipment.row_no,
  status,
  unavailable_reason: status === "ok" ? null : "no_rate_for_weight",
  rate_card_version_id: status === "ok" ? versionId : null,
  ship_date: "2026-03-02",
  zone: status === "ok" ? "5" : null,
  service_id: upsGround,
  billable_lb: Array.from({ length: packages }, () => "1.0"),
  definite: expected,
  estimated: "0.00",
  expected,
  conditional_exposure: "0.00",
  unresolved: "0.00",
  lines: status === "ok" ? [[0, Math.round(Number(expected) * 100), "c", "d", 0]] : [],
  warning_codes: [],
});

beforeAll(async () => {
  w = await buildWorld();
  [{ id: upsGround }] = (await sql<{ id: string }>("select id from public.shipping_services where carrier_code = 'ups' and code = 'ground'")) as [{ id: string }];
  const [card] = await asUser<{ id: string }>(w.t1.admin.id, "insert into public.rate_cards (tenant_id, name) values ($1, 'Modeling card') returning id", [w.t1.id]);
  cardId = card!.id;
  const [v] = await asUser<{ id: string }>(w.t1.admin.id, "insert into public.rate_card_versions (rate_card_id, tenant_id, version_number) values ($1, $2, 1) returning id", [cardId, w.t1.id]);
  versionId = v!.id;
  await asUser(w.t1.admin.id, "insert into public.rate_card_service_terms (version_id, service_id, dim_divisor) values ($1, $2, 139)", [versionId, upsGround]);
  await asUser(w.t1.admin.id, "insert into public.rate_card_rows (version_id, service_id, zone, weight_min, weight_max, weight_unit, price) values ($1, $2, '5', 0, 1, 'lb', 9.60), ($1, $2, '5', 1, 2, 'lb', 10.09)", [versionId, upsGround]);
  await asUser(w.t1.admin.id, "insert into public.rate_card_zones (version_id, carrier_code, origin_prefix, dest_prefix_from, dest_prefix_to, zone) values ($1, 'ups', '900', '800', '899', '5')", [versionId]);
  await asUser(w.t1.admin.id, "select public.activate_rate_card_version($1, '2026-01-01')", [versionId]);
  await asUser(w.t1.admin.id, "insert into public.brand_rate_card_assignments (tenant_id, brand_id, rate_card_id) values ($1, $2, $3)", [w.t1.id, w.brandA.id, cardId]);
  fileA = await uploadFile(w.brandA.admin.id, w.t1.id, w.brandA.id, "order_import");
});

describe("product weights", () => {
  it("belong to one brand, readable and writable by the brand and the 3PL's staff only", async () => {
    const [p] = await asUser<{ id: string }>(w.brandA.admin.id, "insert into public.sku_profiles (tenant_id, brand_id, sku, unit_weight, weight_unit) values ($1, $2, 'SKU-A', 0.75, 'lb') returning id", [w.t1.id, w.brandA.id]);
    expect(await asUser(w.brandA.employee.id, "select id from public.sku_profiles")).toHaveLength(1);
    expect(await asUser(w.t1.employee.id, "select id from public.sku_profiles where id = $1", [p!.id])).toHaveLength(1);
    expect(await asUser(w.brandB.admin.id, "select id from public.sku_profiles")).toHaveLength(0);
    expect(await asUser(w.t2.admin.id, "select id from public.sku_profiles")).toHaveLength(0);
    await expectDenied(asUser(w.brandA.admin.id, "insert into public.sku_profiles (tenant_id, brand_id, sku, unit_weight, weight_unit) values ($1, $2, 'SKU-X', 1, 'lb')", [w.t1.id, w.brandB.id]), /row-level security/);
    await expectDenied(asUser(w.brandA.admin.id, "insert into public.sku_profiles (tenant_id, brand_id, sku, unit_weight, weight_unit) values ($1, $2, ' sku-a ', 1, 'lb')", [w.t1.id, w.brandA.id]), /sku_profiles_brand_id_sku_normalized_key|duplicate/);
    expect(await asUser(w.t1.admin.id, "update public.sku_profiles set unit_weight = 0.8 where id = $1 returning id", [p!.id])).toHaveLength(1);
  });
});

describe("order files", () => {
  it("brands upload order files for themselves only; pricing files stay with managers", async () => {
    // Before a dataset exists only the uploader (and staff) can read the file; the brand's dataset shares it with the brand.
    expect(await asUser(w.brandA.employee.id, "select id from public.uploaded_files where id = $1", [fileA])).toHaveLength(0);
    expect(await asUser(w.brandA.admin.id, "select id from public.uploaded_files where id = $1", [fileA])).toHaveLength(1);
    await createDataset(w.brandA.admin.id, w.t1.id, w.brandA.id, fileA, "Shares the file");
    expect(await asUser(w.brandA.employee.id, "select id from public.uploaded_files where id = $1", [fileA])).toHaveLength(1);
    await expectDenied(uploadFile(w.brandA.admin.id, w.t1.id, w.brandB.id, "order_import"), /row-level security/);
    await expectDenied(uploadFile(w.brandA.admin.id, w.t1.id, null, "rate_card"), /row-level security/);
    await expectDenied(uploadFile(w.brandA.admin.id, w.t1.id, w.brandA.id, "rate_card"), /row-level security/);
    const rateCardFile = await uploadFile(w.t1.admin.id, w.t1.id, null, "rate_card", "card.csv");
    expect(await asUser(w.brandA.admin.id, "select id from public.uploaded_files where id = $1", [rateCardFile])).toHaveLength(0);
    expect(await asUser(w.t1.employee.id, "select id from public.uploaded_files where id = $1", [fileA])).toHaveLength(1);
  });

  it("a brand's dataset is its own; staff-prepared datasets stay private until shared", async () => {
    const ds = await createDataset(w.brandA.admin.id, w.t1.id, w.brandA.id, fileA);
    expect(ids(await asUser(w.brandA.employee.id, "select id from public.order_datasets where id = $1", [ds]))).toEqual([ds]);
    for (const user of [w.brandB.admin, w.brandC.admin, w.t2.admin, w.platformAdmin]) {
      expect(await asUser(user.id, "select id from public.order_datasets where id = $1", [ds]), user.email).toHaveLength(0);
    }
    expect(await asUser(w.t1.employee.id, "select id from public.order_datasets where id = $1", [ds])).toHaveLength(1);
    // Direct lifecycle changes are refused; counts are computed.
    await expectDenied(asUser(w.brandA.admin.id, "update public.order_datasets set status = 'ready' where id = $1", [ds]), /cannot be changed directly/);
    await expectDenied(asUser(w.brandA.admin.id, "update public.order_datasets set order_count = 99 where id = $1", [ds]), /computed|permission denied/);
    await expectDenied(asUser(w.brandA.admin.id, "insert into public.orders (dataset_id, tenant_id, brand_id, external_order_id) values ($1, $2, $3, 'X')", [ds, w.t1.id, w.brandA.id]), /permission denied/);

    const staffFile = await uploadFile(w.t1.admin.id, w.t1.id, w.brandA.id, "order_import", "prepared.csv");
    const staffDs = await createDataset(w.t1.admin.id, w.t1.id, w.brandA.id, staffFile, "Prepared by 3PL");
    expect(await asUser(w.brandA.admin.id, "select id from public.order_datasets where id = $1", [staffDs])).toHaveLength(0);
    expect(await asUser(w.brandA.admin.id, "select id from public.uploaded_files where id = $1", [staffFile])).toHaveLength(0);
    // Neither the lifecycle functions nor the sharing flag are reachable by the brand for a private dataset.
    await expectDenied(asUser(w.brandA.admin.id, "select public.discard_order_dataset($1)", [staffDs]), /dataset not found/);
    await expectDenied(asUser(w.brandA.admin.id, "select public.materialise_order_rows($1, '[]', '[]', '[]', '[]')", [staffDs]), /dataset not found/);
    await expectDenied(asUser(w.brandA.admin.id, "select public.set_dataset_sharing($1, true)", [staffDs]), /dataset not found/);
    await expectDenied(asUser(w.t1.admin.id, "update public.order_datasets set shared_with_brand = true where id = $1", [staffDs]), /permission denied/);
    await asUser(w.t1.admin.id, "select public.set_dataset_sharing($1, true)", [staffDs]);
    expect(await asUser(w.brandA.admin.id, "select id from public.order_datasets where id = $1", [staffDs])).toHaveLength(1);
    expect(await asUser(w.brandA.admin.id, "select id from public.uploaded_files where id = $1", [staffFile])).toHaveLength(1);
    expect(await sql("select 1 from public.audit_events where action = 'modeling.dataset_shared' and entity_id = $1", [staffDs])).toHaveLength(1);
    // Sharing a ready dataset works too (the status guard only blocks direct lifecycle edits).
    const readyDs = await createDataset(w.t1.admin.id, w.t1.id, w.brandA.id, staffFile, "Ready and private");
    await materialise(w.t1.admin.id, readyDs, sampleRows(upsGround));
    expect(await asUser(w.brandA.admin.id, "select id from public.order_datasets where id = $1", [readyDs])).toHaveLength(0);
    await asUser(w.t1.admin.id, "select public.set_dataset_sharing($1, true)", [readyDs]);
    expect(await asUser(w.brandA.admin.id, "select id from public.orders where dataset_id = $1", [readyDs])).toHaveLength(3);
  });

  it("an interrupted preparation can be rolled back and prepared again", async () => {
    const ds = await createDataset(w.brandA.admin.id, w.t1.id, w.brandA.id, fileA, "Interrupted");
    await asUser(w.brandA.admin.id, "update public.order_datasets set status = 'mapped' where id = $1", [ds]);
    await asUser(w.brandA.admin.id, "update public.order_datasets set status = 'validated', mapping = '{}', validation = '{\"counts\": {\"rows\": 9}}' where id = $1", [ds]);
    const rows = sampleRows(upsGround);
    await asUser(w.brandA.admin.id, "select public.materialise_order_rows($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb)", [ds, JSON.stringify(rows.orders), JSON.stringify(rows.lines), JSON.stringify(rows.shipments), JSON.stringify(rows.packages)]);
    expect((await asUser<{ status: string }>(w.brandA.admin.id, "select status from public.order_datasets where id = $1", [ds]))[0]?.status).toBe("materialising");
    await expectDenied(asUser(w.brandB.admin.id, "select public.reset_order_dataset($1)", [ds]), /dataset not found/);
    await asUser(w.brandA.admin.id, "select public.reset_order_dataset($1)", [ds]);
    expect((await asUser<{ status: string }>(w.brandA.admin.id, "select status from public.order_datasets where id = $1", [ds]))[0]?.status).toBe("validated");
    expect(await asUser(w.brandA.admin.id, "select id from public.orders where dataset_id = $1", [ds])).toHaveLength(0);
    await expectDenied(asUser(w.brandA.admin.id, "select public.reset_order_dataset($1)", [ds]), /not being materialised/);
    expect(await materialise(w.brandA.admin.id, ds, rows)).toEqual({ orders: 3, shipments: 4, packages: 5, lines: 4 });
  });

  it("materialises whole orders in one transaction and computes the counts", async () => {
    const ds = await createDataset(w.brandA.admin.id, w.t1.id, w.brandA.id, fileA, "To materialise");
    const counts = await materialise(w.brandA.admin.id, ds, sampleRows(upsGround));
    expect(counts).toEqual({ orders: 3, shipments: 4, packages: 5, lines: 4 });
    const [row] = await asUser<{ status: string; order_count: number; shipment_count: number; package_count: number; line_count: number; row_count: number }>(w.brandA.admin.id, "select status, order_count, shipment_count, package_count, line_count, row_count from public.order_datasets where id = $1", [ds]);
    expect(row).toEqual({ status: "ready", order_count: 3, shipment_count: 4, package_count: 5, line_count: 4, row_count: 9 });
    expect(await asUser(w.t1.employee.id, "select id from public.packages where dataset_id = $1", [ds])).toHaveLength(5);
    expect(await asUser(w.brandB.admin.id, "select id from public.shipments where dataset_id = $1", [ds])).toHaveLength(0);
    expect(await asUser(w.t2.admin.id, "select id from public.orders where dataset_id = $1", [ds])).toHaveLength(0);
    // Already ready: no second materialisation, and a gap in row numbers is refused.
    await expectDenied(asUser(w.brandA.admin.id, "select public.materialise_order_rows($1, '[]', '[]', '[]', '[]')", [ds]), /not ready to be materialised/);
    const gappy = await createDataset(w.brandA.admin.id, w.t1.id, w.brandA.id, fileA, "Gappy");
    const rows = sampleRows(upsGround);
    rows.shipments[3]!.row_no = 9;
    await expectDenied(materialise(w.brandA.admin.id, gappy, rows), /not dense/);
    // Another brand cannot drive this brand's dataset lifecycle.
    await expectDenied(asUser(w.brandB.admin.id, "select public.finalize_order_dataset($1)", [ds]), /dataset not found/);
    await expectDenied(asUser(w.brandB.admin.id, "select public.discard_order_dataset($1)", [ds]), /dataset not found/);
  });
});

describe("scenarios and runs", () => {
  let datasetId: string;
  let projectId: string;
  let runId: string;
  let shipments: { id: string; order_id: string; row_no: number }[];

  beforeAll(async () => {
    datasetId = await createDataset(w.brandA.admin.id, w.t1.id, w.brandA.id, fileA, "Run me");
    await materialise(w.brandA.admin.id, datasetId, sampleRows(upsGround));
    shipments = await asUser<{ id: string; order_id: string; row_no: number }>(w.brandA.admin.id, "select id, order_id, row_no from public.shipments where dataset_id = $1 order by row_no", [datasetId]);
  });

  it("a scenario needs an assigned rate card and a ready dataset of the same brand", async () => {
    await expectDenied(asUser(w.brandB.admin.id, "insert into public.simulation_projects (tenant_id, brand_id, kind, name, rate_card_id) values ($1, $2, 'single', 'Nope', $3)", [w.t1.id, w.brandB.id, cardId]), /row-level security/);
    await expectDenied(asUser(w.brandA.admin.id, "insert into public.simulation_projects (tenant_id, brand_id, kind, name, rate_card_id) values ($1, $2, 'bulk', 'No dataset', $3)", [w.t1.id, w.brandA.id, cardId]), /sp_bulk_has_dataset|row-level security/);
    const [p] = await asUser<{ id: string }>(w.brandA.admin.id, "insert into public.simulation_projects (tenant_id, brand_id, kind, name, dataset_id, rate_card_id) values ($1, $2, 'bulk', 'March at today''s rates', $3, $4) returning id", [w.t1.id, w.brandA.id, datasetId, cardId]);
    projectId = p!.id;
    expect(await asUser(w.brandA.employee.id, "select id from public.simulation_projects where id = $1", [projectId])).toHaveLength(1);
    expect(await asUser(w.brandB.admin.id, "select id from public.simulation_projects where id = $1", [projectId])).toHaveLength(0);
    const [staffP] = await asUser<{ id: string; shared_with_brand: boolean }>(w.t1.admin.id, "insert into public.simulation_projects (tenant_id, brand_id, kind, name, dataset_id, rate_card_id) values ($1, $2, 'bulk', 'Staff what-if', $3, $4) returning id, shared_with_brand", [w.t1.id, w.brandA.id, datasetId, cardId]);
    expect(staffP!.shared_with_brand).toBe(false);
    expect(await asUser(w.brandA.admin.id, "select id from public.simulation_projects where id = $1", [staffP!.id])).toHaveLength(0);
  });

  it("starting a run validates its settings and attaches to the live run", async () => {
    await expectDenied(asUser(w.brandA.admin.id, "select public.start_simulation_run($1, 'fixed_date', null, null, 'exclude', '{}')", [projectId]), /as-of date is required/);
    await expectDenied(asUser(w.brandA.admin.id, "select public.start_simulation_run($1, 'fixed_date', '2026-03-01', null, 'use_override', '{}')", [projectId]), /choose a service/);
    const [{ id: fedex }] = (await sql<{ id: string }>("select id from public.shipping_services where carrier_code = 'fedex' limit 1")) as [{ id: string }];
    await expectDenied(asUser(w.brandA.admin.id, "select public.start_simulation_run($1, 'fixed_date', '2026-03-01', $2, 'use_override', '{}')", [projectId, fedex]), /not available on the customer/);
    await expectDenied(asUser(w.brandA.admin.id, "select public.start_simulation_run($1, 'yesterday', '2026-03-01', null, 'exclude', '{}')", [projectId]), /invalid pricing basis/);
    const [r1] = await asUser<{ id: string }>(w.brandA.admin.id, "select public.start_simulation_run($1, 'fixed_date', '2026-03-01', null, 'exclude', '{\"residentialDefault\": true}') as id", [projectId]);
    const [r2] = await asUser<{ id: string }>(w.brandA.admin.id, "select public.start_simulation_run($1, 'fixed_date', '2026-03-01', null, 'exclude', '{\"residentialDefault\": true}') as id", [projectId]);
    expect(r2!.id).toBe(r1!.id);
    // Different settings never silently attach to the live run.
    await expectDenied(asUser(w.brandA.admin.id, "select public.start_simulation_run($1, 'fixed_date', '2026-03-01', null, 'exclude', '{}')", [projectId]), /different settings/);
    runId = r1!.id;
    const [run] = await asUser<{ status: string; total_shipments: number; next_row_no: number }>(w.brandA.employee.id, "select status, total_shipments, next_row_no::int from public.simulation_runs where id = $1", [runId]);
    expect(run).toEqual({ status: "running", total_shipments: 4, next_row_no: 1 });
    expect(await asUser(w.brandB.admin.id, "select id from public.simulation_runs where id = $1", [runId])).toHaveLength(0);
    await expectDenied(asUser(w.brandB.admin.id, "select public.start_simulation_run($1, 'fixed_date', '2026-03-01', null, 'exclude', '{}')", [projectId]), /scenario not found/);
    expect(await sql("select 1 from public.audit_events where action = 'modeling.run_started' and entity_id = $1", [runId])).toHaveLength(1);
  });

  it("batch input returns whole orders with nested packages from the cursor", async () => {
    const [b] = await asUser<{ r: { fromRow: number; toRow: number; total: number; shipments: { externalOrderId: string; rowNo: number; packages: { seq: number; weight: string }[] }[] } }>(w.brandA.admin.id, "select public.simulation_batch_input($1, 2) as r", [runId]);
    // Limit 2 lands inside O-2 (rows 2–3), so the window extends to the end of that order.
    expect([b!.r.fromRow, b!.r.toRow, b!.r.total]).toEqual([1, 3, 4]);
    expect(b!.r.shipments.map((s) => [s.externalOrderId, s.rowNo, s.packages.length])).toEqual([["O-1", 1, 1], ["O-2", 2, 1], ["O-2", 3, 1]]);
    expect(b!.r.shipments[0]!.packages[0]).toMatchObject({ seq: 1, weight: "1.000000" });
    await expectDenied(asUser(w.brandB.admin.id, "select public.simulation_batch_input($1, 2)", [runId]), /run not found/);
  });

  it("windows are committed in order, idempotently, and results are never written directly", async () => {
    const [s1, s2a, s2b, s3] = shipments as [typeof shipments[number], typeof shipments[number], typeof shipments[number], typeof shipments[number]];
    await expectDenied(asUser(w.brandA.admin.id, "insert into public.simulation_results (run_id, tenant_id, brand_id, shipment_id, order_id, row_no, status) values ($1, $2, $3, $4, $5, 1, 'ok')", [runId, w.t1.id, w.brandA.id, s1.id, s1.order_id]), /permission denied/);
    // A window that does not start at the cursor, or with the wrong number of results, is refused.
    await expectDenied(asUser(w.brandA.admin.id, "select public.advance_simulation_run($1, 2, 3, $2::jsonb, '{}', '[]')", [runId, JSON.stringify([result(s2a, "ok", "9.60"), result(s2b, "ok", "9.60")])]), /does not start at the cursor/);
    await expectDenied(asUser(w.brandA.admin.id, "select public.advance_simulation_run($1, 1, 3, $2::jsonb, '{\"shipments\": {\"seen\": 3}}', '[]')", [runId, JSON.stringify([result(s1, "ok", "9.60")])]), /needs 3 results/);
    const contexts = JSON.stringify([{ ship_date: "2026-03-01", rate_card_version_id: versionId, rule_version_ids: [], zip_list_ids: [], override_ids: [], load_issues: [], unavailable_reason: null }]);
    const window1 = JSON.stringify([result(s1, "ok", "9.60"), result(s2a, "ok", "10.09"), result(s2b, "unavailable", "0.00")]);
    // A partial that has not folded exactly this window is refused (a stale copy from a concurrent caller).
    await expectDenied(asUser(w.brandA.admin.id, "select public.advance_simulation_run($1, 1, 3, $2::jsonb, '{\"shipments\": {\"seen\": 2}}', $3::jsonb)", [runId, window1, contexts]), /does not cover the window/);
    // A result naming another file's shipment is refused.
    const otherDs = await createDataset(w.brandA.admin.id, w.t1.id, w.brandA.id, fileA, "Another file");
    await materialise(w.brandA.admin.id, otherDs, sampleRows(upsGround));
    const [foreign] = await asUser<{ id: string; order_id: string; row_no: number }>(w.brandA.admin.id, "select id, order_id, row_no from public.shipments where dataset_id = $1 and row_no = 1", [otherDs]);
    await expectDenied(asUser(w.brandA.admin.id, "select public.advance_simulation_run($1, 1, 3, $2::jsonb, '{\"shipments\": {\"seen\": 3}}', $3::jsonb)", [runId, JSON.stringify([result(foreign!, "ok", "9.60"), result(s2a, "ok", "10.09"), result(s2b, "unavailable", "0.00")]), contexts]), /does not belong to this run/);
    const [a1] = await asUser<{ r: { applied: boolean; nextRow: number; processed: number } }>(w.brandA.admin.id, "select public.advance_simulation_run($1, 1, 3, $2::jsonb, '{\"step\": 1, \"shipments\": {\"seen\": 3}}', $3::jsonb) as r", [runId, window1, contexts]);
    expect(a1!.r).toMatchObject({ applied: true, nextRow: 4, processed: 3 });
    // The same window again (lost response, second tab): acknowledged, not re-applied.
    const [again] = await asUser<{ r: { applied: boolean; nextRow: number } }>(w.brandA.admin.id, "select public.advance_simulation_run($1, 1, 3, $2::jsonb, '{\"step\": 1, \"shipments\": {\"seen\": 3}}', $3::jsonb) as r", [runId, window1, contexts]);
    expect(again!.r).toMatchObject({ applied: false, nextRow: 4 });
    expect(await asUser(w.brandA.admin.id, "select id from public.simulation_results where run_id = $1", [runId])).toHaveLength(3);
    // Pinned contexts are the 3PL's material: staff read them, the brand does not.
    expect(await asUser(w.t1.employee.id, "select id from public.simulation_run_contexts where run_id = $1", [runId])).toHaveLength(1);
    expect(await asUser(w.brandA.admin.id, "select id from public.simulation_run_contexts where run_id = $1", [runId])).toHaveLength(0);
    // Finishing early is refused.
    await expectDenied(asUser(w.brandA.admin.id, "select public.finish_simulation_run($1, '{}', '{}', '2.2.0')", [runId]), /3 of 4 shipments/);
    // The batch input carries the partial that belongs to its cursor.
    const [b2] = await asUser<{ r: { fromRow: number; partialSummary: { step: number } } }>(w.brandA.admin.id, "select public.simulation_batch_input($1, 100) as r", [runId]);
    expect(b2!.r).toMatchObject({ fromRow: 4, partialSummary: { step: 1 } });
    const [a2] = await asUser<{ r: { applied: boolean; nextRow: number; processed: number } }>(w.brandA.admin.id, "select public.advance_simulation_run($1, 4, 4, $2::jsonb, '{\"step\": 2, \"shipments\": {\"seen\": 4}}', $3::jsonb) as r", [runId, JSON.stringify([result(s3, "ok", "19.69", 2)]), contexts]);
    expect(a2!.r).toMatchObject({ applied: true, nextRow: 5, processed: 4 });
    const [progress] = await asUser<{ processed_shipments: number; partial_summary: { step: number } }>(w.brandA.admin.id, "select processed_shipments, partial_summary from public.simulation_runs where id = $1", [runId]);
    expect(progress).toEqual({ processed_shipments: 4, partial_summary: { step: 2, shipments: { seen: 4 } } });
  });

  it("finishing recomputes the trusted figures and refuses a summary that disagrees", async () => {
    // Modeled: O-1 (9.60) and O-3 (19.69); O-2 has an unavailable shipment and is excluded whole.
    const wrong = { modeled: { orders: 3, shipments: 4 }, totals: { expected: "39.38", definite: "39.38", estimated: "0.00" } };
    await expectDenied(asUser(w.brandA.admin.id, "select public.finish_simulation_run($1, $2::jsonb, '{}', '2.2.0')", [runId, JSON.stringify(wrong)]), /does not reconcile/);
    const right = { modeled: { orders: 2, shipments: 2 }, totals: { expected: "29.29", definite: "29.29", estimated: "0.00" }, byZone: [] };
    await expectDenied(asUser(w.brandB.admin.id, "select public.finish_simulation_run($1, $2::jsonb, '{}', '2.2.0')", [runId, JSON.stringify(right)]), /run not found/);
    const [fin] = await asUser<{ r: { modeledOrders: number; modeledShipments: number; modeledPackages: number; okShipments: number; unavailableShipments: number; expected: string } }>(w.brandA.admin.id, "select public.finish_simulation_run($1, $2::jsonb, '{\"dictionary\": []}', '2.2.0') as r", [runId, JSON.stringify(right)]);
    expect(fin!.r).toEqual({ modeledOrders: 2, modeledShipments: 2, modeledPackages: 3, okShipments: 3, unavailableShipments: 1, expected: "29.29" });
    const [run] = await asUser<{ status: string; total_expected: string; modeled_orders: number; engine_version: string }>(w.brandA.employee.id, "select status, total_expected, modeled_orders, engine_version from public.simulation_runs where id = $1", [runId]);
    expect(run).toEqual({ status: "completed", total_expected: "29.29", modeled_orders: 2, engine_version: "2.2.0" });
    // Rows of modeled orders are marked as part of the totals; O-2's priced shipment is not.
    expect((await asUser<{ in_totals: boolean }>(w.brandA.employee.id, "select in_totals from public.simulation_results where run_id = $1 order by row_no", [runId])).map((r) => r.in_totals)).toEqual([true, false, false, true]);
    const [audit] = await sql<{ metadata: Record<string, unknown> }>("select metadata from public.audit_events where action = 'modeling.run_completed' and entity_id = $1", [runId]);
    expect(audit!.metadata).toMatchObject({ processed: 4, total: 4, ok: 3, unavailable: 1, modeled_orders: 2 });
    expect(JSON.stringify(audit!.metadata).length).toBeLessThan(1000);
    // Completed runs accept no more work, and brands never see each other's results.
    const [late] = await asUser<{ r: { applied: boolean; status: string } }>(w.brandA.admin.id, "select public.advance_simulation_run($1, 5, 5, '[]', '{}', '[]') as r", [runId]);
    expect(late!.r).toMatchObject({ applied: false, status: "completed" });
    expect(await asUser(w.brandB.admin.id, "select id from public.simulation_results where run_id = $1", [runId])).toHaveLength(0);
    expect(await asUser(w.t1.employee.id, "select id from public.simulation_results where run_id = $1", [runId])).toHaveLength(4);
  });

  it("cancelled orders are never modeled; failing and cancelling a run are terminal", async () => {
    const ds = await createDataset(w.brandA.admin.id, w.t1.id, w.brandA.id, fileA, "With a cancelled order");
    await materialise(w.brandA.admin.id, ds, sampleRows(upsGround, { cancelThird: true }));
    const rows = await asUser<{ id: string; order_id: string; row_no: number }>(w.brandA.admin.id, "select id, order_id, row_no from public.shipments where dataset_id = $1 order by row_no", [ds]);
    const [p] = await asUser<{ id: string }>(w.brandA.admin.id, "insert into public.simulation_projects (tenant_id, brand_id, kind, name, dataset_id, rate_card_id) values ($1, $2, 'bulk', 'Cancelled test', $3, $4) returning id", [w.t1.id, w.brandA.id, ds, cardId]);
    const [r] = await asUser<{ id: string }>(w.brandA.admin.id, "select public.start_simulation_run($1, 'ship_date', null, null, 'exclude', '{}') as id", [p!.id]);
    await asUser(w.brandA.admin.id, "select public.advance_simulation_run($1, 1, 4, $2::jsonb, '{\"shipments\": {\"seen\": 4}}', '[]')", [r!.id, JSON.stringify(rows.map((s) => result(s, "ok", "9.60", s.row_no === 4 ? 2 : 1)))]);
    const [fin] = await asUser<{ r: { modeledOrders: number; modeledShipments: number } }>(w.brandA.admin.id, "select public.finish_simulation_run($1, $2::jsonb, '{}', '2.2.0') as r", [r!.id, JSON.stringify({ modeled: { orders: 2, shipments: 3 }, totals: { expected: "28.80", definite: "28.80", estimated: "0.00" } })]);
    expect(fin!.r).toMatchObject({ modeledOrders: 2, modeledShipments: 3 });

    const [r2] = await asUser<{ id: string }>(w.brandA.admin.id, "select public.start_simulation_run($1, 'ship_date', null, null, 'exclude', '{}') as id", [p!.id]);
    expect(r2!.id).not.toBe(r!.id);
    await asUser(w.brandA.admin.id, "select public.fail_simulation_run($1, 'pricing context unavailable')", [r2!.id]);
    const [failed] = await asUser<{ status: string; error: string }>(w.brandA.admin.id, "select status, error from public.simulation_runs where id = $1", [r2!.id]);
    expect(failed).toEqual({ status: "failed", error: "pricing context unavailable" });
    const [r3] = await asUser<{ id: string }>(w.brandA.admin.id, "select public.start_simulation_run($1, 'ship_date', null, null, 'exclude', '{}') as id", [p!.id]);
    await asUser(w.brandA.admin.id, "select public.cancel_simulation_run($1)", [r3!.id]);
    expect((await asUser<{ status: string }>(w.brandA.admin.id, "select status from public.simulation_runs where id = $1", [r3!.id]))[0]?.status).toBe("cancelled");
    // The dataset cannot be discarded while a scenario uses it, nor while a staff-private scenario the brand cannot see does.
    await expectDenied(asUser(w.brandA.admin.id, "select public.discard_order_dataset($1)", [ds]), /used by a scenario/);
    await asUser(w.brandA.admin.id, "update public.simulation_projects set archived_at = now() where id = $1", [p!.id]);
    const [staffP] = await asUser<{ id: string }>(w.t1.admin.id, "insert into public.simulation_projects (tenant_id, brand_id, kind, name, dataset_id, rate_card_id) values ($1, $2, 'bulk', 'Private, archived', $3, $4) returning id", [w.t1.id, w.brandA.id, ds, cardId]);
    await asUser(w.t1.admin.id, "update public.simulation_projects set archived_at = now() where id = $1", [staffP!.id]);
    await expectDenied(asUser(w.brandA.admin.id, "select public.discard_order_dataset($1)", [ds]), /used by a scenario/);
    await sql("delete from public.simulation_projects where id = $1", [staffP!.id]);
    await asUser(w.brandA.admin.id, "select public.discard_order_dataset($1)", [ds]);
    expect(await asUser(w.brandA.admin.id, "select id from public.orders where dataset_id = $1", [ds])).toHaveLength(0);
  });

  it("sharing a staff scenario is a staff decision and shares the orders file it models", async () => {
    const staffFile = await uploadFile(w.t1.admin.id, w.t1.id, w.brandA.id, "order_import", "staff-run.csv");
    const staffDs = await createDataset(w.t1.admin.id, w.t1.id, w.brandA.id, staffFile, "Staff run file");
    await materialise(w.t1.admin.id, staffDs, sampleRows(upsGround));
    const [p] = await asUser<{ id: string }>(w.t1.admin.id, "insert into public.simulation_projects (tenant_id, brand_id, kind, name, dataset_id, rate_card_id) values ($1, $2, 'bulk', 'Staff what-if', $3, $4) returning id", [w.t1.id, w.brandA.id, staffDs, cardId]);
    expect(await asUser(w.brandA.admin.id, "select id from public.simulation_projects where id = $1", [p!.id])).toHaveLength(0);
    await expectDenied(asUser(w.brandA.admin.id, "select public.set_scenario_sharing($1, true)", [p!.id]), /scenario not found/);
    await expectDenied(asUser(w.t1.admin.id, "update public.simulation_projects set shared_with_brand = true where id = $1", [p!.id]), /permission denied/);
    // The brand cannot drive a run on a scenario it cannot see.
    const [run] = await asUser<{ id: string }>(w.t1.admin.id, "select public.start_simulation_run($1, 'ship_date', null, null, 'exclude', '{}') as id", [p!.id]);
    await expectDenied(asUser(w.brandA.admin.id, "select public.simulation_batch_input($1, 10)", [run!.id]), /run not found/);
    await expectDenied(asUser(w.brandA.admin.id, "select public.cancel_simulation_run($1)", [run!.id]), /run not found/);
    await asUser(w.t1.admin.id, "select public.cancel_simulation_run($1)", [run!.id]);
    await asUser(w.t1.admin.id, "select public.set_scenario_sharing($1, true)", [p!.id]);
    expect(await asUser(w.brandA.admin.id, "select id from public.simulation_projects where id = $1", [p!.id])).toHaveLength(1);
    expect(await asUser(w.brandA.admin.id, "select id from public.order_datasets where id = $1", [staffDs])).toHaveLength(1);
    expect(await asUser(w.brandA.admin.id, "select id from public.shipments where dataset_id = $1", [staffDs])).toHaveLength(4);
    expect(await sql("select 1 from public.audit_events where action = 'modeling.scenario_shared' and entity_id = $1", [p!.id])).toHaveLength(1);
  });

  it("a retired rate card is no longer modeled on, even while its assignment stands", async () => {
    await asUser(w.t1.admin.id, "update public.rate_cards set status = 'archived' where id = $1", [cardId]);
    await expectDenied(asUser(w.brandA.admin.id, "insert into public.simulation_projects (tenant_id, brand_id, kind, name, dataset_id, rate_card_id) values ($1, $2, 'bulk', 'On a retired card', $3, $4)", [w.t1.id, w.brandA.id, datasetId, cardId]), /row-level security/);
    const input = { shipDate: "2026-03-01", originZip: "90001", destinationZip: "85001", residential: true, carrierCode: "ups", serviceCode: "ground", packages: [{ weight: "1", weightUnit: "lb" }] };
    await expectDenied(asUser(w.brandA.admin.id, "select public.save_single_simulation($1, $2, 'Retired', $3::jsonb, '{}', '2.2.0')", [w.brandA.id, cardId, JSON.stringify(input)]), /not assigned/);
    await expectDenied(asUser(w.brandA.admin.id, "select public.start_simulation_run($1, 'ship_date', null, null, 'exclude', '{}')", [projectId]), /not assigned/);
    await asUser(w.t1.admin.id, "update public.rate_cards set status = 'active' where id = $1", [cardId]);
  });

  it("single-shipment scenarios are saved for assigned cards only", async () => {
    const input = { shipDate: "2026-03-01", originZip: "90001", destinationZip: "85001", residential: true, carrierCode: "ups", serviceCode: "ground", packages: [{ weight: "1", weightUnit: "lb" }] };
    const [p] = await asUser<{ id: string }>(w.brandA.admin.id, "select public.save_single_simulation($1, $2, 'One mug to Phoenix', $3::jsonb, '{\"status\": \"ok\"}', '2.2.0') as id", [w.brandA.id, cardId, JSON.stringify(input)]);
    const [run] = await asUser<{ kind: string; status: string; as_of_date: string; single_input: { originZip: string } }>(w.brandA.employee.id, "select kind, status, as_of_date::text, single_input from public.simulation_runs where project_id = $1", [p!.id]);
    expect(run).toMatchObject({ kind: "single", status: "completed", as_of_date: "2026-03-01", single_input: { originZip: "90001" } });
    await expectDenied(asUser(w.brandB.admin.id, "select public.save_single_simulation($1, $2, 'Nope', $3::jsonb, '{}', '2.2.0')", [w.brandB.id, cardId, JSON.stringify(input)]), /not assigned/);
    await expectDenied(asUser(w.brandA.admin.id, "select public.save_single_simulation($1, $2, 'Nope', $3::jsonb, '{}', '2.2.0')", [w.brandB.id, cardId, JSON.stringify(input)]), /customer not found/);
  });
});

describe("brand-safe pricing payloads", () => {
  it("staff pricing on behalf of a brand get the fixed label, and known ZIP lists come back without entries", async () => {
    const [rule] = await asUser<{ id: string }>(w.t1.admin.id, "insert into public.surcharge_rules (scope, tenant_id, carrier_code, rule_key, category, name) values ('tenant', $1, 'ups', 'modeling.das', 'das', 'Delivery area') returning id", [w.t1.id]);
    const [list] = await asUser<{ id: string }>(w.t1.admin.id, "insert into public.zip_lists (tenant_id, carrier_code, key, name, source_reference, verification_status, effective_date) values ($1, 'ups', 'modeling.das_zips', 'DAS ZIPs', 'Internal bulletin notes', 'approved_3pl_config', '2026-01-01') returning id", [w.t1.id]);
    await asUser(w.t1.admin.id, "insert into public.zip_list_entries (list_id, entry) values ($1, '85001')", [list!.id]);
    await asUser(w.t1.admin.id, "select public.publish_zip_list($1)", [list!.id]);
    const [v] = await asUser<{ id: string }>(w.t1.admin.id, `insert into public.surcharge_rule_versions (rule_id, tenant_id, version_number, charge_class, method, amount, conditions, effective_date, source_reference, verification_status) values ($1, $2, 1, 'definite', 'flat', 4.00, '[{"type":"destination_zip_in_list","listKey":"modeling.das_zips"}]', '2026-01-01', 'Negotiated in the Q3 renewal (internal)', 'approved_3pl_config') returning id`, [rule!.id, w.t1.id]);
    await asUser(w.t1.admin.id, "select public.publish_surcharge_rule_version($1)", [v!.id]);
    type Payload = { rules: { key: string; sourceReference: string }[]; zipLists: { id: string; key: string; sourceReference: string; entries: string[] | null }[] };
    const [staffOwn] = await asUser<{ r: Payload }>(w.t1.admin.id, "select public.pricing_rules_for_card($1, '2026-03-01') as r", [cardId]);
    expect(staffOwn!.r.rules.find((r) => r.key === "modeling.das")?.sourceReference).toBe("Negotiated in the Q3 renewal (internal)");
    const [onBehalf] = await asUser<{ r: Payload }>(w.t1.admin.id, "select public.pricing_rules_for_card($1, '2026-03-01', $2) as r", [cardId, w.brandA.id]);
    expect(onBehalf!.r.rules.find((r) => r.key === "modeling.das")?.sourceReference).toBe("Your 3PL's approved pricing configuration");
    expect(onBehalf!.r.zipLists.map((l) => [l.key, l.sourceReference, l.entries])).toEqual([["modeling.das_zips", "Your 3PL's approved pricing configuration", ["85001"]]]);
    const [known] = await asUser<{ r: Payload }>(w.brandA.admin.id, "select public.pricing_rules_for_card($1, '2026-03-01', null, $2) as r", [cardId, [list!.id]]);
    expect(known!.r.zipLists.map((l) => [l.id, l.entries])).toEqual([[list!.id, null]]);
  });
});
