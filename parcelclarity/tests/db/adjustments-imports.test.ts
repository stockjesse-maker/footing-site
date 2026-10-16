import { beforeAll, describe, expect, it } from "vitest";
import {
  asOwnerWithGuardOpen, asOwnerWithoutTriggers, asUser, buildFixture, expectCode, expectDenied, sha256Hex, sql, withTx, type Fixture,
} from "./adjustments-fixture";
import { buildWorld, type World } from "./world";

/**
 * Milestone 5: the history import pipeline (upload, header guard, mapping, attestation, chunked commit, finalize, discard, reset,
 * withdraw), baselines and saved risk estimates. A history file is customer-facing charges only: the tests prove that a file that
 * looks like carrier cost data is refused and deleted, that nothing is stored for it, and that raw files are deleted when an
 * import ends. All rows are fictional.
 */
let w: World;
let f: Fixture;

beforeAll(async () => {
  w = await buildWorld();
  f = await buildFixture(w);
});

const admin = () => w.t1.admin.id;
const admin2 = () => w.t1.admin2.id;

const csv = (headers: string[], rows: string[][] = [["2026-03-01", "ups"]]) => Buffer.from([headers.join(","), ...rows.map((r) => r.join(","))].join("\n") + "\n");
const GOOD_HEADERS = ["ship_date", "carrier", "service", "brand", "adjustment_type", "cause", "package_ref", "declared_weight", "actual_weight", "customer_charge_original", "customer_charge_corrected", "customer_adjustment_fee"];

async function upload(userId: string, content: Buffer, opts: { filename?: string; mime?: string; purpose?: string; tenant?: string } = {}): Promise<string> {
  const [r] = await asUser<{ id: string }>(
    userId,
    "insert into public.uploaded_files (tenant_id, purpose, filename, mime_type, byte_size, sha256, content) values ($1, $2, $3, $4, $5, decode($6, 'hex'), $7) returning id",
    [opts.tenant ?? w.t1.id, opts.purpose ?? "adjustment_import", opts.filename ?? "history.csv", opts.mime ?? "text/csv", content.length, sha256Hex(content), content],
  );
  return r!.id;
}

interface Created { ok: boolean; importId?: string; reason?: string; header?: string }
const createImport = (userId: string, file: string, name = "March history", detected: unknown = { headers: GOOD_HEADERS, sampleRows: [] }) =>
  asUser<{ r: Created }>(userId, "select public.create_adjustment_import($1, $2, $3::jsonb) as r", [file, name, JSON.stringify(detected)]).then((r) => r[0]!.r);

const MAPPING = { fields: { ship_date: "ship_date", carrier_code: "carrier", package_ref: "package_ref", original_charge: "customer_charge_original", corrected_charge: "customer_charge_corrected", separate_fee: "customer_adjustment_fee" } };
const validation = (rows: number, accepted = rows) => ({ counts: { rows, accepted, issues: {} } });
const setMapping = (userId: string, id: string, mapping: unknown = MAPPING, validationReport: unknown = null, attested = false, dup = "refuse") =>
  asUser<{ s: string }>(userId, "select public.set_adjustment_import_mapping($1, $2::jsonb, $3::jsonb, $4, $5) as s", [id, JSON.stringify(mapping), validationReport === null ? null : JSON.stringify(validationReport), dup, attested]).then((r) => r[0]!.s);

const baseRow = (i: number, over: Record<string, unknown> = {}) => ({
  ship_date: "2026-03-01", adjusted_on: "2026-03-05", carrier_code: "ups", service_id: f.upsGround, service_text: "UPS Ground", brand_id: w.brandA.id, adjustment_type: "reweight",
  cause: "carrier_reweigh", reason_text: "Weight corrected", package_ref: `1Z${String(i).padStart(8, "0")}`, declared_weight_lb: "3", declared_weight_basis: "measured", actual_weight_lb: "5",
  original_charge: "12.79", corrected_charge: "13.35", separate_fee: "3.00", ...over,
});
const rowsFrom = (from: number, n: number, over: (i: number) => Record<string, unknown> = () => ({})) => Array.from({ length: n }, (_, k) => baseRow(from + k, over(from + k)));
const append = (userId: string, id: string, from: number, rows: unknown[]) =>
  asUser<{ r: Record<string, number | boolean> }>(userId, "select public.append_adjustment_records($1, $2, $3::jsonb) as r", [id, from, JSON.stringify(rows)]).then((r) => r[0]!.r);
const finalize = (userId: string, id: string) => asUser<{ r: Record<string, unknown> }>(userId, "select public.finalize_adjustment_import($1) as r", [id]).then((r) => r[0]!.r);
const statusOf = async (id: string) => (await sql<{ status: string; file_id: string | null; committed_count: number; skipped_count: number }>("select status, file_id, committed_count, skipped_count from public.adjustment_imports where id = $1", [id]))[0]!;
const recordCount = async (id: string) => Number((await sql<{ n: string }>("select count(*)::text as n from public.adjustment_records where import_id = $1", [id]))[0]!.n);
const fileExists = async (id: string) => (await sql("select 1 from public.uploaded_files where id = $1", [id])).length === 1;
/** A stored history file inserted by the database owner with the triggers off: what a file that bypassed the insert guard would look like. */
const ownerFile = async (content: Buffer, over: { filename?: string; mime?: string; tenant?: string; by?: string } = {}) =>
  (await asOwnerWithoutTriggers("insert into public.uploaded_files (tenant_id, uploaded_by, purpose, filename, mime_type, byte_size, sha256, content) values ($1, $2, 'adjustment_import', $3, $4, $5, decode($6, 'hex'), $7) returning id",
    [over.tenant ?? w.t1.id, over.by ?? admin(), over.filename ?? "bypass.csv", over.mime ?? "text/csv", content.length, sha256Hex(content), content]))[0]!.id as string;

/** A validated import ready for rows. */
async function validatedImport(rows: number, userId = admin(), accepted = rows): Promise<{ id: string; file: string }> {
  const file = await upload(userId, csv(GOOD_HEADERS));
  const created = await createImport(userId, file, `Import of ${rows}`);
  expect(created.ok).toBe(true);
  await setMapping(userId, created.importId!, MAPPING, validation(rows, accepted), true);
  return { id: created.importId!, file };
}

// ---------------------------------------------------------------------------
// The header guard (database side) and registration
// ---------------------------------------------------------------------------
describe("the forbidden-header test", () => {
  const forbidden = async (h: string) => (await sql<{ r: boolean }>("select app.adjustment_header_forbidden($1) as r", [h]))[0]!.r;

  it("refuses 30 cost-like headers and lets 30 customer-charge headers through (false positives included)", async () => {
    const bad = [
      "Carrier Rate", "Postage Cost", "Label Cost", "Shipping Cost", "Negotiated Rate", "Postage Paid", "Actual Postage", "Carrier Cost", "Carrier Charge", "Carrier Adjustment", "Carrier Invoice",
      "Net Amount", "Net Rate", "Buy Rate", "Our Cost", "Cost to Us", "Wholesale Price", "Invoice Amount", "INVOICE_TOTAL", "carrier_billed", "Carrier Billed Amount", "postage-cost", "Postage  Cost",
      "carrier.fee", "Paid", "Rate", "Label", "UPS Cost", "Cost", "Negotiated",
    ];
    const good = [
      "ship_date", "adjusted_on", "carrier", "service", "brand", "adjustment_type", "cause", "reason", "package_ref", "declared_weight", "actual_weight", "weight_unit", "original_length", "corrected_height",
      "dimension_unit", "customer_charge_original", "customer_charge_corrected", "customer_adjustment_fee", "handling", "Customer Charge", "Carrier Charge to Customer", "Charged to Customer",
      "Billed to Customer", "Tracking Number", "Tracking", "Ship Date", "Service Level", "Reweigh Reason", "Corrected Weight (lb)", "Customer",
    ];
    expect(bad).toHaveLength(30);
    expect(good).toHaveLength(30);
    for (const h of bad) expect(await forbidden(h), `refused: ${h}`).toBe(true);
    for (const h of good) expect(await forbidden(h), `accepted: ${h}`).toBe(false);
  });
});

describe("registering an upload", () => {
  it("creates an import for the uploader; the detected headers and at most 20 sample rows are kept", async () => {
    const file = await upload(admin(), csv(GOOD_HEADERS));
    const detected = { headers: GOOD_HEADERS, sampleRows: [{ ship_date: "2026-03-01", package_ref: "1Z000001" }] };
    const created = await createImport(admin(), file, "  March history  ", detected);
    expect(created).toMatchObject({ ok: true });
    const [row] = await sql<Record<string, unknown>>("select tenant_id, file_id, name, status, detected, mapping, validation, duplicate_handling, row_count, accepted_count, committed_count, skipped_count, created_by from public.adjustment_imports where id = $1", [created.importId]);
    expect(row).toEqual({ tenant_id: w.t1.id, file_id: file, name: "March history", status: "uploaded", detected, mapping: null, validation: null, duplicate_handling: "refuse", row_count: 0, accepted_count: 0, committed_count: 0, skipped_count: 0, created_by: admin() });
    await expectCode(createImport(admin(), file), "P0001", /already has an import/);
  });

  it("another person's file, a file of another purpose, another tenant's file and an unknown id are all 'not found'", async () => {
    const theirs = await upload(admin2(), csv(GOOD_HEADERS));
    await expectCode(createImport(admin(), theirs), "P0002", /not found/); // the uploader must be the caller
    const otherPurpose = await upload(admin(), csv(GOOD_HEADERS), { purpose: "rate_card" });
    await expectCode(createImport(admin(), otherPurpose), "P0002", /not found/);
    const foreign = await upload(w.t2.admin.id, csv(GOOD_HEADERS), { tenant: w.t2.id });
    await expectCode(createImport(admin(), foreign), "P0002", /not found/);
    await expectCode(createImport(w.t1.employee.id, theirs), "P0002", /not found/);
    await expectCode(createImport(admin(), "00000000-0000-4000-8000-000000000000"), "P0002", /not found/);
    expect(await createImport(w.t2.admin.id, foreign)).toMatchObject({ ok: true }); // their own tenant's administrator may
  });

  it("a file whose header looks like carrier cost data is never stored; one that got past the guard anyway is refused and deleted at registration", async () => {
    const importsBefore = Number((await sql<{ n: string }>("select count(*)::text as n from public.adjustment_imports where tenant_id = $1", [w.t1.id]))[0]!.n);
    const filesBefore = Number((await sql<{ n: string }>("select count(*)::text as n from public.uploaded_files where tenant_id = $1 and purpose = 'adjustment_import'", [w.t1.id]))[0]!.n);
    const bads = ["Carrier Rate", "Postage Cost", "Label Cost", "Shipping Cost", "Negotiated Rate", "Postage Paid"];
    // 1. The insert itself is refused (a BEFORE INSERT trigger reads the first fifty lines of the stored bytes): nothing is stored.
    for (const bad of bads) {
      const err = (await upload(admin(), csv(["ship_date", "carrier", bad, "package_ref"], [["2026-03-01", "ups", "7.42", "1Z0001"]])).catch((e) => e)) as { code?: string; hint?: string; detail?: string; message?: string };
      expect(err, bad).toMatchObject({ code: "P0001", hint: "forbidden_header", detail: bad, message: "this file was not saved" });
    }
    expect(Number((await sql<{ n: string }>("select count(*)::text as n from public.uploaded_files where tenant_id = $1 and purpose = 'adjustment_import'", [w.t1.id]))[0]!.n)).toBe(filesBefore);
    // 2. A file that bypassed the trigger (the owner inserts with triggers off) is refused by create_adjustment_import, which deletes it.
    for (const bad of bads) {
      const file = await ownerFile(csv(["ship_date", "carrier", bad, "package_ref"], [["2026-03-01", "ups", "7.42", "1Z0001"]]));
      const out = await createImport(admin(), file, `refused ${bad}`, { headers: ["ship_date", "carrier", "package_ref"] });
      expect(out).toEqual({ ok: false, reason: "forbidden_header", header: bad });
      expect(await fileExists(file), bad).toBe(false);
    }
    // 3. Also when only the declared details name it (an XLSX cannot be read in SQL), or a sample row's key does.
    const x = await upload(admin(), Buffer.from("PK\u0003\u0004 binary"), { filename: "history.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    expect(await createImport(admin(), x, "xlsx", { headers: ["ship_date", "Carrier Cost"] })).toMatchObject({ ok: false, header: "Carrier Cost" });
    expect(await fileExists(x)).toBe(false);
    const y = await upload(admin(), csv(GOOD_HEADERS));
    expect(await createImport(admin(), y, "samples", { headers: ["ship_date"], sampleRows: [{ "Net Amount": "5.00" }] })).toMatchObject({ ok: false, header: "Net Amount" });
    expect(await fileExists(y)).toBe(false);
    expect(Number((await sql<{ n: string }>("select count(*)::text as n from public.adjustment_imports where tenant_id = $1", [w.t1.id]))[0]!.n)).toBe(importsBefore);
    // No detected header or sample row of a refused file survives anywhere.
    expect(await sql("select 1 from public.adjustment_imports where detected::text like '%Net Amount%' or detected::text like '%Carrier Cost%'")).toHaveLength(0);
    // A header that merely contains the word "customer" next to a money word passes.
    const ok = await upload(admin(), csv(["ship_date", "Carrier Charge to Customer"]));
    expect(await createImport(admin(), ok, "customer charge", { headers: ["ship_date", "Carrier Charge to Customer"] })).toMatchObject({ ok: true });
  });

  it("limits the shape of what is stored: size, header count, sample rows; at most five imports in progress", async () => {
    const f1 = await upload(admin2(), csv(GOOD_HEADERS));
    await expectCode(createImport(admin2(), f1, "big", { headers: GOOD_HEADERS, padding: "x".repeat(70_000) }), "PC001", /invalid file details/);
    await expectCode(createImport(admin2(), f1, "many samples", { headers: GOOD_HEADERS, sampleRows: Array.from({ length: 21 }, () => ({})) }), "PC001", /invalid file details/);
    await expectCode(createImport(admin2(), f1, "many headers", { headers: Array.from({ length: 201 }, (_, i) => `h${i}`) }), "PC001", /invalid file details/);
    await expectCode(createImport(admin2(), f1, "   "), "PC001", /name must be/);
    await expectCode(createImport(admin2(), f1, "not an object", []), "PC001", /invalid file details/);
    // Tenant t1 already has several open imports from the tests above; fill the rest up to five, then one more is refused.
    const open = async () => Number((await sql<{ n: string }>("select count(*)::text as n from public.adjustment_imports where tenant_id = $1 and status in ('uploaded','mapped','validated','committing')", [w.t1.id]))[0]!.n);
    const made: string[] = [];
    while ((await open()) < 5) made.push((await createImport(admin2(), await upload(admin2(), csv(GOOD_HEADERS)), `fill ${made.length}`)).importId!);
    await expectCode(createImport(admin2(), f1, "sixth"), "P0001", /too many imports are in progress/);
    await asUser(admin2(), "select public.discard_adjustment_import($1)", [made[0] ?? (await sql<{ id: string }>("select id from public.adjustment_imports where tenant_id = $1 and status = 'uploaded' limit 1", [w.t1.id]))[0]!.id]);
    expect(await createImport(admin2(), f1, "now it fits")).toMatchObject({ ok: true });
    // Close everything so the other tests start from an empty queue.
    for (const r of await sql<{ id: string }>("select id from public.adjustment_imports where tenant_id = $1 and status in ('uploaded','mapped','validated','committing')", [w.t1.id])) await asUser(admin(), "select public.discard_adjustment_import($1)", [r.id]);
    expect(await open()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Mapping, attestation, status
// ---------------------------------------------------------------------------
describe("mapping and attestation", () => {
  it("a flagged header can never be mapped, even by hand; the refusal names the column, never a value", async () => {
    const { id } = await validatedImport(5);
    await expectCode(setMapping(admin(), id, { fields: { ...MAPPING.fields, original_charge: "Postage Cost" } }), "P0001", /looks like carrier cost data/);
    const err = await setMapping(admin(), id, { fields: { ...MAPPING.fields, corrected_charge: "Carrier Rate" } }).catch((e: { detail?: string }) => e);
    expect((err as { detail?: string }).detail).toBe("Carrier Rate");
  });

  it("moves uploaded -> mapped -> validated only with the attestation; changing the mapping clears it", async () => {
    const file = await upload(admin(), csv(GOOD_HEADERS));
    const { importId } = await createImport(admin(), file);
    expect(await setMapping(admin(), importId!, MAPPING)).toBe("mapped");
    await expectCode(setMapping(admin(), importId!, MAPPING, validation(10), false), "P0001", /confirm that the amounts/);
    await expectCode(setMapping(admin(), importId!, MAPPING, { counts: { rows: 10 } }, true), "PC001", /counts\.rows and counts\.accepted/);
    await expectCode(setMapping(admin(), importId!, MAPPING, validation(10, 0), true), "PC001", /nothing to import/);
    await expectCode(setMapping(admin(), importId!, MAPPING, validation(5, 10), true), "PC001", /nothing to import|too many/);
    await expectCode(setMapping(admin(), importId!, "not an object" as unknown), "PC001", /invalid mapping/);
    await expectCode(setMapping(admin(), importId!, MAPPING, null, false, "maybe"), "PC001", /invalid mapping/);
    expect(await setMapping(admin(), importId!, MAPPING, validation(10, 9), true, "sum")).toBe("validated");
    expect(await sql("select status, accepted_count, row_count, duplicate_handling, attested_by from public.adjustment_imports where id = $1", [importId])).toEqual([{ status: "validated", accepted_count: 9, row_count: 10, duplicate_handling: "sum", attested_by: admin() }]);
    expect(await setMapping(admin(), importId!, { fields: { ...MAPPING.fields, cause: "reason" } })).toBe("mapped");
    expect(await sql("select status, accepted_count, attested_by, attested_at, validation from public.adjustment_imports where id = $1", [importId])).toEqual([{ status: "mapped", accepted_count: 0, attested_by: null, attested_at: null, validation: null }]);
    await asUser(admin(), "select public.discard_adjustment_import($1)", [importId]);
    await expectCode(setMapping(admin(), importId!, MAPPING), "P0004", /no longer being edited/);
  });

  it("nobody else can touch an import: everything is 'not found', the same as an unknown id", async () => {
    const { id } = await validatedImport(3);
    const calls: [string, string, unknown[]][] = [
      ["set_adjustment_import_mapping", "select public.set_adjustment_import_mapping($1, $2::jsonb) as r", [id, JSON.stringify(MAPPING)]],
      ["append_adjustment_records", "select public.append_adjustment_records($1, 1, $2::jsonb) as r", [id, JSON.stringify(rowsFrom(1, 1))]],
      ["finalize_adjustment_import", "select public.finalize_adjustment_import($1) as r", [id]],
      ["discard_adjustment_import", "select public.discard_adjustment_import($1) as r", [id]],
      ["withdraw_adjustment_import", "select public.withdraw_adjustment_import($1) as r", [id]],
      ["reset_adjustment_import", "select public.reset_adjustment_import($1) as r", [id]],
    ];
    for (const user of [w.t2.admin, w.t1.employee, w.brandA.admin, w.brandA.employee, w.brandB.admin, w.outsider, w.platformAdmin]) {
      for (const [name, text, params] of calls) await expectCode(asUser(user.id, text, params), "P0002", /^not found$/).catch((e) => { throw new Error(`${name} as ${user.email}: ${e.message}`); });
    }
    for (const [name, text] of calls) await expectCode(asUser(admin(), text, ["00000000-0000-4000-8000-000000000000", ...(name === "append_adjustment_records" ? [JSON.stringify(rowsFrom(1, 1))] : name === "set_adjustment_import_mapping" ? [JSON.stringify(MAPPING)] : [])].slice(0, text.includes("$2") ? 2 : 1)), "P0002", /^not found$/);
    await asUser(admin(), "select public.discard_adjustment_import($1)", [id]);
  });
});

// ---------------------------------------------------------------------------
// Appending rows
// ---------------------------------------------------------------------------
describe("appending rows", () => {
  it("re-validates every field in SQL, names the row and the reason, and never echoes a value", async () => {
    const { id } = await validatedImport(50);
    const bad: [string, Record<string, unknown>][] = [
      ["invalid_ship_date", { ship_date: "2026-02-30" }],
      ["invalid_ship_date", { ship_date: "last Tuesday" }],
      ["invalid_ship_date", { ship_date: "2999-01-01" }],
      ["invalid_adjusted_on", { adjusted_on: "2026-02-28" }],
      ["unknown_carrier", { carrier_code: "acme" }],
      ["unknown_service", { service_id: "00000000-0000-4000-8000-000000000000" }],
      ["unknown_service", { carrier_code: "fedex" }],
      ["unknown_customer", { brand_id: w.brandC.id }],
      ["invalid_type", { adjustment_type: "recount" }],
      ["invalid_cause", { cause: "gremlins" }],
      ["text_too_long", { reason_text: "r".repeat(121) }],
      ["invalid_package_ref", { package_ref: "" }],
      ["weight_basis_mismatch", { declared_weight_basis: "missing" }],
      ["weight_basis_mismatch", { declared_weight_lb: null, declared_weight_basis: "measured" }],
      ["invalid_weight_basis", { declared_weight_basis: "guessed" }],
      ["invalid_weight", { declared_weight_lb: "0" }],
      ["invalid_weight", { actual_weight_lb: "-4" }],
      ["invalid_weight", { actual_weight_lb: "4 lb" }],
      ["partial_dimensions", { orig_length_in: "10" }],
      ["partial_dimensions", { corr_length_in: "10", corr_width_in: "8" }],
      ["invalid_dimensions", { orig_length_in: "10", orig_width_in: "0", orig_height_in: "6" }],
      ["negative_amount", { original_charge: "-3.20" }],
      ["negative_amount", { separate_fee: "-0.01" }],
      ["invalid_amount", { corrected_charge: "13,35" }],
      ["invalid_amount", { original_charge: "$12.79" }],
      ["invalid_amount", { separate_fee: "3.001" }],
      ["invalid_handling", { handling_recorded: "waived" }],
    ];
    for (const [code, over] of bad) {
      const err = (await append(admin(), id, 1, [baseRow(1, over)]).catch((e) => e)) as { code?: string; message?: string };
      expect(err.code, code).toBe("PC001");
      expect(err.message, code).toBe(`row 1: ${code}`);
    }
    // The row number is the row's position in the file, and the error never contains a value.
    const err = (await append(admin(), id, 1, [...rowsFrom(1, 6), baseRow(7, { cause: "SENTINEL_BAD_CAUSE" })]).catch((e) => e)) as { message: string };
    expect(err.message).toBe("row 7: invalid_cause");
    expect(await recordCount(id)).toBe(0);
    await expectCode(append(admin(), id, 1, [{ ...baseRow(1), carrier_cost: "7.42" }]), "PC001", /field this import does not know/);
    await expectCode(append(admin(), id, 1, [5]), "PC001", /field this import does not know|invalid chunk/);
    await expectCode(append(admin(), id, 1, []), "PC001", /between 1 and 2000/);
    await expectCode(append(admin(), id, 1, rowsFrom(1, 2001)), "PC001", /between 1 and 2000/);
    await expectCode(asUser(admin(), "select public.append_adjustment_records($1, 0, '[]')", [id]), "PC001", /invalid chunk/);
    await asUser(admin(), "select public.discard_adjustment_import($1)", [id]);
  });

  it("stores blank amounts as NULL (never 0), accepts credits, a missing declared weight and weights without amounts", async () => {
    const { id } = await validatedImport(4);
    await append(admin(), id, 1, [
      baseRow(1, { original_charge: null, corrected_charge: null, separate_fee: null, actual_weight_lb: null }),
      baseRow(2, { original_charge: "13.35", corrected_charge: "12.79", separate_fee: null }),
      baseRow(3, { declared_weight_lb: null, declared_weight_basis: "missing", cause: "wms_no_weight", original_charge: null, corrected_charge: "9.60" }),
      { ship_date: "2026-03-02", carrier_code: "usps", adjustment_type: "remeasure", cause: "carrier_remeasure", orig_length_in: "10", orig_width_in: "8", orig_height_in: "6", corr_length_in: "12", corr_width_in: "8", corr_height_in: "6" },
    ]);
    const rows = await sql<Record<string, string | null>>("select row_no, original_charge::text, corrected_charge::text, separate_fee::text, postage_difference::text, declared_weight_lb::text, declared_weight_basis, brand_id, service_id, package_ref, orig_length_in::text, corr_length_in::text from public.adjustment_records where import_id = $1 order by row_no", [id]);
    expect(rows[0]).toMatchObject({ original_charge: null, corrected_charge: null, separate_fee: null, postage_difference: null, declared_weight_lb: "3.000000" });
    expect(rows[1]).toMatchObject({ original_charge: "13.35", corrected_charge: "12.79", separate_fee: null, postage_difference: "-0.56" });
    expect(rows[2]).toMatchObject({ declared_weight_lb: null, declared_weight_basis: "missing", original_charge: null, corrected_charge: "9.60", postage_difference: null });
    expect(rows[3]).toMatchObject({ brand_id: null, service_id: null, package_ref: null, declared_weight_basis: "missing", orig_length_in: "10.0000", corr_length_in: "12.0000" });
    expect(await recordCount(id)).toBe(4);
    await asUser(admin(), "select public.discard_adjustment_import($1)", [id]);
  });

  it("numbers rows from a cursor: a retried chunk is acknowledged, a gap or an overlap is refused, extra rows are refused", async () => {
    const { id } = await validatedImport(6);
    expect(await append(admin(), id, 1, rowsFrom(1, 3))).toMatchObject({ applied: true, inserted: 3, skipped: 0, nextRow: 4, committed: 3 });
    expect(await sql("select status from public.adjustment_imports where id = $1", [id])).toEqual([{ status: "committing" }]);
    expect(await append(admin(), id, 1, rowsFrom(1, 3))).toMatchObject({ applied: false, nextRow: 4, committed: 3 }); // retried
    expect(await recordCount(id)).toBe(3);
    await expectCode(append(admin(), id, 5, rowsFrom(5, 2)), "PC002", /does not start at the cursor/); // gap
    await expectCode(append(admin(), id, 3, rowsFrom(3, 3)), "PC002", /does not start at the cursor/); // overlaps the stored rows
    await expectCode(append(admin(), id, 4, rowsFrom(4, 4)), "PC003", /more rows than the validated count/);
    expect(await append(admin(), id, 4, rowsFrom(4, 3))).toMatchObject({ applied: true, nextRow: 7 });
    expect((await sql<{ rn: string }>("select string_agg(row_no::text, ',' order by row_no) as rn from public.adjustment_records where import_id = $1", [id]))[0]!.rn).toBe("1,2,3,4,5,6");
    // The action names used for the rate limit match the counters' constraint (letters, dots and underscores only).
    const actions = await sql<{ action: string }>("select distinct action from public.rate_limit_counters where user_id = $1 and action like 'adjustment.%'", [admin()]);
    expect(actions.map((a) => a.action).sort()).toEqual(["adjustment.append", "adjustment.import"]);
    for (const a of actions) expect(a.action).toMatch(/^[a-z_.]{2,60}$/);
    await asUser(admin(), "select public.discard_adjustment_import($1)", [id]);
  });

  it("refuses a repeated package reference within the import, skips rows already imported earlier and counts them", async () => {
    const one = await validatedImport(3);
    await expectCode(append(admin(), one.id, 1, [baseRow(1), baseRow(2, { package_ref: baseRow(1).package_ref })]), "PC001", /^row 2: duplicate_package$/);
    // The same reference as another type, carrier or customer is a different package record.
    await append(admin(), one.id, 1, [baseRow(1), baseRow(2, { package_ref: baseRow(1).package_ref, adjustment_type: "remeasure" }), baseRow(3, { package_ref: baseRow(1).package_ref, brand_id: null })]);
    await expectCode(append(admin(), one.id, 4, [baseRow(9)]), "PC003", /more rows than the validated count/);
    expect(await finalize(admin(), one.id)).toMatchObject({ committed: 3, skipped: 0 });
    // A second file that overlaps: the rows already imported are skipped and counted, never overwritten.
    const two = await validatedImport(4);
    expect(await append(admin(), two.id, 1, [baseRow(1, { corrected_charge: "99.00" }), baseRow(2, { package_ref: baseRow(1).package_ref, adjustment_type: "remeasure" }), baseRow(50), baseRow(51)])).toMatchObject({ applied: true, inserted: 2, skipped: 2, nextRow: 5 });
    expect(await finalize(admin(), two.id)).toMatchObject({ committed: 2, skipped: 2 });
    expect((await sql<{ c: string }>("select corrected_charge::text as c from public.adjustment_records where import_id = $1 and package_ref = $2", [one.id, baseRow(1).package_ref]))[0]!.c).toBe("13.35");
    expect(await sql("select status, committed_count, skipped_count from public.adjustment_imports where id = $1", [two.id])).toEqual([{ status: "committed", committed_count: 2, skipped_count: 2 }]);
    // A customer's packages and another customer's with the same carrier reference are different records.
    const three = await validatedImport(1);
    expect(await append(admin(), three.id, 1, [baseRow(1, { brand_id: w.brandB.id })])).toMatchObject({ inserted: 1, skipped: 0 });
    await asUser(admin(), "select public.discard_adjustment_import($1)", [three.id]);
    for (const imp of [one.id, two.id]) await asUser(admin(), "select public.withdraw_adjustment_import($1)", [imp]);
  });

  it("the account holds at most 200,000 records", async () => {
    const owner = w.t2.admin;
    const file = await upload(owner.id, csv(GOOD_HEADERS), { tenant: w.t2.id });
    const created = (await asUser<{ r: Created }>(owner.id, "select public.create_adjustment_import($1, 'cap', $2::jsonb) as r", [file, JSON.stringify({ headers: GOOD_HEADERS })]))[0]!.r;
    await asUser(owner.id, "select public.set_adjustment_import_mapping($1, $2::jsonb, $3::jsonb, 'refuse', true)", [created.importId, JSON.stringify(MAPPING), JSON.stringify(validation(10))]);
    const [filler] = await sql<{ id: string }>("insert into public.adjustment_imports (tenant_id, name, status, accepted_count, committed_count, attested_by, attested_at) values ($1, 'filler', 'committed', 199999, 199999, $2, now()) returning id", [w.t2.id, owner.id]);
    await sql("insert into public.adjustment_records (tenant_id, import_id, row_no, ship_date, carrier_code, adjustment_type, cause, declared_weight_basis) select $1, $2, g, '2026-01-01', 'ups', 'reweight', 'other', 'missing' from generate_series(1, 199999) g", [w.t2.id, filler!.id]);
    await expectCode(asUser(owner.id, "select public.append_adjustment_records($1, 1, $2::jsonb)", [created.importId, JSON.stringify(rowsFrom(1, 2).map((r) => ({ ...r, brand_id: null, service_id: null })))]), "P0001", /limit of 200,000 records/);
    expect(await asUser(owner.id, "select public.append_adjustment_records($1, 1, $2::jsonb) as r", [created.importId, JSON.stringify(rowsFrom(1, 1).map((r) => ({ ...r, brand_id: null, service_id: null })))])).toHaveLength(1);
    await sql("select app.purge_tenant_adjustment_data($1)", [w.t2.id]);
  });
});

// ---------------------------------------------------------------------------
// Finishing, discarding, resetting
// ---------------------------------------------------------------------------
describe("finishing an import", () => {
  it("finalizes once: every validated row is stored, the attestation exists, the raw file is deleted, the audit row carries counts only", async () => {
    const { id, file } = await validatedImport(5);
    await expectCode(finalize(admin(), id), "P0004", /not being committed/); // nothing sent yet
    await append(admin(), id, 1, rowsFrom(1, 3));
    await expectCode(finalize(admin(), id), "PC003", /do not match the validated count/);
    await append(admin(), id, 4, rowsFrom(4, 2));
    expect(await fileExists(file)).toBe(true);
    // The attestation cannot be missing at this point; make it so through the owner and see finalize refuse.
    await asOwnerWithGuardOpen("update public.adjustment_imports set attested_at = null, attested_by = null where id = $1", [id]);
    await expectCode(finalize(admin(), id), "P0001", /attestation is missing/);
    await asOwnerWithGuardOpen("update public.adjustment_imports set attested_at = now(), attested_by = $2 where id = $1", [id, admin()]);
    expect(await finalize(admin(), id)).toEqual({ importId: id, committed: 5, skipped: 0 });
    expect(await statusOf(id)).toMatchObject({ status: "committed", file_id: null, committed_count: 5 });
    expect(await fileExists(file)).toBe(false); // the raw bytes are gone once the import is committed
    await expectCode(finalize(admin(), id), "P0004", /not being committed/);
    await expectCode(append(admin(), id, 6, rowsFrom(6, 1)), "P0004", /not accepting rows/);
    await expectCode(asUser(admin(), "select public.discard_adjustment_import($1)", [id]), "P0004", /withdrawn, not discarded/);
    const [audit] = await sql<{ actor_id: string; metadata: Record<string, unknown> }>("select actor_id, metadata from public.audit_events where action = 'adjustment.import_committed' and entity_id = $1", [id]);
    expect(audit!.actor_id).toBe(admin());
    expect(audit!.metadata).toEqual({ name: "Import of 5", committed: 5, skipped: 0, accepted: 5, attested: true });
    // Staff read the records through the bulk reader, in pages of at most 1,000; nobody else gets anything.
    const [page] = await asUser<{ r: Record<string, unknown>[] }>(admin(), "select public.adjustment_records_json($1, 2, 2) as r", [id]);
    expect(page!.r.map((r) => r.rowNo)).toEqual([2, 3]);
    expect(page!.r[0]).toMatchObject({ carrierCode: "ups", adjustmentType: "reweight", cause: "carrier_reweigh", originalCharge: "12.79", correctedCharge: "13.35", separateFee: "3.00", postageDifference: "0.56", declaredWeightLb: "3.000000", declaredWeightBasis: "measured" });
    for (const user of [w.brandA.admin, w.brandB.admin, w.t1.employee, w.t2.admin, w.outsider, w.platformAdmin]) expect((await asUser<{ r: unknown[] }>(user.id, "select public.adjustment_records_json($1) as r", [id]))[0]!.r, user.email).toEqual([]);
    expect(await asUser(w.brandA.admin.id, "select * from public.adjustment_records")).toHaveLength(0);
    await asUser(admin(), "select public.withdraw_adjustment_import($1)", [id]);
  });

  it("discard throws away partial rows and the file; it is idempotent; the import can never be reopened", async () => {
    const { id, file } = await validatedImport(4);
    await append(admin(), id, 1, rowsFrom(1, 2));
    await asUser(admin(), "select public.discard_adjustment_import($1)", [id]);
    await asUser(admin(), "select public.discard_adjustment_import($1)", [id]);
    expect(await recordCount(id)).toBe(0);
    expect(await fileExists(file)).toBe(false);
    expect(await statusOf(id)).toMatchObject({ status: "discarded", file_id: null, committed_count: 0 });
    await expectCode(append(admin(), id, 1, rowsFrom(1, 1)), "P0004", /not accepting rows/);
    await expectCode(asOwnerWithGuardOpen("update public.adjustment_imports set status = 'validated' where id = $1", [id]), "42501", /closed import/);
    expect(await sql("select 1 from public.audit_events where action = 'adjustment.import_discarded' and entity_id = $1", [id])).toHaveLength(1);
  });

  it("an interrupted commit is rolled back to 'validated' and can be sent again from the start", async () => {
    const { id } = await validatedImport(4);
    await append(admin(), id, 1, rowsFrom(1, 2));
    await expectCode(asUser(w.t1.employee.id, "select public.reset_adjustment_import($1)", [id]), "P0002", /not found/);
    await asUser(admin(), "select public.reset_adjustment_import($1)", [id]);
    expect(await recordCount(id)).toBe(0);
    expect(await statusOf(id)).toMatchObject({ status: "validated", committed_count: 0, skipped_count: 0 });
    await expectCode(asUser(admin(), "select public.reset_adjustment_import($1)", [id]), "P0004", /not being committed/);
    expect(await append(admin(), id, 1, rowsFrom(1, 4))).toMatchObject({ inserted: 4, nextRow: 5 });
    expect(await finalize(admin(), id)).toMatchObject({ committed: 4 });
    await asUser(admin(), "select public.withdraw_adjustment_import($1)", [id]);
  });

  it("a commit that races a discard ends in one state: discarded, with no rows left behind", async () => {
    const { id, file } = await validatedImport(4);
    await append(admin(), id, 1, rowsFrom(1, 2));
    let discarded: Promise<unknown> | undefined;
    await withTx(admin(), async (q) => {
      // Connection A is part-way through the second chunk (it holds the import's lock) when connection B asks to discard.
      await q("select public.append_adjustment_records($1, 3, $2::jsonb)", [id, JSON.stringify(rowsFrom(3, 2))]);
      discarded = asUser(admin(), "select public.discard_adjustment_import($1)", [id]);
      await new Promise((r) => setTimeout(r, 300));
      expect(await recordCount(id)).toBe(2); // A's rows are not visible yet, and B is still waiting
    });
    await discarded;
    expect(await recordCount(id)).toBe(0);
    expect(await statusOf(id)).toMatchObject({ status: "discarded", file_id: null });
    expect(await fileExists(file)).toBe(false);
    // And the other way round: a chunk that arrives after the discard is refused.
    await expectCode(append(admin(), id, 3, rowsFrom(3, 2)), "P0004", /not accepting rows/);
  });

  it("two copies of the same chunk arriving together store it once", async () => {
    const { id } = await validatedImport(3);
    const [a, b] = await Promise.all([append(admin(), id, 1, rowsFrom(1, 3)), append(admin2(), id, 1, rowsFrom(1, 3))]);
    expect([a.applied, b.applied].sort()).toEqual([false, true]);
    expect(await recordCount(id)).toBe(3);
    await asUser(admin(), "select public.discard_adjustment_import($1)", [id]);
  });
});

describe("a 20,000-row history file", () => {
  it("is stored in 10 chunks, finalized once, and read back in pages of 1,000", async () => {
    const { id, file } = await validatedImport(20_000);
    for (let chunk = 0; chunk < 10; chunk++) {
      const rows = rowsFrom(chunk * 2000 + 1, 2000, (i) => ({ ship_date: `2026-0${1 + (i % 6)}-${String(1 + (i % 27)).padStart(2, "0")}`, adjusted_on: null, brand_id: i % 3 === 0 ? null : w.brandA.id }));
      const out = await append(admin(), id, chunk * 2000 + 1, rows);
      expect(out).toMatchObject({ applied: true, inserted: 2000, skipped: 0, nextRow: (chunk + 1) * 2000 + 1 });
    }
    expect(await recordCount(id)).toBe(20_000);
    expect(await finalize(admin(), id)).toEqual({ importId: id, committed: 20_000, skipped: 0 });
    expect(await fileExists(file)).toBe(false);
    const [p1] = await asUser<{ r: { rowNo: number }[] }>(admin(), "select public.adjustment_records_json($1, 1, 5000) as r", [id]);
    expect(p1!.r).toHaveLength(1000); // the page is capped
    const [last] = await asUser<{ r: { rowNo: number }[] }>(admin(), "select public.adjustment_records_json($1, 19501, 1000) as r", [id]);
    expect(last!.r).toHaveLength(500);
    expect(last!.r.at(-1)!.rowNo).toBe(20_000);
    expect(await sql("select 1 from public.audit_events where tenant_id = $1 and action = 'adjustment.import_committed' and entity_id = $2", [w.t1.id, id])).toHaveLength(1);
    await asUser(admin(), "select public.withdraw_adjustment_import($1)", [id]);
    expect(await recordCount(id)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Withdrawing, baselines, risk estimates
// ---------------------------------------------------------------------------
describe("withdrawing an import", () => {
  it("deletes its records and closes it; refused while a saved estimate still cites it; idempotent", async () => {
    const { id } = await validatedImport(2);
    await append(admin(), id, 1, rowsFrom(1, 2));
    await finalize(admin(), id);
    const estimate = (await asUser<{ id: string }>(admin(), "select public.save_risk_estimate($1, null, 'Based on March', $2::jsonb, $3::jsonb, '1.0.0') as id", [w.t1.id, JSON.stringify({ importIds: [id], forecastBasis: "declared_weights" }), JSON.stringify({ v: 1 })]))[0]!.id;
    await expectCode(asUser(admin(), "select public.withdraw_adjustment_import($1)", [id]), "P0001", /saved risk estimates are based on this import/);
    expect(await recordCount(id)).toBe(2);
    await asUser(admin(), "select public.archive_risk_estimate($1)", [estimate]);
    expect(await asUser(admin(), "select public.withdraw_adjustment_import($1) as r", [id])).toEqual([{ r: { importId: id, deleted: 2 } }]);
    expect(await recordCount(id)).toBe(0);
    expect(await statusOf(id)).toMatchObject({ status: "withdrawn" });
    expect(await asUser(admin(), "select public.withdraw_adjustment_import($1) as r", [id])).toEqual([{ r: { importId: id, deleted: 0 } }]);
    expect(await sql("select 1 from public.audit_events where action = 'adjustment.import_withdrawn' and entity_id = $1", [id])).toHaveLength(1);
    const pending = await validatedImport(1);
    await expectCode(asUser(admin(), "select public.withdraw_adjustment_import($1)", [pending.id]), "P0004", /only a committed import/);
    await asUser(admin(), "select public.discard_adjustment_import($1)", [pending.id]);
  });
});

describe("baselines: packages shipped in a window", () => {
  const save = (userId: string, o: { brand?: string | null; carrier?: string | null; service?: string | null; start?: string; end?: string; packages?: number; missing?: number | null; note?: string | null; id?: string | null } = {}) =>
    asUser<{ id: string }>(userId, "select public.save_adjustment_baseline($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) as id",
      [w.t1.id, o.brand === undefined ? null : o.brand, o.carrier ?? null, o.service ?? null, o.start ?? "2026-01-01", o.end ?? "2026-01-31", o.packages ?? 1000, o.missing === undefined ? null : o.missing, o.note ?? null, o.id ?? null]).then((r) => r[0]!.id);

  it("saves, edits and deletes; every refusal is a PC001, P0002, P0007 or 42501; audit rows carry counts only", async () => {
    const id = await save(admin(), { brand: w.brandA.id, carrier: "ups", service: f.upsGround, packages: 1000, missing: 40, note: "Typed from the WMS report" });
    const [row] = await sql<Record<string, unknown>>("select brand_id, carrier_code, service_id, period_start::text, period_end::text, packages_total, labels_missing_weight, note, created_by from public.adjustment_baselines where id = $1", [id]);
    expect(row).toEqual({ brand_id: w.brandA.id, carrier_code: "ups", service_id: f.upsGround, period_start: "2026-01-01", period_end: "2026-01-31", packages_total: 1000, labels_missing_weight: 40, note: "Typed from the WMS report", created_by: admin() });
    await save(admin(), { brand: w.brandA.id, id, packages: 1100, missing: 41, start: "2026-01-01", end: "2026-01-31", carrier: "ups", service: f.upsGround });
    expect(await sql("select packages_total, labels_missing_weight from public.adjustment_baselines where id = $1", [id])).toEqual([{ packages_total: 1100, labels_missing_weight: 41 }]);
    await expectCode(save(w.t1.employee.id), "42501", /not allowed/);
    await expectCode(save(w.brandA.admin.id), "42501", /not allowed/);
    await expectCode(save(admin(), { brand: w.brandC.id }), "P0002", /not found/);
    await expectCode(save(admin(), { carrier: "acme" }), "P0002", /not found/);
    await expectCode(save(admin(), { carrier: "fedex", service: f.upsGround }), "P0002", /not found/);
    await expectCode(save(admin(), { id: "00000000-0000-4000-8000-000000000000" }), "P0002", /not found/);
    await expectCode(save(admin(), { start: "2026-02-01", end: "2026-01-01" }), "PC001", /invalid period/);
    await expectCode(save(admin(), { packages: 0 }), "PC001", /at least 1/);
    await expectCode(save(admin(), { packages: 100, missing: 101 }), "PC001", /cannot exceed/);
    await expectCode(save(admin(), { packages: 100, missing: -1 }), "PC001", /cannot exceed/);
    await expectCode(save(admin(), { note: "n".repeat(1001) }), "PC001", /1000/);
    const audit = await sql<{ action: string; actor_id: string; metadata: Record<string, unknown> }>("select action, actor_id, metadata from public.audit_events where entity_id = $1 order by id", [id]);
    expect(audit.map((a) => a.action)).toEqual(["adjustment.baseline_saved", "adjustment.baseline_saved"]);
    expect(JSON.stringify(audit[0]!.metadata)).not.toContain("Typed from"); // the note is never copied; the count of packages is a count, not a figure
    expect(audit[0]!.metadata).toMatchObject({ carrier_code: "ups", period_start: "2026-01-01", packages: 1000 });
    await expectCode(asUser(w.t2.admin.id, "select public.delete_adjustment_baseline($1)", [id]), "P0002", /not found/);
    await expectCode(asUser(w.t1.employee.id, "select public.delete_adjustment_baseline($1)", [id]), "P0002", /not found/);
    await asUser(admin(), "select public.delete_adjustment_baseline($1)", [id]);
    expect(await sql("select 1 from public.adjustment_baselines where id = $1", [id])).toHaveLength(0);
    expect(await sql("select 1 from public.audit_events where action = 'adjustment.baseline_deleted' and entity_id = $1", [id])).toHaveLength(1);
  });

  it("baselines of one scope never overlap (the account-wide scope included); other scopes are independent", async () => {
    const wide = await save(admin(), { start: "2026-02-01", end: "2026-02-28", packages: 5000 });
    await expectCode(save(admin(), { start: "2026-02-15", end: "2026-03-15", packages: 1 }), "P0007", /overlaps another baseline/);
    await expectCode(save(admin(), { start: "2026-02-28", end: "2026-02-28", packages: 1 }), "P0007", /overlaps/);
    await save(admin(), { start: "2026-03-01", end: "2026-03-31", packages: 1 }); // adjacent
    await save(admin(), { brand: w.brandA.id, start: "2026-02-01", end: "2026-02-28", packages: 600 }); // another scope
    await save(admin(), { carrier: "ups", start: "2026-02-01", end: "2026-02-28", packages: 600 });
    await save(admin(), { carrier: "ups", service: f.upsGround, start: "2026-02-01", end: "2026-02-28", packages: 600 });
    await expectCode(save(admin(), { carrier: "ups", service: f.upsGround, start: "2026-02-10", end: "2026-02-12", packages: 1 }), "P0007", /overlaps/);
    // Editing a row never collides with itself.
    await save(admin(), { id: wide, start: "2026-02-01", end: "2026-02-28", packages: 5001 });
  });
});

describe("saved risk estimates", () => {
  const save = (userId: string, o: { brand?: string | null; inputs?: unknown; result?: unknown } = {}) =>
    asUser<{ id: string }>(userId, "select public.save_risk_estimate($1, $2, 'An estimate', $3::jsonb, $4::jsonb, '1.0.0') as id", [w.t1.id, o.brand ?? null, JSON.stringify(o.inputs ?? { forecastBasis: "declared_weights", volume: "10000" }), JSON.stringify(o.result ?? { v: 1 })]).then((r) => r[0]!.id);

  it("checks that the four buckets add up, that cited imports are the account's own and that the handling is today's", async () => {
    const buckets = (a: number, b: number, c: number, d: number, counted: number) => ({ v: 1, buckets: { customerPays: a, decidedCaseByCase: b, notBilledToCustomer: c, notDecided: d }, countedE4: counted });
    const id = await save(admin(), { result: buckets(1060_0000, 400_0000, 0, 0, 1460_0000) });
    expect(await sql("select name, engine_version, created_by from public.risk_estimates where id = $1", [id])).toEqual([{ name: "An estimate", engine_version: "1.0.0", created_by: admin() }]);
    await expectCode(save(admin(), { result: buckets(1060_0000, 400_0000, 0, 0, 1460_0001) }), "PC003", /do not add up/);
    await expectCode(save(admin(), { result: buckets(1, 2, 3, 4, 11) }), "PC003", /do not add up/);
    await expectCode(save(admin(), { result: { v: 1, buckets: { customerPays: 1.5, decidedCaseByCase: 0, notBilledToCustomer: 0, notDecided: 0 }, countedE4: 1 } }), "PC001", /whole number/);
    await expectCode(save(admin(), { result: { v: 1, buckets: { customerPays: -1, decidedCaseByCase: 0, notBilledToCustomer: 0, notDecided: 0 }, countedE4: -1 } }), "PC001", /whole number/);
    await expectCode(save(admin(), { result: { v: 1, buckets: { customerPays: 1 }, countedE4: 1 } }), "PC001", /whole number/);
    await expectCode(save(admin(), { inputs: { importIds: ["00000000-0000-4000-8000-000000000000"] } }), "P0002", /not found/);
    await expectCode(save(admin(), { inputs: { importIds: ["nope"] } }), "PC001", /invalid import list/);
    await expectCode(save(admin(), { inputs: { importIds: "x" } }), "PC001", /invalid import list/);
    // Another account's import cannot be cited.
    const foreignFile = await upload(w.t2.admin.id, csv(GOOD_HEADERS), { tenant: w.t2.id });
    const foreign = (await asUser<{ r: Created }>(w.t2.admin.id, "select public.create_adjustment_import($1, 'theirs', '{}') as r", [foreignFile]))[0]!.r;
    await expectCode(save(admin(), { inputs: { importIds: [foreign.importId] } }), "P0002", /not found/);
    // The handling the engine reports must be what today's decision resolves to.
    await asUser(admin(), "select public.set_adjustment_policy($1, null, 'combined', 'separate_fee', 'pass_through')", [w.t1.id]).catch(() => undefined);
    const resolved = (await sql<{ h: string }>("select app.adjustment_handling($1, null, 'combined', 'separate_fee', current_date) as h", [w.t1.id]))[0]!.h;
    expect(resolved).toBe("pass_through");
    await save(admin(), { inputs: { adjustmentType: "combined" }, result: { v: 1, handling: { separate_fee: "pass_through" } } });
    await expectCode(save(admin(), { inputs: { adjustmentType: "combined" }, result: { v: 1, handling: { separate_fee: "absorbed" } } }), "PC003", /policy changed/);
    // Nothing decides combined shipping-charge differences yet, so "pass_through" there is not today's resolution (and "unconfigured" is).
    await expectCode(save(admin(), { inputs: { adjustmentType: "combined" }, result: { v: 1, handling: { postage_difference: "pass_through", separate_fee: "pass_through" } } }), "PC003", /policy changed/);
    await save(admin(), { inputs: { adjustmentType: "combined" }, result: { v: 1, handling: { postage_difference: "unconfigured", separate_fee: "pass_through" } } });
    await expectCode(save(admin(), { inputs: { adjustmentType: "reweight" }, result: { v: 1, handling: { nonsense: "pass_through" } } }), "PC003", /policy changed/);
    await expectCode(save(w.t1.employee.id), "42501", /not allowed/);
    await expectCode(save(admin(), { brand: w.brandC.id }), "P0002", /not found/);
    await expectCode(asUser(admin(), "select public.save_risk_estimate($1, null, '', '{}', '{}', '1.0.0')", [w.t1.id]), "PC001", /invalid estimate/);
    await expectCode(asUser(admin(), "select public.save_risk_estimate($1, null, 'x', '[]', '{}', '1.0.0')", [w.t1.id]), "PC001", /missing or too large/);
    await expectCode(asUser(w.t2.admin.id, "select public.archive_risk_estimate($1)", [id]), "P0002", /not found/);
    await asUser(admin(), "select public.archive_risk_estimate($1)", [id]);
    await asUser(admin(), "select public.archive_risk_estimate($1)", [id]);
    await expectCode(asOwnerWithGuardOpen("update public.risk_estimates set result = '{}' where id = $1", [id]), "42501", /only archiving/);
    expect(await sql("select 1 from public.audit_events where action = 'adjustment.estimate_saved' and entity_id = $1", [id])).toHaveLength(1);
    // Records only the account's staff can read; a customer reads no estimate, however it was saved.
    for (const user of [w.brandA.admin, w.brandB.admin, w.t1.employee, w.outsider]) expect(await asUser(user.id, "select id from public.risk_estimates where id = $1", [id]), user.email).toHaveLength(0);
    await expectDenied(asUser(w.brandA.admin.id, "update public.risk_estimates set archived_at = now()"), /permission denied/);
  });
});

// ---------------------------------------------------------------------------
// Raw history files: refused before they are stored, bounded per account, never orphaned
// ---------------------------------------------------------------------------
describe("raw history files: the insert guard, the per-account bound and discarding an orphan", () => {
  interface Refusal { code?: string; hint?: string; detail?: string; message?: string }
  const refusal = async (content: Buffer, over: { filename?: string; mime?: string; by?: string; tenant?: string } = {}) =>
    (await upload(over.by ?? admin(), content, { filename: over.filename, mime: over.mime, tenant: over.tenant }).then(() => null, (e: Refusal) => e)) as Refusal | null;
  const unattached = async (tenant = w.t1.id) =>
    Number((await sql<{ n: string }>("select count(*)::text as n from public.uploaded_files f where f.tenant_id = $1 and f.purpose = 'adjustment_import' and not exists (select 1 from public.adjustment_imports i where i.file_id = f.id)", [tenant]))[0]!.n);
  const clearUnattached = (tenant = w.t1.id) =>
    sql("delete from public.uploaded_files f where f.tenant_id = $1 and f.purpose = 'adjustment_import' and not exists (select 1 from public.adjustment_imports i where i.file_id = f.id)", [tenant]);
  const preamble = (n: number) => Array.from({ length: n }, (_, i) => `Weekly report line ${i + 1},Run 7,Acme Logistics`);
  const COST_HEADER = "ship_date,carrier,adjustment_type,Net Charge,Carrier Cost";
  const dataRow = "2026-09-01,UPS,reweight,12.00,9.10";

  it("reads the first fifty lines wherever the header sits: a title row, a header under a title block, other delimiters and line endings (F2)", async () => {
    const file = (lines: string[], eol = "\n") => Buffer.from(lines.join(eol) + eol);
    // The reported header is the first flagged cell of the first line that can be a header.
    expect(await refusal(file(["Acme Logistics,Weekly report,Run 7", COST_HEADER, dataRow]))).toMatchObject({ code: "P0001", hint: "forbidden_header", detail: "Net Charge" });
    expect(await refusal(file([...preamble(12), COST_HEADER, dataRow]))).toMatchObject({ hint: "forbidden_header", detail: "Net Charge" });
    expect(await refusal(file([...preamble(48), "ship_date,carrier,adjustment_type,Carrier Cost"]))).toMatchObject({ hint: "forbidden_header", detail: "Carrier Cost" }); // line 49
    expect(await refusal(file([...preamble(49), "ship_date,carrier,adjustment_type,Carrier Cost"]))).toMatchObject({ hint: "forbidden_header", detail: "Carrier Cost" }); // line 50
    // Line 51 is outside what the database reads (the TypeScript guard fails closed when no header is found in the first rows).
    expect(await refusal(file([...preamble(50), "ship_date,carrier,adjustment_type,Carrier Cost"]))).toBeNull();
    // Other delimiters, quoting, CRLF and bare CR, a byte order mark, blank lines (which are not counted toward the fifty).
    expect(await refusal(file(["ship_date;carrier;adjustment_type;Carrier Cost"]))).toMatchObject({ hint: "forbidden_header" });
    expect(await refusal(file(["ship_date\tcarrier\tadjustment_type\tCarrier Cost"]))).toMatchObject({ hint: "forbidden_header" });
    expect(await refusal(file(['"ship_date","carrier","adjustment_type","Carrier Cost"']))).toMatchObject({ hint: "forbidden_header", detail: "Carrier Cost" });
    expect(await refusal(file([...preamble(2), COST_HEADER], "\r\n"))).toMatchObject({ hint: "forbidden_header" });
    expect(await refusal(file([...preamble(2), COST_HEADER], "\r"))).toMatchObject({ hint: "forbidden_header" });
    expect(await refusal(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), file(["Postage Cost,ship_date,carrier"])]))).toMatchObject({ hint: "forbidden_header", detail: "Postage Cost" });
    expect(await refusal(file([...Array.from({ length: 30 }, () => ""), ...preamble(3), COST_HEADER]))).toMatchObject({ hint: "forbidden_header" });
    // Clean files pass: the template header, a title row above it, and the same file as a .txt.
    const clean = ["ship_date,carrier,adjustment_type,customer_charge_original", dataRow];
    expect(await refusal(file(clean))).toBeNull();
    expect(await refusal(file(["Acme Logistics,Weekly report,Run 7", ...clean]))).toBeNull();
    expect(await refusal(file(clean), { filename: "history.txt", mime: "text/plain" })).toBeNull();
    await clearUnattached();
  });

  it("does not read data rows as headers: a service named 'USPS Priority Mail Flat Rate' or a reason 'Carrier adjustment' never refuses a file", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => `2026-09-${String(1 + (i % 28)).padStart(2, "0")},UPS,reweight,Carrier adjustment,USPS Priority Mail Flat Rate,1Z00${i},${3 + i},12.50`);
    expect(await refusal(Buffer.from(["ship_date,carrier,adjustment_type,reason,service,package_ref,declared_weight,customer_charge_original", ...rows].join("\n")))).toBeNull();
    // A text-only row with three or more cells could be a header, and is read like one (a documented, conservative case).
    expect(await refusal(Buffer.from(["ship_date,carrier,adjustment_type", "Label reprint,USPS Flat Rate Box,Carrier adjustment"].join("\n")))).toMatchObject({ hint: "forbidden_header" });
    await clearUnattached();
  });

  it("refuses UTF-16 and NUL-bearing text as unreadable (reason unsupported_encoding), reads Latin-1, and leaves binary files to the declared headers (F3)", async () => {
    const text = "ship_date,carrier,adjustment_type,Carrier Cost\n2026-09-01,UPS,reweight,9.10\n";
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]);
    for (const [label, bytes] of [["UTF-16LE with a byte order mark", le], ["UTF-16BE with a byte order mark", be], ["UTF-16LE without one", Buffer.from(text, "utf16le")], ["a NUL byte in a CSV", Buffer.from("ship_date,carrier\n2026-09-01,ups\u0000\n")]] as const) {
      expect(await refusal(bytes), label).toMatchObject({ code: "P0001", hint: "unsupported_encoding", message: "this file was not saved" });
      expect(await refusal(bytes, { filename: "x.txt", mime: "text/plain" }), `${label} (.txt)`).toMatchObject({ hint: "unsupported_encoding" });
    }
    // Latin-1 text (a windows-1252 e-acute) is read without raising, and so is UTF-8 with a multi-byte character.
    expect(await refusal(Buffer.from("ship_date,carrier,package_ref,reason\n2026-09-01,ups,A1,caf\xe9\n", "latin1"))).toBeNull();
    expect(await refusal(Buffer.from("ship_date,carrier,package_ref,reason\n2026-09-01,ups,A1,café 东\n", "utf8"))).toBeNull();
    expect(await refusal(Buffer.from("ship_date,carrier\n2026-09-01,ups\n" + "x".repeat(70_000)))).toBeNull(); // only the first 64 KB are read
    // A workbook is binary (it has NUL bytes): it is not read here, so only the headers the caller declares are tested.
    expect(await refusal(Buffer.from("PK\u0003\u0004\u0000\u0000 binary"), { filename: "history.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })).toBeNull();
    // A file that bypassed the insert guard and holds UTF-16 is answered, not raised on, and deleted: no orphan.
    const bypass = await ownerFile(le);
    expect(await createImport(admin(), bypass, "utf16", { headers: [] })).toEqual({ ok: false, reason: "unsupported_encoding" });
    expect(await fileExists(bypass)).toBe(false);
    const bypass2 = await ownerFile(Buffer.from("ship_date,carrier\n2026-09-01,ups\u0000\n"));
    expect(await createImport(admin(), bypass2, "nul", { headers: [] })).toEqual({ ok: false, reason: "unsupported_encoding" });
    expect(await fileExists(bypass2)).toBe(false);
    await clearUnattached();
  });

  it("an account holds at most five files that no import refers to; attached files and other purposes and accounts do not count (DB-2)", async () => {
    await clearUnattached();
    const made: string[] = [];
    for (let i = 0; i < 5; i++) made.push(await upload(admin(), csv(GOOD_HEADERS), { filename: `waiting${i}.csv` }));
    expect(await unattached()).toBe(5);
    expect(await refusal(csv(GOOD_HEADERS))).toMatchObject({ code: "P0001", hint: "too_many_unattached_files", message: expect.stringMatching(/too many uploaded files are waiting/) });
    // Another purpose and another account are not counted.
    await upload(admin(), csv(GOOD_HEADERS), { purpose: "rate_card" });
    expect(await refusal(csv(GOOD_HEADERS), { by: w.t2.admin.id, tenant: w.t2.id })).toBeNull();
    // An import takes a file out of the count; discarding an unattached file frees a slot.
    const { importId } = await createImport(admin(), made[0]!, "attached");
    expect(await unattached()).toBe(4);
    expect(await refusal(csv(GOOD_HEADERS))).toBeNull();
    expect(await refusal(csv(GOOD_HEADERS))).toMatchObject({ hint: "too_many_unattached_files" });
    await asUser(admin(), "select public.discard_unattached_adjustment_file($1)", [made[1]!]);
    expect(await refusal(csv(GOOD_HEADERS))).toBeNull();
    // The bound on raw files: five unattached plus the five imports in progress; the files of imports that end are deleted.
    await asUser(admin(), "select public.discard_adjustment_import($1)", [importId]);
    expect(await fileExists(made[0]!)).toBe(false);
    await clearUnattached();
    await clearUnattached(w.t2.id);
  });

  it("discard_unattached_adjustment_file removes an orphan after a failed registration; every other case is the same 'not found'", async () => {
    await clearUnattached();
    // The failure the server action must clean up after: the registration is refused for its name, and the file stays behind.
    const orphan = await upload(admin(), csv(GOOD_HEADERS));
    await expectCode(createImport(admin(), orphan, "   "), "PC001", /name must be/);
    expect(await fileExists(orphan)).toBe(true);
    expect(await unattached()).toBe(1);
    // Nobody else can touch it, and nothing distinguishes that from a file that never existed.
    for (const user of [w.t1.employee, w.brandA.admin, w.brandA.employee, w.brandB.admin, w.t2.admin, w.outsider, w.platformAdmin]) {
      await expectCode(asUser(user.id, "select public.discard_unattached_adjustment_file($1)", [orphan]), "P0002", /^not found$/);
    }
    await expectCode(asUser(admin(), "select public.discard_unattached_adjustment_file($1)", ["00000000-0000-4000-8000-000000000000"]), "P0002", /^not found$/);
    await expectCode(asUser(null, "select public.discard_unattached_adjustment_file($1)", [orphan]), "42501", /permission denied/);
    // A file of another purpose and a file an import holds are not its business either.
    const rateCardFile = await upload(admin(), csv(GOOD_HEADERS), { purpose: "rate_card" });
    await expectCode(asUser(admin(), "select public.discard_unattached_adjustment_file($1)", [rateCardFile]), "P0002", /^not found$/);
    const held = await upload(admin(), csv(GOOD_HEADERS));
    const { importId } = await createImport(admin(), held, "held");
    await expectCode(asUser(admin(), "select public.discard_unattached_adjustment_file($1)", [held]), "P0002", /^not found$/);
    expect(await fileExists(held)).toBe(true);
    await asUser(admin(), "select public.discard_adjustment_import($1)", [importId]);
    // The owner of the account removes the orphan; asking again is "not found" (it is gone). Callers have no other way to delete a file.
    await expectDenied(asUser(admin(), "delete from public.uploaded_files where id = $1", [orphan]), /permission denied/);
    await asUser(admin(), "select public.discard_unattached_adjustment_file($1)", [orphan]);
    expect(await fileExists(orphan)).toBe(false);
    await expectCode(asUser(admin(), "select public.discard_unattached_adjustment_file($1)", [orphan]), "P0002", /^not found$/);
    expect(await sql("select 1 from public.uploaded_files where id = $1", [rateCardFile])).toHaveLength(1);
  });

  it("registering a file that is being discarded at the same moment answers 'not found', never a foreign-key error", async () => {
    await clearUnattached();
    const file = await upload(admin(), csv(GOOD_HEADERS));
    let registering: Promise<unknown> | undefined;
    await withTx(admin(), async (q) => {
      await q("select public.discard_unattached_adjustment_file($1)", [file]); // holds the account's lock until this transaction ends
      registering = createImport(admin(), file, "late").then(() => "registered", (e: { code?: string; message?: string }) => `${e.code}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(await registering).toBe("P0002: not found");
    expect(await fileExists(file)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The validation report, sample rows, estimate ids, package references
// ---------------------------------------------------------------------------
describe("what an import stores about its file", () => {
  const importWith = async (detected: unknown) => {
    const file = await upload(admin(), csv(GOOD_HEADERS));
    const created = await createImport(admin(), file, "stored text", detected);
    expect(created.ok).toBe(true);
    return { id: created.importId!, file };
  };
  const stored = async (id: string) => (await sql<{ status: string; detected: Record<string, unknown>; validation: Record<string, unknown> | null }>("select status, detected, validation from public.adjustment_imports where id = $1", [id]))[0]!;
  const NUL = String.fromCharCode(92) + "u0000";

  it("cuts long header and customer text out of the validation report before judging its size, so a good file can always be validated (F9)", async () => {
    const { id } = await importWith({ headers: GOOD_HEADERS });
    const ignoredColumns = Array.from({ length: 200 }, (_, i) => ({ index: i + 3, header: `${String.fromCharCode(97 + (i % 26))}`.repeat(120), moneyLike: i % 2 === 0 }));
    const customers = Array.from({ length: 80 }, (_, i) => ({ text: "c".repeat(300), rows: i + 1, brandId: null }));
    const report = { counts: { rows: 10, accepted: 9, errorRows: 0 }, byCode: { x: 1 }, shipDateRange: { min: "2026-01-01", max: "2026-01-31" }, ignoredColumns, customers, notice: "n" };
    expect(JSON.stringify(report).length).toBeGreaterThan(32_768);
    expect(await setMapping(admin(), id, MAPPING, report, true)).toBe("validated");
    const { validation } = await stored(id);
    const v = validation as { counts: Record<string, number>; ignoredColumns: { index: number; header: string; moneyLike: boolean }[]; customers: { text: string; rows: number }[]; byCode: unknown; shipDateRange: unknown; notice: string };
    expect(v.counts).toEqual({ rows: 10, accepted: 9, errorRows: 0 });
    expect(v.ignoredColumns).toHaveLength(50);
    expect(v.ignoredColumns.every((c) => c.header.length === 80)).toBe(true);
    expect(v.ignoredColumns[0]).toEqual({ index: 3, header: "a".repeat(80), moneyLike: true }); // order and the other fields are kept
    expect(v.customers).toHaveLength(50);
    expect(v.customers.every((c) => c.text.length === 120)).toBe(true);
    expect(v.byCode).toEqual({ x: 1 });
    expect(v.shipDateRange).toEqual({ min: "2026-01-01", max: "2026-01-31" });
    const [{ s }] = (await sql<{ s: string }>("select pg_column_size(validation)::text as s from public.adjustment_imports where id = $1", [id])) as [{ s: string }];
    expect(Number(s)).toBeLessThan(32_768);
    // Two 60,000-character headers (the review's file) validate too.
    const huge = { counts: { rows: 3, accepted: 3 }, ignoredColumns: [{ index: 3, header: "x".repeat(60_000) }, { index: 4, header: "y".repeat(60_000) }] };
    expect(await setMapping(admin(), id, MAPPING, huge, true)).toBe("validated");
    expect(((await stored(id)).validation as { ignoredColumns: { header: string }[] }).ignoredColumns.map((c) => c.header.length)).toEqual([80, 80]);
    // What is still too large after the cut, or absurdly large before it, is a clean PC001.
    await expectCode(setMapping(admin(), id, MAPPING, { counts: { rows: 3, accepted: 3 }, padding: "z".repeat(40_000) }, true), "PC001", /validation report is too large/);
    await expectCode(setMapping(admin(), id, MAPPING, { counts: { rows: 3, accepted: 3 }, padding: "z".repeat(1_100_000) }, true), "PC001", /validation report is too large/);
    await expectCode(setMapping(admin(), id, MAPPING, ["x"], true), "PC001", /validation report is too large/);
    // A NUL cannot be stored in jsonb at all: PostgreSQL refuses it when the argument is converted, before any function runs (22P05),
    // so the TypeScript layer strips it first (cleanText). This pins the behaviour the action maps to a plain message.
    const err = await asUser(admin(), "select public.set_adjustment_import_mapping($1, $2::jsonb, $3::jsonb, 'refuse', true)", [id, JSON.stringify(MAPPING), JSON.stringify({ counts: { rows: 1, accepted: 1 }, ignoredColumns: [{ header: "bad@@NUL@@name" }] }).replace("@@NUL@@", NUL)]).then(() => null, (e: { code?: string }) => e);
    expect(err?.code).toBe("22P05");
    await asUser(admin(), "select public.discard_adjustment_import($1)", [id]);
  });

  it("discarding or withdrawing an import also removes what its file showed: sample rows, issue examples, customer names; committing drops the sample rows (DB-8)", async () => {
    const samples = [{ ship_date: "2026-01-01", package_ref: "1Z-PERSONAL-REF-123" }];
    const report = { counts: { rows: 3, accepted: 3 }, issues: [{ row: 2, code: "invalid_date", message: "row 2 has an invalid date" }], customers: [{ text: "Jane Doe Outfitters", rows: 3, brandId: null }], rowNumbers: { invalid_date: [2] }, byCode: { invalid_date: 1 } };
    // Discard (before commit).
    const a = await importWith({ headers: GOOD_HEADERS, sampleRows: samples });
    await setMapping(admin(), a.id, MAPPING, report, true);
    expect(JSON.stringify(await stored(a.id))).toContain("1Z-PERSONAL-REF-123");
    await asUser(admin(), "select public.discard_adjustment_import($1)", [a.id]);
    const afterDiscard = await stored(a.id);
    expect(afterDiscard.status).toBe("discarded");
    expect(afterDiscard.detected).toEqual({ headers: GOOD_HEADERS });
    expect(afterDiscard.validation).toEqual({ counts: { rows: 3, accepted: 3 }, byCode: { invalid_date: 1 } });
    expect(JSON.stringify(afterDiscard)).not.toMatch(/1Z-PERSONAL|Jane Doe|invalid date/);
    // Commit drops the sample rows (the records are the data now); withdraw drops the examples that remained.
    const b = await importWith({ headers: GOOD_HEADERS, sampleRows: samples });
    await setMapping(admin(), b.id, MAPPING, { ...report, counts: { rows: 1, accepted: 1 } }, true);
    await append(admin(), b.id, 1, rowsFrom(900, 1));
    await finalize(admin(), b.id);
    const committed = await stored(b.id);
    expect(committed.detected).toEqual({ headers: GOOD_HEADERS });
    expect(JSON.stringify(committed.validation)).toContain("Jane Doe"); // the report of a committed import is still the 3PL's record
    // Withdraw does not rely on the commit having cleaned the details: put sample rows back as the owner (no function can), then withdraw.
    await asOwnerWithoutTriggers("update public.adjustment_imports set detected = detected || $2::jsonb where id = $1", [b.id, JSON.stringify({ sampleRows: samples })]);
    expect(JSON.stringify(await stored(b.id))).toContain("1Z-PERSONAL-REF-123");
    await asUser(admin(), "select public.withdraw_adjustment_import($1)", [b.id]);
    const withdrawn = await stored(b.id);
    expect(withdrawn.status).toBe("withdrawn");
    expect(withdrawn.detected).toEqual({ headers: GOOD_HEADERS });
    expect(withdrawn.validation).toEqual({ counts: { rows: 1, accepted: 1 }, byCode: { invalid_date: 1 } });
    expect(JSON.stringify(withdrawn)).not.toMatch(/1Z-PERSONAL|Jane Doe|invalid date/);
  });

  it("a saved estimate cites its imports as sorted, distinct, lower-case ids, whatever the spelling it was sent with; withdraw honours every spelling (DB-9)", async () => {
    const { id } = await validatedImport(1);
    await append(admin(), id, 1, rowsFrom(910, 1));
    await finalize(admin(), id);
    const upper = id.toUpperCase();
    const estimate = (await asUser<{ id: string }>(admin(), "select public.save_risk_estimate($1, null, 'Upper-case id', $2::jsonb, $3::jsonb, '1.0.0') as id", [w.t1.id, JSON.stringify({ importIds: [upper, id, upper] }), JSON.stringify({ v: 1 })]))[0]!.id;
    expect((await sql<{ ids: string[] }>("select inputs -> 'importIds' as ids from public.risk_estimates where id = $1", [estimate]))[0]!.ids).toEqual([id]);
    await expectCode(asUser(admin(), "select public.withdraw_adjustment_import($1)", [id]), "P0001", /saved risk estimates are based on this import/);
    // Even an estimate row written with the upper-case spelling (by the owner) blocks the withdrawal: the comparison is lower-cased too.
    await asUser(admin(), "select public.archive_risk_estimate($1)", [estimate]);
    await asOwnerWithGuardOpen("insert into public.risk_estimates (tenant_id, name, inputs, result, engine_version) values ($1, 'legacy upper', $2::jsonb, '{}', '1.0.0')", [w.t1.id, JSON.stringify({ importIds: [upper] })]);
    await expectCode(asUser(admin(), "select public.withdraw_adjustment_import($1)", [id]), "P0001", /saved risk estimates are based on this import/);
    await sql("update public.risk_estimates set archived_at = now() where tenant_id = $1 and name = 'legacy upper'", [w.t1.id]).catch(() => undefined);
    await asOwnerWithGuardOpen("update public.risk_estimates set archived_at = now() where tenant_id = $1 and name = 'legacy upper'", [w.t1.id]);
    await asUser(admin(), "select public.withdraw_adjustment_import($1)", [id]);
  });

  it("package references are stored in one canonical form: 'x', 'X' and ' X' are one package; invisible characters and fullwidth letters fold; bad ones are refused (F12)", async () => {
    const one = await validatedImport(4);
    const ref = (r: string | null, i: number, over: Record<string, unknown> = {}) => baseRow(i, { package_ref: r, ...over });
    // Three spellings in one chunk are one package.
    await expectCode(append(admin(), one.id, 1, [ref("X", 1), ref("x", 2)]), "PC001", /^row 2: duplicate_package$/);
    await expectCode(append(admin(), one.id, 1, [ref("X", 1), ref(" X", 2)]), "PC001", /^row 2: duplicate_package$/);
    await expectCode(append(admin(), one.id, 1, [ref("1Z0001AB", 1), ref("1z0001 ab\u{200b}", 2)].map((r) => r)), "PC001", /^row 2: duplicate_package$/);
    // The stored form is canonical.
    expect(await append(admin(), one.id, 1, [
      ref(` 1z 0001-ab${String.fromCodePoint(0x200b)}`, 1),
      ref("\u{ff21}\u{ff22}\u{ff11}\u{ff12}", 2), // fullwidth ab12 in capitals
      ref("9400 1118\t9922", 3),
      ref(`${String.fromCodePoint(0xfeff)}q${String.fromCodePoint(0xad)}r`, 4),
    ])).toMatchObject({ inserted: 4 });
    expect((await sql<{ r: string }>("select string_agg(package_ref, ',' order by row_no) as r from public.adjustment_records where import_id = $1", [one.id]))[0]!.r).toBe("1Z0001-AB,AB12,940011189922,QR");
    expect(await finalize(admin(), one.id)).toMatchObject({ committed: 4, skipped: 0 });
    // A later file with the same packages spelled differently is skipped and counted, never stored twice.
    const two = await validatedImport(3);
    expect(await append(admin(), two.id, 1, [ref("1z0001-ab", 1), ref("ab 12", 2), ref("new-ref", 3)])).toMatchObject({ applied: true, inserted: 1, skipped: 2 });
    expect(await finalize(admin(), two.id)).toMatchObject({ committed: 1, skipped: 2 });
    // The same reference as another carrier, type or customer is another package.
    const three = await validatedImport(3);
    expect(await append(admin(), three.id, 1, [ref("1z0001ab", 1, { carrier_code: "usps", service_id: null }), ref("1z0001ab", 2, { adjustment_type: "remeasure" }), ref("1z0001ab", 3, { brand_id: null })])).toMatchObject({ inserted: 3, skipped: 0 });
    await asUser(admin(), "select public.discard_adjustment_import($1)", [three.id]);
    // Refused: replacement characters, nothing left after whitespace and invisible characters, over-long raw text, text that grows past the column when normalised.
    const four = await validatedImport(1);
    const bad: [string, string][] = [
      ["invalid_package_ref", `AB${String.fromCharCode(0xfffd)}CD`],
      ["invalid_package_ref", "   "],
      ["invalid_package_ref", String.fromCodePoint(0x200b)],
      ["invalid_package_ref", "a".repeat(121)],
      ["invalid_package_ref", "\u{fdfa}".repeat(10)], // ten characters that normalise to 180
    ];
    for (const [code, value] of bad) expect(((await append(admin(), four.id, 1, [ref(value, 1)]).catch((e) => e)) as { message?: string }).message, JSON.stringify(value)).toBe(`row 1: ${code}`);
    await asUser(admin(), "select public.discard_adjustment_import($1)", [four.id]);
    // The column itself only ever holds the canonical form (even for the owner).
    const imp = await validatedImport(1);
    await expectCode(
      asOwnerWithGuardOpen("insert into public.adjustment_records (tenant_id, import_id, row_no, ship_date, carrier_code, adjustment_type, cause, declared_weight_basis, package_ref) values ($1, $2, 99, '2026-01-01', 'ups', 'reweight', 'other', 'missing', 'not canonical')", [w.t1.id, imp.id]),
      "23514", /adjustment_records_package_ref_canonical/,
    );
    await asUser(admin(), "select public.discard_adjustment_import($1)", [imp.id]);
    for (const x of [one.id, two.id]) await asUser(admin(), "select public.withdraw_adjustment_import($1)", [x]);
  });
});
