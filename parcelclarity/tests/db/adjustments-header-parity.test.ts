import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { canonicalPackageRef } from "@/lib/adjustments/cells";
import { ADJUSTMENT_TEMPLATE_HEADERS, guardHeader, isAutoMappableMoneyHeader, normalizeGuardHeader } from "@/lib/adjustments/header-guard";
import { CONFUSABLE_CHARACTERS, foldHeader } from "@/lib/adjustments/header-text";
import { buildDetected, detectAdjustmentFile, toStoredMapping } from "@/lib/adjustments/mapping";
import { parseAdjustmentFile } from "@/lib/adjustments/parse";
import { buildAppendChunks, reconcileCommit, type AppendResult } from "@/lib/adjustments/payload";
import type { AdjustmentContext } from "@/lib/adjustments/types";
import { adjustmentRecordKey, applyAdjustmentMapping, toStoredValidation } from "@/lib/adjustments/validate";
import { asUser, sql } from "./harness";
import { buildWorld, type World } from "./world";

/**
 * Header guard and package reference parity (Milestone 5, amendment A4, review findings F4 and F12). The TypeScript guard
 * (src/lib/adjustments/header-guard.ts) runs before a file is stored; the SQL function app.adjustment_header_forbidden is the backstop that
 * create_adjustment_import, set_adjustment_import_mapping and the upload trigger apply to the stored header names. They must agree where it matters:
 *   * the backstop never refuses a header the TypeScript guard accepts (so a file that passed the guard is never refused after
 *     it was stored, and no accepted template header is refused);
 *   * the backstop refuses every header the table refuses, EXCEPT a pinned list where it is deliberately looser ("Carrier Name" has the
 *     word carrier but no amount word: the TypeScript guard asks for a rename, the backstop only has to catch what the guard would have
 *     caught). Each difference is pinned below so drift on either side fails.
 *   * the TypeScript fold and normalisation (src/lib/adjustments/header-text.ts) give the database's answers, character by character;
 *   * the TypeScript canonical package reference is app.canon_package_ref.
 */

interface GuardCase { header: string; guard: "pass" | "refuse"; autoMapsToMoney: boolean; group?: string }
const table = JSON.parse(readFileSync(path.resolve(__dirname, "../fixtures/adjustments/header-guard.json"), "utf8")) as { templateHeaders: string[]; cases: GuardCase[] };
const refs = JSON.parse(readFileSync(path.resolve(__dirname, "../fixtures/adjustments/package-refs.json"), "utf8")) as { cases: { input: string; canonical: string | null; note: string }[] };

async function sqlRefuses(headers: string[]): Promise<Map<string, boolean>> {
  const rows = await sql<{ h: string; r: boolean }>("select h, app.adjustment_header_forbidden(h) as r from unnest($1::text[]) as h", [headers]);
  return new Map(rows.map((r) => [r.h, r.r]));
}

const tsRefuses = (h: string) => !guardHeader(h).allowed;

/** Headers the TypeScript guard refuses beyond the fixture table: camelCase, plurals, unseparated long stems, "invoiced", a carrier's brand beside an amount word. */
const PROBES = [
  "CarrierCost", "PostageCost", "UPSCost", "BuyRate", "WholesalePrice", "NegotiatedRate", "NegotiatedRate2", "postagecost", "invoicenumber",
  "Costs", "Rates", "Labels", "Nets", "Buys", "Invoices", "Postages", "Carriers", "Invoiced", "invoiced_amount", "Carrier", "carrier", "CARRIER",
  "Carrier Name", "Carrier Service", "carrier_code", "Carrier ID", "Carrier Charge to Customer", "Carrier Adjustment", "carrier.fee",
  "Customer Charge", "Charged to Customer", "Billed to Customer", "Customer Adjustment Fee", "Corrected Weight (lb)", "Tracking", "Service Level", "Reweigh Reason",
  "Separate Fee Note", "Generated On", "Internet Order", "Buyer Name", "Costume", "Ratey", "", "   ", "Ship Date", "ship date", "SHIP_DATE",
  "UPS Charge", "UPS Service Fee", "ups2 fee", "FedEx Billed", "Fed Ex Total", "On Trac Price", "Laser Ship Amount", "DHL Amount to Customer", "USPS Charged to Customer Amount", "UPS Service Fee", "UPS Ground", "Billed To Account", "Charged To Account",
  "Amount Billed To Account", "Ship Date\ufffd", "R\u00e9f\u00e9rence", "Gr\u00f6\u00dfe", "\u4e1c\u4eac", "ship_date\u0301", "Cost\u0301", "S\u200bhip D\u200bate",
];

const VOCABULARY = ["ship", "date", "carrier", "service", "customer", "brand", "charge", "charged", "to", "billed", "fee", "adjustment", "amount", "total", "price", "original", "corrected", "weight", "net", "gross",
  "cost", "rate", "postage", "label", "wholesale", "negotiated", "paid", "invoice", "invoiced", "buy", "buyer", "tracking", "number", "ref", "reason", "cause", "notes", "sku", "order", "zip", "separate", "internet", "unit",
  "ups", "usps", "fedex", "dhl", "ontrac", "lasership", "fed", "ex", "on", "trac", "laser", "ship"];
const ZERO_WIDTH = ["\u200b", "\u200d", "\u00ad", "\u2060", "\ufeff", "\u200e"];
const CYRILLIC: Record<string, string> = { a: "\u0430", c: "\u0441", e: "\u0435", o: "\u043e", p: "\u0440", x: "\u0445", y: "\u0443" };

/** Seeded header-like texts: words in a few shapes, sometimes with an invisible character, fullwidth letters or a Cyrillic look-alike in them. */
function seededHeaders(count: number, seed0 = 20261016): string[] {
  let seed = seed0;
  const next = (n: number) => (seed = (seed * 1664525 + 1013904223) % 4294967296) % n;
  const separators = [" ", "_", "-", ".", "  ", " / "];
  return Array.from({ length: count }, () => {
    const words = Array.from({ length: 1 + next(4) }, () => VOCABULARY[next(VOCABULARY.length)]!);
    let text = words.join(separators[next(separators.length)]!);
    if (next(3) === 0) text = text.toUpperCase();
    else if (next(3) === 0) text = text.replace(/(^|[ _.-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
    if (next(4) === 0) {
      const at = next(text.length + 1);
      text = text.slice(0, at) + ZERO_WIDTH[next(ZERO_WIDTH.length)]! + text.slice(at);
    }
    if (next(8) === 0) text = [...text].map((c) => (c >= "!" && c <= "~" ? String.fromCodePoint(c.charCodeAt(0) + 0xfee0) : c)).join("");
    else if (next(8) === 0) text = [...text].map((c) => CYRILLIC[c] ?? c).join("");
    return text;
  });
}

describe("the SQL backstop against the TypeScript header guard", () => {
  it("never refuses a header the TypeScript guard accepts: the 138 fixture headers, the probe list and 1,200 seeded texts with invisible, fullwidth and look-alike characters", async () => {
    const all = [...new Set([...table.cases.map((c) => c.header), ...PROBES, ...seededHeaders(1200)])];
    const sqlSays = await sqlRefuses(all);
    const sqlOnly = all.filter((h) => sqlSays.get(h) === true && !tsRefuses(h));
    expect(sqlOnly, `refused by SQL but accepted by the TypeScript guard: ${JSON.stringify(sqlOnly)}`).toEqual([]);
  });

  it("every one of the 138 fixture headers: the TypeScript guard and its auto-map rule match the table; the SQL backstop refuses everything the table refuses except the pinned looser cases, and accepts everything it accepts", async () => {
    expect(table.cases).toHaveLength(138);
    // The TypeScript guard agrees with the hand-derived table on every header.
    expect(table.cases.filter((c) => tsRefuses(c.header) !== (c.guard === "refuse")).map((c) => c.header)).toEqual([]);
    expect(table.cases.filter((c) => isAutoMappableMoneyHeader(c.header) !== c.autoMapsToMoney).map((c) => c.header)).toEqual([]);
    const sqlSays = await sqlRefuses(table.cases.map((c) => c.header));
    const refused = table.cases.filter((c) => c.guard === "refuse");
    expect(refused).toHaveLength(73);
    // The SQL side refuses all but "Carrier Name" (the word carrier with no amount word: the TypeScript guard asks for a rename, the backstop has to catch only what the guard would have caught).
    expect(refused.filter((c) => sqlSays.get(c.header) === false).map((c) => c.header)).toEqual(["Carrier Name"]);
    const accepted = table.cases.filter((c) => c.guard === "pass");
    expect(accepted).toHaveLength(65);
    expect(accepted.filter((c) => sqlSays.get(c.header) === true).map((c) => c.header)).toEqual([]);
    // The 67 hostile headers: every refusal in the table is a refusal in SQL too.
    expect(table.cases.filter((c) => c.group === "hostile" && c.guard === "refuse" && sqlSays.get(c.header) === false)).toEqual([]);
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
    // The backstop is looser only where the TypeScript guard asks the 3PL to rename a column (the word "carrier" with no amount word) and for the
    // replacement character after a template header (the guard refuses it as "not saved as UTF-8"; SQL reads "Ship Date" and passes it, which is the safe direction).
    expect(tsOnly).toEqual(["Carrier Charge to Customer", "Carrier ID", "Carrier Name", "Carrier Service", "Carriers", "carrier_code", "Ship Date\ufffd"].sort());
    expect(sqlOnly).toEqual([]);
    // Both agree on these.
    for (const h of ["Carrier", "carrier", "CARRIER", "Customer Charge", "Charged to Customer", "Billed to Customer", "Customer Adjustment Fee", "Corrected Weight (lb)", "Tracking", "Service Level", "Reweigh Reason", "Separate Fee Note", "Generated On", "Internet Order", "Buyer Name", "Costume", "Ratey", "", "   ", "Ship Date", "ship date", "SHIP_DATE",
      "UPS Ground", "Billed To Account", "Charged To Account", "Amount Billed To Account", "R\u00e9f\u00e9rence", "S\u200bhip D\u200bate"]) {
      expect(sqlSays.get(h), `SQL accepts ${JSON.stringify(h)}`).toBe(false);
      expect(tsRefuses(h), `TS accepts ${JSON.stringify(h)}`).toBe(false);
    }
    for (const h of ["Costs", "Rates", "Labels", "Invoiced", "invoiced_amount", "Carrier Adjustment", "carrier.fee", "UPS Charge", "UPS Service Fee", "ups2 fee", "FedEx Billed", "Fed Ex Total", "On Trac Price", "Laser Ship Amount", "Gr\u00f6\u00dfe", "\u4e1c\u4eac", "Cost\u0301", "CarrierCost", "BuyRate", "postagecost"]) {
      expect(sqlSays.get(h), `SQL refuses ${JSON.stringify(h)}`).toBe(true);
      expect(tsRefuses(h), `TS refuses ${JSON.stringify(h)}`).toBe(true);
    }
    // "Carrier Charge to Customer" is the customer's own charge, so the backstop accepts it; the strict word list refuses it and the 3PL renames the column.
    expect(sqlSays.get("Carrier Charge to Customer")).toBe(false);
    expect(tsRefuses("Carrier Charge to Customer")).toBe(true);
    // A carrier's brand beside an amount word is refused unless the header says it is the customer's.
    expect(sqlSays.get("DHL Amount to Customer")).toBe(false);
    expect(tsRefuses("DHL Amount to Customer")).toBe(false);
  });
});

describe("the TypeScript fold and normalisation are the database's", () => {
  it("fold and norm agree on every character of the confusable table, the 138 fixture headers and the seeded texts", async () => {
    const samples = [...new Set([...CONFUSABLE_CHARACTERS, ...table.cases.map((c) => c.header), ...PROBES, ...seededHeaders(600, 7)])];
    const rows = await sql<{ h: string; f: string; n: string }>("select h, app.adjustment_header_fold(h) as f, app.adjustment_header_norm(h) as n from unnest($1::text[]) as h", [samples]);
    const wrong = rows.filter((r) => foldHeader(r.h) !== r.f || normalizeGuardHeader(r.h) !== r.n).map((r) => ({ h: r.h, ts: [foldHeader(r.h), normalizeGuardHeader(r.h)], sql: [r.f, r.n] }));
    expect(wrong).toEqual([]);
    expect(CONFUSABLE_CHARACTERS).toHaveLength(88);
  });

  it("fold agrees on every code point from U+0020 to U+2FFFF that PostgreSQL's and Node's Unicode tables both know: all of the BMP, and the astral planes but for characters one table is too old to know (a sweep of about 195,000 characters)", async () => {
    const rows = await sql<{ i: number; f: string }>(
      "select i, app.adjustment_header_fold(chr(i)) as f from generate_series(32, 196607) as i where not (i between 55296 and 57343) and i <> 65533 order by i",
    );
    expect(rows.length).toBeGreaterThan(190_000);
    const mismatches = rows.filter((r) => foldHeader(String.fromCodePoint(r.i)) !== r.f).map((r) => `U+${r.i.toString(16).toUpperCase()}`);
    // Two Unicode versions may disagree about a character one of them added after the other's tables were cut (Unicode 16 letters and "outlined" Latin
    // letters and digits above U+10000 that Node decomposes and PostgreSQL 16 does not): nothing in the Basic Multilingual Plane may differ, and in SQL
    // a character it does not decompose is a non-ASCII letter that the residual rule refuses, so such a header is refused there (the safe direction).
    expect(mismatches.filter((m) => Number.parseInt(m.slice(2), 16) < 0x10000), "BMP").toEqual([]);
    expect(mismatches.length, `first mismatches: ${mismatches.slice(0, 20).join(" ")}`).toBeLessThanOrEqual(80);
  }, 120_000);
});

describe("package reference canonical form: the TypeScript twin is app.canon_package_ref", () => {
  it("answers every hand-derived pair of package-refs.json in TypeScript and in SQL alike", async () => {
    const inputs = refs.cases.map((c) => c.input);
    const sqlOut = (await sql<{ c: string | null }>("select app.canon_package_ref(t.v) as c from unnest($1::text[]) with ordinality as t(v, n) order by t.n", [inputs])).map((r) => r.c);
    expect(refs.cases.filter((c) => canonicalPackageRef(c.input) !== c.canonical).map((c) => `${JSON.stringify(c.input)}: ${c.note}`)).toEqual([]);
    expect(sqlOut).toEqual(refs.cases.map((c) => c.canonical));
  });

  it("agrees with the database on 3,000 seeded texts (whitespace, invisible characters, fullwidth letters, ligatures, case, the replacement character)", async () => {
    let seed = 99;
    const next = (n: number) => (seed = (seed * 1664525 + 1013904223) % 4294967296) % n;
    const pool = ["1Z", "ab", "AB", "\u00e9", "\u00c0", "\uff21", "\uff11", "\ufb01", "\u2460", " ", "\t", "\n", "\u00a0", "\u3000", "\u2028", "\u0085", "\u200b", "\u00ad", "\ufeff", "\u202e", "-", "_", ".", "/", "9400", "x", "\ufffd", "\u1680", "\u180e", "\u2060", "\u{e0020}", "\u0663", "\u00df", "\u0130", "\u212a"];
    const inputs = Array.from({ length: 3000 }, () => Array.from({ length: 1 + next(8) }, () => pool[next(pool.length)]!).join(""));
    const sqlOut = (await sql<{ c: string | null }>("select app.canon_package_ref(t.v) as c from unnest($1::text[]) with ordinality as t(v, n) order by t.n", [inputs])).map((r) => r.c);
    const wrong = inputs.map((input, i) => ({ input, ts: canonicalPackageRef(input), sql: sqlOut[i] })).filter((r) => r.ts !== r.sql);
    expect(wrong).toEqual([]);
  });

  it("the record key uses it: spellings of one package are one key, so the duplicate check, 'already imported' and the unique index agree", () => {
    const k = (ref: string) => adjustmentRecordKey("b", "ups", ref, "reweight");
    expect(new Set(["1Z0001AB", "1z0001ab", "1Z0001 AB", "1Z0001AB\u200b", " 1z 0001 ab "].map(k)).size).toBe(1);
    expect(k("1Z0001AB")).not.toBe(adjustmentRecordKey("b", "usps", "1Z0001AB", "reweight"));
    expect(k("1Z0001AB")).not.toBe(adjustmentRecordKey("c", "ups", "1Z0001AB", "reweight"));
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
    // At commit the database removes the sample rows (values from the file) and keeps the column names.
    expect(imp!.detected.sampleRows).toBeUndefined();
    expect(imp!.detected.headers).toHaveLength(23);
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
