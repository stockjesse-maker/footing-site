import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ADJUSTMENT_TEMPLATE_HEADERS, guardHeader, normalizeGuardHeader } from "@/lib/adjustments/header-guard";
import { buildDetected, detectAdjustmentFile, toStoredMapping } from "@/lib/adjustments/mapping";
import { parseAdjustmentFile } from "@/lib/adjustments/parse";
import { buildAppendChunks, reconcileCommit, type AppendResult } from "@/lib/adjustments/payload";
import type { AdjustmentContext } from "@/lib/adjustments/types";
import { applyAdjustmentMapping, toStoredValidation } from "@/lib/adjustments/validate";
import { asUser, sql } from "./harness";
import { buildWorld, type World } from "./world";

/**
 * Header guard parity (Milestone 5, amendment A4). The TypeScript guard (src/lib/adjustments/header-guard.ts) runs before a file is
 * stored; the SQL function app.adjustment_header_forbidden is the backstop that create_adjustment_import and
 * set_adjustment_import_mapping apply to the stored header names. They must agree where it matters:
 *   * the backstop never refuses a header the TypeScript guard accepts (so a file that passed the guard is never refused after
 *     it was stored, and no accepted template header is refused);
 *   * the backstop refuses every header the TypeScript guard refuses, EXCEPT a pinned list where it is deliberately looser
 *     (it is a regex over whole words: "Carrier Name" has the word carrier but no money word; the TypeScript guard also splits
 *     camelCase, refuses some plurals and unseparated long stems). Each difference is pinned below so drift on either side fails.
 */

interface GuardCase { header: string; guard: "pass" | "refuse"; autoMapsToMoney: boolean }
const table = JSON.parse(readFileSync(path.resolve(__dirname, "../fixtures/adjustments/header-guard.json"), "utf8")) as { templateHeaders: string[]; cases: GuardCase[] };

async function sqlRefuses(headers: string[]): Promise<Map<string, boolean>> {
  const rows = await sql<{ h: string; r: boolean }>("select h, app.adjustment_header_forbidden(h) as r from unnest($1::text[]) as h", [headers]);
  return new Map(rows.map((r) => [r.h, r.r]));
}

const tsRefuses = (h: string) => !guardHeader(h).allowed;

/** Headers the TypeScript guard refuses beyond the fixture table: camelCase, plurals, unseparated long stems, "invoiced". */
const PROBES = [
  "CarrierCost", "PostageCost", "UPSCost", "BuyRate", "WholesalePrice", "NegotiatedRate", "NegotiatedRate2", "postagecost", "invoicenumber",
  "Costs", "Rates", "Labels", "Nets", "Buys", "Invoices", "Postages", "Carriers", "Invoiced", "invoiced_amount", "Carrier", "carrier", "CARRIER",
  "Carrier Name", "Carrier Service", "carrier_code", "Carrier ID", "Carrier Charge to Customer", "Carrier Adjustment", "carrier.fee",
  "Customer Charge", "Charged to Customer", "Billed to Customer", "Customer Adjustment Fee", "Corrected Weight (lb)", "Tracking", "Service Level", "Reweigh Reason",
  "Separate Fee Note", "Generated On", "Internet Order", "Buyer Name", "Costume", "Ratey", "", "   ", "Ship Date", "ship date", "SHIP_DATE",
];

describe("the SQL backstop against the TypeScript header guard", () => {
  it("never refuses a header the TypeScript guard accepts: the 71 fixture headers, the probe list and 600 seeded combinations", async () => {
    const vocabulary = ["ship", "date", "carrier", "service", "customer", "brand", "charge", "charged", "to", "billed", "fee", "adjustment", "amount", "total", "price", "original", "corrected", "weight", "net", "gross",
      "cost", "rate", "postage", "label", "wholesale", "negotiated", "paid", "invoice", "invoiced", "buy", "buyer", "tracking", "number", "ref", "reason", "cause", "notes", "sku", "order", "zip", "separate", "internet", "unit"];
    let seed = 20261016;
    const next = (n: number) => (seed = (seed * 1664525 + 1013904223) % 4294967296) % n;
    const separators = [" ", "_", "-", ".", "  ", " / "];
    const random = Array.from({ length: 600 }, () => {
      const words = Array.from({ length: 1 + next(4) }, () => vocabulary[next(vocabulary.length)]!);
      const sep = separators[next(separators.length)]!;
      const text = words.join(sep);
      return next(3) === 0 ? text.toUpperCase() : next(3) === 0 ? text.replace(/(^|[ _.-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase()) : text;
    });
    const all = [...new Set([...table.cases.map((c) => c.header), ...PROBES, ...random])];
    const sqlSays = await sqlRefuses(all);
    const sqlOnly = all.filter((h) => sqlSays.get(h) === true && !tsRefuses(h));
    expect(sqlOnly, `refused by SQL but accepted by the TypeScript guard: ${JSON.stringify(sqlOnly)}`).toEqual([]);
  });

  it("every one of the 71 fixture headers: the SQL backstop refuses everything the TypeScript guard refuses, except the one pinned looser case", async () => {
    expect(table.cases).toHaveLength(71);
    const sqlSays = await sqlRefuses(table.cases.map((c) => c.header));
    const tsRefused = table.cases.filter((c) => tsRefuses(c.header)).map((c) => c.header);
    expect(tsRefused).toHaveLength(26);
    // The TypeScript guard agrees with the fixture on all 71 (the unit test pins the table; this keeps the two layers on the same footing).
    expect(table.cases.filter((c) => tsRefuses(c.header) !== (c.guard === "refuse"))).toEqual([]);
    const looser = tsRefused.filter((h) => sqlSays.get(h) === false);
    expect(looser).toEqual(["Carrier Name"]);
    // Why: the backstop refuses "carrier" only beside a money word, and "Carrier Name" has none.
    for (const h of looser) {
      const words = normalizeGuardHeader(h).split(" ");
      expect(words).toContain("carrier");
      expect(words.some((w) => ["charge", "charges", "cost", "bill", "billed", "billing", "fee", "fees", "adjustment", "adjustments", "amount", "invoice", "rate", "rates"].includes(w))).toBe(false);
    }
    // And the SQL side refuses the other 25 for the same stems.
    expect(tsRefused.filter((h) => sqlSays.get(h) === true)).toHaveLength(25);
    // Headers the TypeScript guard accepts are accepted by the backstop too (45 of them).
    const accepted = table.cases.filter((c) => c.guard === "pass").map((c) => c.header);
    expect(accepted).toHaveLength(45);
    expect(accepted.filter((h) => sqlSays.get(h) === true)).toEqual([]);
  });

  it("accepts every template header, so the mapping and detected headers of a template file are never refused after they were stored", async () => {
    const sqlSays = await sqlRefuses([...ADJUSTMENT_TEMPLATE_HEADERS]);
    expect([...sqlSays.values()].filter(Boolean)).toEqual([]);
    expect(sqlSays.size).toBe(23);
    expect(table.templateHeaders).toEqual([...ADJUSTMENT_TEMPLATE_HEADERS]);
  });

  it("pins every difference beyond the table, in both directions, so drift on either side fails this test", async () => {
    const sqlSays = await sqlRefuses(PROBES);
    const tsOnly = PROBES.filter((h) => tsRefuses(h) && sqlSays.get(h) === false).sort();
    const sqlOnly = PROBES.filter((h) => !tsRefuses(h) && sqlSays.get(h) === true);
    // The backstop is looser: the word "carrier" with no money word, camelCase and unseparated words, and a few plurals it does not list.
    expect(tsOnly).toEqual([
      "Buys", "BuyRate", "Carrier Charge to Customer", "Carrier ID", "Carrier Name", "Carrier Service", "CarrierCost", "Carriers", "Invoices", "Nets", "NegotiatedRate", "NegotiatedRate2", "Postages", "PostageCost", "UPSCost",
      "WholesalePrice", "carrier_code", "invoicenumber", "postagecost",
    ].sort());
    expect(sqlOnly).toEqual([]);
    // Both agree on these.
    for (const h of ["Carrier", "carrier", "CARRIER", "Customer Charge", "Charged to Customer", "Billed to Customer", "Customer Adjustment Fee", "Corrected Weight (lb)", "Tracking", "Service Level", "Reweigh Reason", "Separate Fee Note", "Generated On", "Internet Order", "Buyer Name", "Costume", "Ratey", "", "   ", "Ship Date", "ship date", "SHIP_DATE"]) {
      expect(sqlSays.get(h), `SQL accepts ${JSON.stringify(h)}`).toBe(false);
      expect(tsRefuses(h), `TS accepts ${JSON.stringify(h)}`).toBe(false);
    }
    for (const h of ["Costs", "Rates", "Labels", "Invoiced", "invoiced_amount", "Carrier Adjustment", "carrier.fee"]) {
      expect(sqlSays.get(h), `SQL refuses ${JSON.stringify(h)}`).toBe(true);
      expect(tsRefuses(h), `TS refuses ${JSON.stringify(h)}`).toBe(true);
    }
    // "Carrier Charge to Customer" is the customer's own charge, so the backstop accepts it; the strict word list refuses it and the 3PL renames the column.
    expect(sqlSays.get("Carrier Charge to Customer")).toBe(false);
    expect(tsRefuses("Carrier Charge to Customer")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The TypeScript import pipeline against the real RPCs
// ---------------------------------------------------------------------------
describe("what the TypeScript import pipeline sends, the database accepts", () => {
  let w: World;
  let ctx: AdjustmentContext;
  const fixture = (name: string) => readFileSync(path.resolve(__dirname, "../fixtures/adjustments", name));
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

  beforeAll(async () => {
    w = await buildWorld();
    const catalog = (await sql<{ id: string; carrier_code: string; code: string; name: string; carrier_name: string }>(
      "select s.id, s.carrier_code, s.code, s.name, c.name as carrier_name from public.shipping_services s join public.carriers c on c.code = s.carrier_code where s.is_active",
    )).map((r) => ({ id: r.id, carrierCode: r.carrier_code, carrierName: r.carrier_name, code: r.code, name: r.name }));
    const brands = await sql<{ id: string; name: string }>("select id, name from public.brands where tenant_id = $1", [w.t1.id]);
    const [{ today }] = (await sql<{ today: string }>("select current_date::text as today")) as [{ today: string }];
    ctx = { catalog, brands, today };
  });

  /** Upload, register, map, validate with the attestation, send every chunk, reconcile and finalize: the flow the actions will run. */
  async function runImport(bytes: Buffer, name: string, mappingOver?: (m: ReturnType<typeof detectAdjustmentFile>["suggestion"]) => ReturnType<typeof detectAdjustmentFile>["suggestion"], existingKeys?: ReadonlySet<string>) {
    const admin = w.t1.admin.id;
    const parsed = await parseAdjustmentFile(bytes, "csv");
    if (parsed.status !== "ok") throw new Error(`not accepted: ${parsed.status}`);
    const detection = detectAdjustmentFile(parsed.tables, ctx);
    const mapping = mappingOver ? mappingOver(detection.suggestion) : detection.suggestion;
    const result = applyAdjustmentMapping(parsed.tables, mapping, { ...ctx, existingKeys });
    const [file] = await asUser<{ id: string }>(
      admin,
      "insert into public.uploaded_files (tenant_id, purpose, filename, mime_type, byte_size, sha256, content) values ($1, 'adjustment_import', $2, 'text/csv', $3, decode($4, 'hex'), $5) returning id",
      [w.t1.id, `${name}.csv`, bytes.length, sha(bytes), bytes],
    );
    const created = (await asUser<{ r: { ok: boolean; importId?: string } }>(admin, "select public.create_adjustment_import($1, $2, $3::jsonb) as r", [file!.id, name, JSON.stringify(buildDetected(parsed.tables, mapping))]))[0]!.r;
    expect(created.ok).toBe(true);
    const importId = created.importId!;
    const stored = toStoredMapping(mapping, parsed.tables[0]!.rows[mapping.headerRow]!);
    expect((await asUser<{ s: string }>(admin, "select public.set_adjustment_import_mapping($1, $2::jsonb, null, $3, false) as s", [importId, JSON.stringify(stored), mapping.duplicateHandling]))[0]!.s).toBe("mapped");
    expect((await asUser<{ s: string }>(admin, "select public.set_adjustment_import_mapping($1, $2::jsonb, $3::jsonb, $4, true) as s", [importId, JSON.stringify(stored), JSON.stringify(toStoredValidation(result.report)), mapping.duplicateHandling]))[0]!.s).toBe("validated");
    const { chunks, accepted } = buildAppendChunks(result);
    let last: AppendResult | null = null;
    for (const c of chunks) last = (await asUser<{ r: AppendResult }>(admin, "select public.append_adjustment_records($1, $2, $3::jsonb) as r", [importId, c.fromRow, JSON.stringify(c.rows)]))[0]!.r;
    const reconciled = reconcileCommit(accepted, last);
    expect(reconciled.ok).toBe(true);
    const fin = (await asUser<{ r: { committed: number; skipped: number } }>(admin, "select public.finalize_adjustment_import($1) as r", [importId]))[0]!.r;
    return { importId, file: file!.id, result, chunks, reconciled, fin };
  }

  it("history-sample.csv: every field the library derived is what the database stored, and the raw file is gone", async () => {
    const out = await runImport(fixture("history-sample.csv"), "sample");
    expect(out.chunks).toHaveLength(1);
    expect(out.fin).toEqual({ importId: out.importId, committed: 40, skipped: 0 });
    expect(await sql("select 1 from public.uploaded_files where id = $1", [out.file])).toHaveLength(0);
    const stored = await sql<Record<string, string | null>>(
      `select row_no, ship_date::text, adjusted_on::text, carrier_code, service_id::text, brand_id::text, adjustment_type, cause, reason_text, package_ref, declared_weight_lb::text, declared_weight_basis, actual_weight_lb::text,
              orig_length_in::text, orig_width_in::text, orig_height_in::text, corr_length_in::text, corr_width_in::text, corr_height_in::text, original_charge::text, corrected_charge::text, separate_fee::text, postage_difference::text, handling_recorded
         from public.adjustment_records where import_id = $1 order by row_no`,
      [out.importId],
    );
    expect(stored).toHaveLength(40);
    const num = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));
    out.result.records.forEach((r, i) => {
      const row = stored[i]!;
      expect(Number(row.row_no)).toBe(i + 1);
      expect([row.ship_date, row.adjusted_on, row.carrier_code, row.service_id, row.brand_id, row.adjustment_type, row.cause, row.reason_text, row.package_ref, row.declared_weight_basis, row.handling_recorded]).toEqual([
        r.shipDate, r.adjustedOn, r.carrierCode, r.serviceId, r.brandId, r.adjustmentType, r.cause, r.reasonText, r.packageRef, r.declaredWeightBasis, r.handlingRecorded,
      ]);
      expect([num(row.declared_weight_lb), num(row.actual_weight_lb)]).toEqual([num(r.declaredWeightLb), num(r.actualWeightLb)]);
      expect([num(row.orig_length_in), num(row.orig_width_in), num(row.orig_height_in), num(row.corr_length_in), num(row.corr_width_in), num(row.corr_height_in)]).toEqual([
        num(r.original?.length ?? null), num(r.original?.width ?? null), num(r.original?.height ?? null), num(r.corrected?.length ?? null), num(r.corrected?.width ?? null), num(r.corrected?.height ?? null),
      ]);
      expect([num(row.original_charge), num(row.corrected_charge), num(row.separate_fee)]).toEqual([num(r.originalCharge), num(r.correctedCharge), num(r.separateFee)]);
    });
    // Spot checks against the hand-derived values: kg and g rows, blank money stays null, the double-counted row is stored as written.
    const byRef = (ref: string) => stored.find((r) => r.package_ref === ref)!;
    expect([byRef("1Z9A000016")!.declared_weight_lb, byRef("1Z9A000016")!.actual_weight_lb]).toEqual(["3.306934", "4.188783"]);
    expect([byRef("1Z9A000017")!.declared_weight_lb, byRef("1Z9A000017")!.actual_weight_lb]).toEqual(["4.409245", "5.732019"]);
    expect([byRef("1Z9A000011")!.original_charge, byRef("1Z9A000011")!.corrected_charge, byRef("1Z9A000011")!.separate_fee]).toEqual([null, null, null]);
    expect(byRef("1Z9A000003")!.declared_weight_lb).toBeNull();
    expect(byRef("1Z9A000003")!.declared_weight_basis).toBe("missing");
    expect(byRef("1Z9A000038")!.brand_id).toBeNull();
    expect(byRef("1Z9A000008")).toMatchObject({ original_charge: "21.44", corrected_charge: "24.44", separate_fee: "3.00", postage_difference: "3.00" });
    // What the import stored in `detected` and `mapping` holds no value from an unmapped column and no flagged header.
    const [imp] = await sql<{ detected: { headers: string[]; sampleRows: Record<string, string>[] }; mapping: { fields: Record<string, string> } }>("select detected, mapping from public.adjustment_imports where id = $1", [out.importId]);
    expect(imp!.detected.sampleRows.length).toBeLessThanOrEqual(20);
    expect(Object.keys(imp!.mapping.fields)).toHaveLength(23);
  });

  it("importing the same file again without telling the library: the database skips all 40 rows and the counts reconcile", async () => {
    const out = await runImport(fixture("history-sample.csv"), "sample again");
    expect(out.result.report.counts.accepted).toBe(40);
    expect(out.fin).toEqual({ importId: out.importId, committed: 0, skipped: 40 });
    expect(out.reconciled).toMatchObject({ ok: true, committed: 0, skipped: 40, message: "0 rows were added; 40 were already imported and skipped." });
    expect(Number((await sql<{ n: string }>("select count(*)::text as n from public.adjustment_records where import_id = $1", [out.importId]))[0]!.n)).toBe(0);
  });

  it("4,500 rows are three chunks (2,000, 2,000, 500) with dense row numbers the database cursor accepts", async () => {
    const header = "ship_date,adjusted_on,carrier,service,brand,adjustment_type,cause,reason,package_ref,declared_weight,actual_weight,weight_unit,customer_charge_original,customer_charge_corrected,customer_adjustment_fee";
    const lines = Array.from({ length: 4500 }, (_, i) => `2026-08-0${(i % 9) + 1},2026-08-12,UPS,UPS Ground,Alpha Apparel,reweight,carrier_reweigh,Carrier reweigh,1ZB${String(i).padStart(7, "0")},${(i % 7) + 1},${(i % 7) + 2},lb,12.00,13.50,3.00`);
    const out = await runImport(Buffer.from([header, ...lines].join("\n")), "bulk");
    expect(out.chunks.map((c) => [c.fromRow, c.rows.length])).toEqual([[1, 2000], [2001, 2000], [4001, 500]]);
    expect(out.fin).toEqual({ importId: out.importId, committed: 4500, skipped: 0 });
    const [agg] = await sql<{ n: string; min: number; max: number }>("select count(*)::text as n, min(row_no) as min, max(row_no) as max from public.adjustment_records where import_id = $1", [out.importId]);
    expect([Number(agg!.n), agg!.min, agg!.max]).toEqual([4500, 1, 4500]);
  });

  it("a flagged column the library would never send cannot be stored by hand either: the database refuses the mapping", async () => {
    const admin = w.t1.admin.id;
    const bytes = fixture("history-sample.csv");
    const [file] = await asUser<{ id: string }>(admin, "insert into public.uploaded_files (tenant_id, purpose, filename, mime_type, byte_size, sha256, content) values ($1, 'adjustment_import', 'x.csv', 'text/csv', $2, decode($3, 'hex'), $4) returning id", [w.t1.id, bytes.length, sha(bytes), bytes]);
    const created = (await asUser<{ r: { importId: string } }>(admin, "select public.create_adjustment_import($1, 'hand', '{}'::jsonb) as r", [file!.id]))[0]!.r;
    await expect(asUser(admin, "select public.set_adjustment_import_mapping($1, $2::jsonb)", [created.importId, JSON.stringify({ fields: { originalCharge: "Carrier Cost" } })])).rejects.toThrow(/looks like carrier cost data/);
    await asUser(admin, "select public.discard_adjustment_import($1)", [created.importId]);
  });
});
