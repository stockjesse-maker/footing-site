import { beforeEach, describe, expect, it, vi } from "vitest";
import { ADJUSTMENT_TEMPLATE_HEADERS, guardHeader } from "@/lib/adjustments/header-guard";
import { detectAdjustmentFile } from "@/lib/adjustments/mapping";
import { parseAdjustmentFile } from "@/lib/adjustments/parse";
import { ADJUSTMENTS_TEMPLATE_CSV, ADJUSTMENTS_TEMPLATE_FILENAME } from "@/lib/adjustments/template";
import { applyAdjustmentMapping } from "@/lib/adjustments/validate";

/** The downloadable template and its route. The route mirrors the rate-card template route's behaviour: signed-in users only, no permission. */

const h = vi.hoisted(() => ({ user: null as { id: string } | null }));
vi.mock("@/lib/auth/session", () => ({ getUser: async () => h.user }));

import { GET as adjustmentsTemplate } from "@/app/api/templates/adjustments.csv/route";
import { GET as rateCardTemplate } from "@/app/api/templates/rate-card.csv/route";

const DESIGN_HEADERS = "ship_date, adjusted_on, carrier, service, brand, adjustment_type, cause, reason, package_ref, declared_weight, actual_weight, weight_unit, original_length, original_width, original_height, corrected_length, corrected_width, corrected_height, dimension_unit, customer_charge_original, customer_charge_corrected, customer_adjustment_fee, handling".split(", ");

beforeEach(() => {
  h.user = null;
});

describe("the template", () => {
  it("has the 23 headers of design v2 section 5, in order, and every header passes the guard", () => {
    expect(DESIGN_HEADERS).toHaveLength(23);
    expect([...ADJUSTMENT_TEMPLATE_HEADERS]).toEqual(DESIGN_HEADERS);
    const lines = ADJUSTMENTS_TEMPLATE_CSV.trimEnd().split("\n");
    expect(lines[0]).toBe(DESIGN_HEADERS.join(","));
    for (const header of lines[0]!.split(",")) expect(guardHeader(header).allowed, header).toBe(true);
  });

  it("has two example rows that say they are fictional, and every row has a value for every column or leaves it blank", () => {
    const lines = ADJUSTMENTS_TEMPLATE_CSV.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    for (const row of lines.slice(1)) {
      expect(row.split(",")).toHaveLength(23);
      expect(row).toContain("FICTIONAL EXAMPLE ROW");
      expect(row).toContain("Example Brand (fictional)");
      expect(row).toMatch(/,EXAMPLE-FICTIONAL-00\d,/);
    }
  });

  it("reads through the importer, and the example rows are refused so they can never become history", async () => {
    const parsed = await parseAdjustmentFile(Buffer.from(ADJUSTMENTS_TEMPLATE_CSV), "csv");
    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") return;
    const ctx = { catalog: [{ id: "00000000-0000-4000-8000-0000000000a1", carrierCode: "ups", carrierName: "UPS", code: "ground", name: "UPS Ground" }], brands: [], today: "2026-10-16" };
    const d = detectAdjustmentFile(parsed.tables, ctx);
    expect(Object.values(d.suggestion.columns).every((c) => c !== null)).toBe(true);
    expect(d.ignoredColumns).toEqual([]);
    const { report, records } = applyAdjustmentMapping(parsed.tables, d.suggestion, ctx);
    expect(report.counts).toMatchObject({ rows: 2, errorRows: 2, accepted: 0 });
    expect(report.byCode.example_row).toBe(2);
    expect(report.committable).toBe(false);
    // Nothing else is wrong with the example rows: they read cleanly apart from being examples.
    expect(Object.entries(report.byCode).filter(([k, v]) => v > 0 && k !== "example_row" && k !== "unknown_customer").map(([k]) => k)).toEqual([]);
    expect(records).toEqual([]);
  });
});

describe("GET /api/templates/adjustments.csv", () => {
  it("sends the template as a private, non-sniffable CSV attachment with CRLF line endings to a signed-in user", async () => {
    h.user = { id: "u1" };
    const res = await adjustmentsTemplate();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe(`attachment; filename="${ADJUSTMENTS_TEMPLATE_FILENAME}"`);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const body = await res.text();
    expect(body).toBe(ADJUSTMENTS_TEMPLATE_CSV.replace(/\n/g, "\r\n"));
    expect(body.split("\r\n")[0]).toBe(DESIGN_HEADERS.join(","));
  });

  it("answers an anonymous request with 401 and a plain-text message, exactly as the rate-card template does", async () => {
    h.user = null;
    const ours = await adjustmentsTemplate();
    const theirs = await rateCardTemplate();
    expect(ours.status).toBe(401);
    expect(ours.status).toBe(theirs.status);
    expect(ours.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(ours.headers.get("Content-Type")).toBe(theirs.headers.get("Content-Type"));
    const [ourText, theirText] = [await ours.text(), await theirs.text()];
    expect(ourText).toBe("Sign in to download the template.");
    expect(ourText).toBe(theirText);
    expect(ours.headers.get("Content-Disposition")).toBeNull();
  });

  it("mirrors the rate-card route for a signed-in user: same status and same header names", async () => {
    h.user = { id: "u1" };
    const ours = await adjustmentsTemplate();
    const theirs = await rateCardTemplate();
    expect(ours.status).toBe(theirs.status);
    expect([...ours.headers.keys()].sort()).toEqual([...theirs.headers.keys()].sort());
    for (const name of ["content-type", "cache-control", "x-content-type-options"]) expect(ours.headers.get(name)).toBe(theirs.headers.get(name));
  });
});
