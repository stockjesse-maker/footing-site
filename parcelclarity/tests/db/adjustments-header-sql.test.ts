import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sql } from "./harness";

/**
 * The SQL header backstop (app.adjustment_header_forbidden and its pieces) against the shared table of outcomes
 * tests/fixtures/adjustments/header-guard.json, the hostile block included. The backstop must refuse EVERY header the table refuses
 * (it is the check that still runs when a client skips the TypeScript guard), except the one pinned, deliberately looser case, and must
 * never refuse a header the table passes (a file the guard let in is never refused after it was stored).
 */
interface GuardCase { header: string; guard: "pass" | "refuse"; autoMapsToMoney: boolean; note: string; group?: string }
const table = JSON.parse(readFileSync(path.resolve(__dirname, "../fixtures/adjustments/header-guard.json"), "utf8")) as { templateHeaders: string[]; cases: GuardCase[] };
const hostile = table.cases.filter((c) => c.group === "hostile");

const verdicts = async (headers: string[]): Promise<boolean[]> =>
  (await sql<{ f: boolean }>("select app.adjustment_header_forbidden(t.v) as f from unnest($1::text[]) with ordinality as t(v, n) order by t.n", [headers])).map((r) => r.f);
const norm = async (header: string): Promise<string> => (await sql<{ n: string }>("select app.adjustment_header_norm($1) as n", [header]))[0]!.n;
const fold = async (header: string): Promise<string> => (await sql<{ n: string }>("select app.adjustment_header_fold($1) as n", [header]))[0]!.n;
const cp = (...codes: number[]) => String.fromCodePoint(...codes);

describe("the SQL backstop against header-guard.json", () => {
  it("agrees on all 71 original rows, with one pinned difference: the bare word 'carrier' beside no money word passes here (the TypeScript guard refuses it)", async () => {
    const original = table.cases.filter((c) => c.group !== "hostile");
    expect(original).toHaveLength(71);
    const got = await verdicts(original.map((c) => c.header));
    const disagree = original.filter((c, i) => got[i] !== (c.guard === "refuse")).map((c) => c.header);
    expect(disagree).toEqual(["Carrier Name"]);
  });

  it("refuses every hostile header the table refuses and passes every harmless one (at least 30 rows: zero-width, soft hyphen, look-alikes, fullwidth, camelCase, digits, carrier brands)", async () => {
    expect(hostile.length).toBeGreaterThanOrEqual(30);
    expect(hostile.filter((c) => c.guard === "refuse").length).toBeGreaterThanOrEqual(30);
    expect(hostile.filter((c) => c.guard === "pass").length).toBeGreaterThanOrEqual(10);
    const got = await verdicts(hostile.map((c) => c.header));
    const wrong = hostile.map((c, i) => ({ c, refused: got[i] })).filter((x) => x.refused !== (x.c.guard === "refuse")).map((x) => `${JSON.stringify(x.c.header)} (${x.c.note}): expected ${x.c.guard}, the backstop ${x.refused ? "refused" : "passed"}`);
    expect(wrong).toEqual([]);
  });

  it("the table covers every technique the review named", () => {
    const text = hostile.map((c) => c.note.toLowerCase()).join(" | ");
    for (const technique of ["zero-width", "soft hyphen", "cyrillic", "greek", "fullwidth", "camelcase", "trailing digit", "carrier brand", "only an invisible character", "punctuation only"]) expect(text, technique).toContain(technique);
  });

  it("every template header passes, however it is written (fullwidth, invisible characters, case)", async () => {
    const variants = table.templateHeaders.flatMap((h) => [h, h.toUpperCase(), h.replace(/_/g, " "), h.replace(/_/g, cp(0x200b) + "_")]);
    const got = await verdicts(variants);
    expect(variants.filter((_, i) => got[i])).toEqual([]);
  });
});

describe("the steps of the normalisation", () => {
  it("folds look-alike Cyrillic and Greek letters to the Latin letters they imitate, in both cases, and nothing else is changed", async () => {
    const pairs: [string, string][] = [
      [cp(0x0421, 0x043e, 0x0441, 0x0442), "Coct"], [cp(0x0410, 0x0412, 0x0415, 0x041a, 0x041c, 0x041d, 0x041e, 0x0420, 0x0421, 0x0422, 0x0425, 0x0423), "ABEKMHOPCTXY"],
      [cp(0x0430, 0x0435, 0x043e, 0x0440, 0x0441, 0x0445, 0x0443, 0x0456), "aeopcxyi"], [cp(0x0391, 0x0392, 0x0395, 0x0396, 0x0397, 0x0399, 0x039a, 0x039c, 0x039d, 0x039f, 0x03a1, 0x03a4, 0x03a5, 0x03a7), "ABEZHIKMNOPTYX"],
      [cp(0x03bf, 0x03c1, 0x03c4, 0x03c5, 0x03c7), "optux"], ["Plain ASCII 123", "Plain ASCII 123"],
    ];
    for (const [input, expected] of pairs) expect(await fold(input), JSON.stringify(input)).toBe(expected);
  });

  it("removes invisible format characters and combining marks, and splits accents from their letters", async () => {
    expect(await fold(`C${cp(0x200b, 0x200c, 0x200d, 0xad, 0x2060, 0xfeff, 0x202e)}ost`)).toBe("Cost");
    expect(await fold(`C${cp(0xe0041)}ost`)).toBe("Cost"); // a tag character (astral)
    expect(await fold(`R${cp(0xe1)}te`)).toBe("Rate"); // a-acute: NFKD splits it, the accent is removed
    expect(await fold(`Co${cp(0x338)}st`)).toBe("Cost"); // a combining mark with no precomposed form
    expect(await fold(cp(0xff23, 0xff2f, 0xff33, 0xff34))).toBe("COST");
  });

  it("splits camelCase before lower-casing, then keeps only a-z, 0-9 and single spaces", async () => {
    expect(await norm("CarrierCost")).toBe("carrier cost");
    expect(await norm("UPSCost")).toBe("ups cost");
    expect(await norm("FedEx Billed")).toBe("fed ex billed");
    expect(await norm("OnTrac_Total")).toBe("on trac total");
    expect(await norm("  Ship--Date (lb)  ")).toBe("ship date lb");
    expect(await norm(`Customer${cp(0x2019)}s Charge`)).toBe("customer s charge");
    expect(await norm("###")).toBe("");
    expect(await norm("")).toBe("");
  });
});

describe("what the rule does with edge cases", () => {
  it("passes NULL and blank, refuses a header over 200 characters, refuses a non-empty header with nothing readable in it, and an unreadable letter beside readable ones", async () => {
    expect(await verdicts(["", "   ", "\t"])).toEqual([false, false, false]);
    expect((await sql<{ f: boolean }>("select app.adjustment_header_forbidden(null) as f"))[0]!.f).toBe(false);
    expect(await verdicts(["a".repeat(200), "a".repeat(201), "Ship Date " + "x".repeat(195)])).toEqual([false, true, true]);
    expect(await verdicts([cp(0x200b), "#", "$", "...", cp(0x4e1c, 0x4eac), cp(0x1f4b0)])).toEqual([true, true, true, true, true, true]);
    // A letter that looks like nothing we know, mixed with Latin letters, is a mixed-script header: refused.
    expect(await verdicts([`Ship D${cp(0x00e6)}te`, `${cp(0x4e1c)}Ship Dates`])).toEqual([true, true]);
    // (An exact template header passes however it is dressed, even with an unreadable letter next to it: it is a template header all the same.)
    expect(await verdicts([`${cp(0x4e1c)}Ship Date`])).toEqual([false]);
    // Typographic punctuation and symbols are separators, not letters.
    expect(await verdicts([`Customer${cp(0x2019)}s Charge`, `Ship ${cp(0x2013)} Date`, `Weight ${cp(0x2116)}`, `Tracking${cp(0xb7)}Number`])).toEqual([false, false, false, false]);
  });

  it("applies a number on either end of a word and the long stems exactly as the TypeScript guard does", async () => {
    expect(await verdicts(["cost1", "1cost", "Net2Rate", "rate_3", "costs", "Rates", "nets", "buys", "invoiced", "Postages"])).toEqual(Array(10).fill(true));
    expect(await verdicts(["Costume", "Ratey", "Buyer Name", "Internet Order", "Labelled", "Network", "Cost2go", "Carrier"])).toEqual(Array(8).fill(false)); // whole words only: "Cost2go" has a digit inside, not on an end
    expect(await verdicts(["postagecost", "wholesaleprice", "negotiatedrate", "invoicenumber", "xpostagex"])).toEqual(Array(5).fill(true));
  });

  it("refuses 'carrier' or a carrier brand beside a money word unless the header says it is the customer's", async () => {
    const refused = ["Carrier Charge", "Carrier Fee", "Carrier Total", "Carrier Price", "Carrier Adjustment", "Carrier Billed", "UPS Charge", "UPS Fee", "USPS Amount", "FedEx Price", "FedEx Billed", "DHL Total", "OnTrac Fee", "LaserShip Amount", "UPS2 Charge", "ups_charge_original"];
    const passed = ["Carrier Name", "Carrier", "UPS", "UPS Service", "UPS Ground", "FedEx Home Delivery", "DHL Express", "LaserShip Zone", "Upside Fee", "Groups Total",
      "Carrier Charge to Customer", "UPS Charge to Customer", "Charged to Customer UPS", "Customer UPS Fee", "FedEx billed to customer", "Customer FedEx Amount"];
    const r = await verdicts(refused);
    const p = await verdicts(passed);
    expect(refused.filter((_, i) => !r[i])).toEqual([]);
    expect(passed.filter((_, i) => p[i])).toEqual([]);
  });

  it("is IMMUTABLE and PARALLEL SAFE with an empty search_path, so it can run in a trigger or an index without surprises", async () => {
    const fns = await sql<{ proname: string; provolatile: string; proparallel: string; config: string[] | null }>(
      "select proname, provolatile, proparallel, proconfig as config from pg_proc where pronamespace = 'app'::regnamespace and proname in ('adjustment_header_fold', 'adjustment_header_norm', 'adjustment_header_forbidden', 'adjustment_header_words_forbidden', 'adjustment_template_headers', 'canon_package_ref') order by 1");
    expect(fns.map((f) => f.proname)).toEqual(["adjustment_header_fold", "adjustment_header_forbidden", "adjustment_header_norm", "adjustment_header_words_forbidden", "adjustment_template_headers", "canon_package_ref"]);
    for (const f of fns) {
      expect(f.provolatile, f.proname).toBe("i");
      expect(f.proparallel, f.proname).toBe("s");
      expect(f.config, f.proname).toContain('search_path=""');
    }
  });
});

describe("the stored bytes, read the way the database sees them (app.adjustment_scan_file)", () => {
  const scan = async (content: Buffer, mime = "text/csv", filename = "x.csv") => (await sql<{ r: Record<string, unknown> }>("select app.adjustment_scan_file($1::bytea, $2, $3) as r", [content, mime, filename]))[0]!.r;

  it("answers {ok}, {unsupported_encoding} or {forbidden_header, header}, and never raises on any byte sequence", async () => {
    expect(await scan(Buffer.from("ship_date,carrier\n2026-01-01,ups\n"))).toEqual({ ok: true });
    expect(await scan(Buffer.from("ship_date,Carrier Cost\n"))).toEqual({ ok: false, reason: "forbidden_header", header: "Carrier Cost" });
    expect(await scan(Buffer.from([0xff, 0xfe, 0x73, 0x00]))).toEqual({ ok: false, reason: "unsupported_encoding" });
    expect(await scan(Buffer.from("a\u0000b"))).toEqual({ ok: false, reason: "unsupported_encoding" });
    // Every possible single byte after a header, and random garbage: an answer, not an error.
    for (let b = 1; b < 256; b++) expect(await scan(Buffer.concat([Buffer.from("ship_date,carrier\n"), Buffer.from([b, b, 0x0a, b])]))).toHaveProperty("ok");
    let seed = 7;
    for (let i = 0; i < 60; i++) {
      const bytes = Buffer.alloc(200);
      for (let k = 0; k < bytes.length; k++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; bytes[k] = (seed >> 8) % 255 + 1; }
      expect(await scan(bytes)).toHaveProperty("ok");
    }
    // A multi-byte character cut by the 64 KB limit does not turn UTF-8 text into Latin-1 mojibake: the header after it is still read.
    const filler = Buffer.from("x".repeat(65_535) + "é");
    expect(await scan(Buffer.concat([Buffer.from(`${cp(0x200b)}Cost,ship_date\n`), filler]))).toMatchObject({ ok: false, reason: "forbidden_header" });
    // Not a text file: not read. NULL content: nothing to read.
    expect(await scan(Buffer.from("Carrier Cost\u0000"), "application/octet-stream", "x.bin")).toEqual({ ok: true });
    expect((await sql<{ r: Record<string, unknown> }>("select app.adjustment_scan_file(null, 'text/csv', 'x.csv') as r"))[0]!.r).toEqual({ ok: true });
  });

  it("tests only lines that can be headers after the first (three or more filled cells, at most a quarter numbers or dates) and only by their words", async () => {
    // A title line of three text cells is read; a data row full of numbers is not; a data cell with non-ASCII letters is never a header.
    expect(await scan(Buffer.from("Report,Net Rate,Run 7\nship_date,carrier,package_ref\n"))).toMatchObject({ ok: false, header: "Net Rate" });
    expect(await scan(Buffer.from("ship_date,carrier,package_ref,declared_weight,customer_charge_original\n2026-01-01,UPS,Net Rate,4,12.50\n"))).toEqual({ ok: true });
    expect(await scan(Buffer.from("ship_date,carrier,package_ref\nLabel,东京,café\n"))).toMatchObject({ ok: false, header: "Label" });
    expect(await scan(Buffer.from("ship_date,carrier,package_ref\n东京,café,##\n"))).toEqual({ ok: true });
    // The first line is held to the whole rule, including 'nothing readable'.
    expect(await scan(Buffer.from("ship_date,#,carrier\n"))).toMatchObject({ ok: false, header: "#" });
    // 50 non-blank lines are read, blank lines do not count.
    const lines = (n: number) => Array.from({ length: n }, () => "Weekly report,Run 7,Acme");
    expect(await scan(Buffer.from([...lines(49), "Net Rate,x,y"].join("\n")))).toMatchObject({ ok: false });
    expect(await scan(Buffer.from([...lines(50), "Net Rate,x,y"].join("\n")))).toEqual({ ok: true });
    expect(await scan(Buffer.from([...lines(25), ...Array(500).fill(""), ...lines(24), "Net Rate,x,y"].join("\n")))).toMatchObject({ ok: false });
  });
});
