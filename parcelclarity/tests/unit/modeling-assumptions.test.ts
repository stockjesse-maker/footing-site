import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FulfillmentStep } from "@/components/modeling/fulfillment-step";
import { D } from "@/engine/money";
import {
  averageToContentRows,
  canonicaliseAssumptions,
  derivePeriodVolume,
  describePeriodVolume,
  diffAssumptions,
  formatAssumptionDiff,
  fulfillmentFromState,
  fulfillmentProblemFromSql,
  initialFulfillmentState,
  normaliseDecimalText,
  parseFulfillmentField,
  runAssumptionsSchema,
  scheduleReadsOrderContent,
  type FormQuestion,
  type FulfillmentFormContext,
  type FulfillmentFormState,
  type RunSetupPeriod,
} from "@/lib/modeling/assumptions";
import { fulfillmentAnswersSchema } from "@/lib/fees/schema";
import type { FeeRule } from "@/engine/fees/types";
import { loadRunSetupData } from "@/lib/modeling/queries";

// queries.ts is a server-only module; the marker package refuses to load outside a server build.
vi.mock("server-only", () => ({}));

/**
 * Run assumptions: the canonical form, the rerun diff, the schema that must refuse what
 * app.validate_fulfillment refuses, and the pure model behind run setup step 2. Expectations are
 * derived by hand (e.g. an average of 1.4 items on 1.2 lines per order is 60 % of orders with 1 item
 * on 1 line, 20 % with 2 items on 1 line and 20 % with 2 items on 2 lines: .6+.4+.4 = 1.4 items and
 * .6+.2+.4 = 1.2 lines).
 */

const text = (v: unknown) => JSON.stringify(v);

describe("canonicaliseAssumptions", () => {
  const rich = {
    overrideAllServices: false,
    residentialDefault: true,
    originZipDefault: "90001",
    fulfillment: {
      orderContent: {
        rows: [
          { units: 1, lines: 1, sharePct: "60.00" },
          { units: 3, lines: 2, sharePct: "40.0" },
        ],
      },
      packagingDefault: "  Poly   Mailer ",
      orderShares: { inserts: { sharePct: "40.50", countPerOrder: 2 }, kits: null },
      drivers: { pallets: "12.0", bins: "0.50", returns: "00004.370", unsure: null, none: "0" },
      monthlyOrders: "1250.00",
    },
  };

  it("is idempotent", () => {
    const once = canonicaliseAssumptions(rich);
    expect(canonicaliseAssumptions(once)).toEqual(once);
    expect(text(canonicaliseAssumptions(once))).toBe(text(once));
  });

  it("does not depend on the order keys were written in", () => {
    const shuffled = {
      fulfillment: {
        monthlyOrders: "1250.00",
        drivers: { unsure: null, returns: "00004.370", none: "0", bins: "0.50", pallets: "12.0" },
        orderShares: { kits: null, inserts: { countPerOrder: 2, sharePct: "40.50" } },
        packagingDefault: "poly mailer",
        orderContent: {
          rows: [
            { sharePct: "60.00", lines: 1, units: 1 },
            { sharePct: "40.0", lines: 2, units: 3 },
          ],
        },
      },
      originZipDefault: "90001",
      residentialDefault: true,
      overrideAllServices: false,
    };
    expect(text(canonicaliseAssumptions(shuffled))).toBe(text(canonicaliseAssumptions(rich)));
  });

  it("writes keys sorted at every level", () => {
    const c = canonicaliseAssumptions(rich);
    expect(Object.keys(c)).toEqual(["fulfillment", "originZipDefault", "overrideAllServices", "residentialDefault"]);
    expect(Object.keys(c.fulfillment!)).toEqual(["drivers", "monthlyOrders", "orderContent", "orderShares", "packagingDefault"]);
    expect(Object.keys(c.fulfillment!.drivers!)).toEqual(["bins", "none", "pallets", "returns", "unsure"]);
    expect(Object.keys(c.fulfillment!.orderShares!.inserts!)).toEqual(["countPerOrder", "sharePct"]);
  });

  it('treats "12.0" and "12" as the same answer, and normalises every decimal string', () => {
    const a = canonicaliseAssumptions({ fulfillment: { drivers: { pallets: "12.0" } } });
    const b = canonicaliseAssumptions({ fulfillment: { drivers: { pallets: "12" } } });
    expect(a).toEqual(b);
    expect(a.fulfillment?.drivers?.pallets).toBe("12");
    const c = canonicaliseAssumptions(rich).fulfillment!;
    expect(c.monthlyOrders).toBe("1250");
    expect(c.drivers).toEqual({ bins: "0.5", none: "0", pallets: "12", returns: "4.37", unsure: null });
    expect(c.orderShares).toEqual({ inserts: { countPerOrder: 2, sharePct: "40.5" }, kits: null });
    expect(c.orderContent?.rows.map((r) => r.sharePct)).toEqual(["60", "40"]);
    expect(normaliseDecimalText("0.000")).toBe("0");
    expect(normaliseDecimalText(" 7.10 ")).toBe("7.1");
    // Text that is not a plain decimal is left for validation to refuse, never rewritten.
    expect(normaliseDecimalText("1,250")).toBe("1,250");
    expect(normaliseDecimalText("abc")).toBe("abc");
  });

  it("reads a JSON number where text is expected (a jsonb quirk) as the same decimal text", () => {
    const c = canonicaliseAssumptions({ fulfillment: { drivers: { pallets: 12.5 }, monthlyOrders: 1400 } });
    expect(c.fulfillment?.drivers?.pallets).toBe("12.5");
    expect(c.fulfillment?.monthlyOrders).toBe("1400");
  });

  it('keeps null answers: "not sure" is an answer, not an absence', () => {
    const c = canonicaliseAssumptions({ fulfillment: { drivers: { pallets: null }, orderShares: { inserts: null } } });
    expect(c.fulfillment?.drivers).toEqual({ pallets: null });
    expect(c.fulfillment?.orderShares).toEqual({ inserts: null });
    expect("pallets" in (c.fulfillment?.drivers ?? {})).toBe(true);
  });

  it("drops empty objects, and a fulfillment with nothing in it", () => {
    expect(canonicaliseAssumptions({ fulfillment: { drivers: {}, orderShares: {} } })).toEqual({});
    expect(canonicaliseAssumptions({ fulfillment: {} })).toEqual({});
    expect(canonicaliseAssumptions({ fulfillment: null })).toEqual({});
    expect(canonicaliseAssumptions({ fulfillment: { drivers: {}, monthlyOrders: "3000" } })).toEqual({ fulfillment: { monthlyOrders: "3000" } });
    expect(canonicaliseAssumptions({ fulfillment: { orderContent: { rows: [] } } })).toEqual({});
  });

  it("drops unset scalars inside fulfillment but keeps the shipping assumptions as given, nulls included", () => {
    const c = canonicaliseAssumptions({ residentialDefault: null, originZipDefault: null, overrideAllServices: false, fulfillment: { monthlyOrders: null, packagingDefault: null, orderContent: null, skip: false, drivers: { a: "1" } } });
    expect(c).toEqual({ fulfillment: { drivers: { a: "1" } }, originZipDefault: null, overrideAllServices: false, residentialDefault: null });
  });

  it("carries nothing but the switch when fulfillment costs are skipped, so a stale answer cannot fail validation or split identical runs", () => {
    expect(canonicaliseAssumptions({ fulfillment: { skip: true, drivers: { pallets: "12" }, monthlyOrders: "900" } })).toEqual({ fulfillment: { skip: true } });
  });

  it("keeps the order of content rows (ties of the apportionment go to the earlier row) and reads whole numbers typed as text", () => {
    const c = canonicaliseAssumptions({
      fulfillment: {
        orderContent: {
          rows: [
            { units: "3", lines: "2", sharePct: "40" },
            { units: 1, lines: 1, sharePct: "60" },
          ],
        },
      },
    });
    expect(c.fulfillment?.orderContent?.rows).toEqual([
      { lines: 2, sharePct: "40", units: 3 },
      { lines: 1, sharePct: "60", units: 1 },
    ]);
  });

  it("normalises the packaging default like the engine does", () => {
    expect(canonicaliseAssumptions({ fulfillment: { packagingDefault: "  Poly   Mailer " } }).fulfillment?.packagingDefault).toBe("poly mailer");
    expect(canonicaliseAssumptions({ fulfillment: { packagingDefault: "   " } })).toEqual({});
  });
});

describe("diffAssumptions", () => {
  const labels = { pallets: "Pallets stored", skus: "SKUs stored", inserts: "Inserts" };

  it('reads like the one-line diff above the button: "Changed: pallets stored 12 → 15; volume 1,250 → 1,400"', () => {
    const a = { fulfillment: { drivers: { pallets: "12" }, monthlyOrders: "1250" } };
    const b = { fulfillment: { drivers: { pallets: "15" }, monthlyOrders: "1400" } };
    const lines = diffAssumptions(a, b, { labels });
    expect(lines).toEqual(["pallets stored 12 → 15", "volume 1,250 → 1,400"]);
    expect(formatAssumptionDiff(lines)).toBe("Changed: pallets stored 12 → 15; volume 1,250 → 1,400");
  });

  it("says there is no change for the same answers however they were written", () => {
    const lines = diffAssumptions({ fulfillment: { drivers: { pallets: "12.0", a: null }, monthlyOrders: "1250.00" } }, { fulfillment: { monthlyOrders: "1250", drivers: { a: null, pallets: "12" } } }, { labels });
    expect(lines).toEqual([]);
    expect(formatAssumptionDiff(lines)).toBe("No changes from the last run.");
  });

  it("does not count an unanswered question against a left-out one (neither is included)", () => {
    expect(diffAssumptions({ fulfillment: { drivers: { pallets: "1" } } }, { fulfillment: { drivers: { pallets: "1", skus: null } } }, { labels })).toEqual([]);
  });

  it("describes answers in words: a number, left out, and none", () => {
    expect(diffAssumptions({ fulfillment: { drivers: { pallets: "12", skus: null } } }, { fulfillment: { drivers: { pallets: null, skus: "0" } } }, { labels })).toEqual(["pallets stored 12 → left out", "SKUs stored left out → none"]);
    expect(diffAssumptions({ fulfillment: { drivers: { pallets: "1250" } } }, { fulfillment: { drivers: { pallets: "1250.5" } } }, { labels })).toEqual(["pallets stored 1,250 → 1,250.5"]);
  });

  it("keeps an acronym's capitals, and never prints a key where a label is missing (it humanises it)", () => {
    expect(diffAssumptions({ fulfillment: { drivers: { skus: "10" } } }, { fulfillment: { drivers: { skus: "12" } } }, { labels })).toEqual(["SKUs stored 10 → 12"]);
    expect(diffAssumptions({ fulfillment: { drivers: { cubic_feet: "10" } } }, { fulfillment: { drivers: { cubic_feet: "12" } } })).toEqual(["cubic feet 10 → 12"]);
    // With labels supplied (every customer screen) a key that has no label is never printed.
    expect(diffAssumptions({ fulfillment: { drivers: { cubic_feet: "10" } } }, { fulfillment: { drivers: { cubic_feet: "12" } } }, { labels })).toEqual(["a fulfillment answer 10 → 12"]);
  });

  it("reports an order-share answer with its count", () => {
    const lines = diffAssumptions({ fulfillment: { orderShares: { inserts: { sharePct: "40", countPerOrder: 2 } } } }, { fulfillment: { orderShares: { inserts: { sharePct: "50.0", countPerOrder: 2 } } } }, { labels });
    expect(lines).toEqual(["inserts 40% of orders × 2 → 50% of orders × 2"]);
    expect(diffAssumptions({ fulfillment: { orderShares: { inserts: { sharePct: "40", countPerOrder: 2 } } } }, { fulfillment: { orderShares: { inserts: { sharePct: "0", countPerOrder: 1 } } } }, { labels })).toEqual(["inserts 40% of orders × 2 → none"]);
  });

  it("says when the volume comes from the file and when it was stated", () => {
    expect(diffAssumptions({ fulfillment: { drivers: { pallets: "1" } } }, { fulfillment: { drivers: { pallets: "1" }, monthlyOrders: "3000" } })).toEqual(["volume from your file → 3,000"]);
  });

  it("reports packaging, order content and the shipping assumptions", () => {
    const a = { residentialDefault: true, originZipDefault: "90001", overrideAllServices: false, fulfillment: { packagingDefault: "poly mailer", orderContent: { rows: [{ units: 1, lines: 1, sharePct: "100" }] } } };
    const b = { residentialDefault: false, originZipDefault: "60601", overrideAllServices: true, fulfillment: { orderContent: { rows: [{ units: 1, lines: 1, sharePct: "60" }, { units: 3, lines: 2, sharePct: "40" }] } } };
    expect(diffAssumptions(a, b)).toEqual([
      "default packaging poly mailer → left out",
      "order content 100% 1 item on 1 line → 60% 1 item on 1 line, 40% 3 items on 2 lines",
      "delivery type home deliveries → business deliveries",
      "ship-from ZIP 90001 → 60601",
      "every shipment on one service off → on",
    ]);
  });

  it("reports only the switch when fulfillment costs are skipped or included again", () => {
    const answered = { fulfillment: { drivers: { pallets: "12" }, monthlyOrders: "1250" } };
    expect(diffAssumptions(answered, { fulfillment: { skip: true } }, { labels })).toEqual(["fulfillment costs included → skipped"]);
    expect(diffAssumptions({ fulfillment: { skip: true } }, answered, { labels })).toEqual(["fulfillment costs skipped → included"]);
    expect(diffAssumptions({ fulfillment: { skip: true } }, { fulfillment: { skip: true, drivers: { pallets: "3" } } })).toEqual([]);
  });

  it("treats a run with no answers on one side as every answer being new", () => {
    expect(diffAssumptions(undefined, { fulfillment: { drivers: { pallets: "5" } } }, { labels })).toEqual(["pallets stored left out → 5"]);
  });
});

describe("the schema refuses what app.validate_fulfillment refuses", () => {
  const ok = { monthlyOrders: "1250", drivers: { pallets: "12", skus: null }, orderShares: { inserts: { sharePct: "40", countPerOrder: 2 } }, packagingDefault: "poly mailer", orderContent: { rows: [{ units: 1, lines: 1, sharePct: "100.00" }] } };
  const refused = (f: unknown) => fulfillmentAnswersSchema.safeParse(f).success === false;

  it("accepts a complete, valid set of answers", () => {
    expect(fulfillmentAnswersSchema.safeParse(ok).success).toBe(true);
    expect(fulfillmentAnswersSchema.safeParse({ skip: true }).success).toBe(true);
    expect(fulfillmentAnswersSchema.safeParse({}).success).toBe(true);
  });

  it("refuses an unknown key (at the top, in an order share, in a content row)", () => {
    expect(refused({ ...ok, surprise: 1 })).toBe(true);
    expect(refused({ orderShares: { inserts: { sharePct: "40", countPerOrder: 2, extra: 1 } } })).toBe(true);
    expect(refused({ orderContent: { rows: [{ units: 1, lines: 1, sharePct: "100", extra: 1 }] } })).toBe(true);
    expect(refused({ orderContent: { rows: [{ units: 1, lines: 1, sharePct: "100" }], extra: 1 } })).toBe(true);
  });

  it("refuses a share of orders over 100", () => {
    expect(refused({ orderShares: { inserts: { sharePct: "100.01", countPerOrder: 2 } } })).toBe(true);
    expect(fulfillmentAnswersSchema.safeParse({ orderShares: { inserts: { sharePct: "100", countPerOrder: 2 } } }).success).toBe(true);
    expect(fulfillmentAnswersSchema.safeParse({ orderShares: { inserts: { sharePct: "0", countPerOrder: 1 } } }).success).toBe(true);
  });

  it("refuses a count per order of 0 (and over 1000, and a fraction)", () => {
    expect(refused({ orderShares: { inserts: { sharePct: "40", countPerOrder: 0 } } })).toBe(true);
    expect(refused({ orderShares: { inserts: { sharePct: "40", countPerOrder: 1001 } } })).toBe(true);
    expect(refused({ orderShares: { inserts: { sharePct: "40", countPerOrder: 1.5 } } })).toBe(true);
    expect(fulfillmentAnswersSchema.safeParse({ orderShares: { inserts: { sharePct: "40", countPerOrder: 1000 } } }).success).toBe(true);
  });

  it("refuses order content whose shares do not add up to exactly 100.00", () => {
    const rows = (a: string, b: string) => ({ orderContent: { rows: [{ units: 1, lines: 1, sharePct: a }, { units: 2, lines: 1, sharePct: b }] } });
    expect(refused(rows("60.00", "39.99"))).toBe(true);
    expect(refused(rows("60.00", "40.01"))).toBe(true);
    expect(fulfillmentAnswersSchema.safeParse(rows("60.00", "40.00")).success).toBe(true);
    expect(fulfillmentAnswersSchema.safeParse(rows("60", "40.0")).success).toBe(true);
  });

  it("refuses a content row with more lines than items, or items without a line", () => {
    expect(refused({ orderContent: { rows: [{ units: 1, lines: 2, sharePct: "100" }] } })).toBe(true);
    expect(refused({ orderContent: { rows: [{ units: 2, lines: 0, sharePct: "100" }] } })).toBe(true);
    expect(fulfillmentAnswersSchema.safeParse({ orderContent: { rows: [{ units: 2, lines: 2, sharePct: "100" }] } }).success).toBe(true);
  });

  it("refuses 0 or more than 12 content rows, and numbers that are not numbers", () => {
    expect(refused({ orderContent: { rows: [] } })).toBe(true);
    const many = Array.from({ length: 13 }, () => ({ units: 1, lines: 1, sharePct: "7.69" }));
    expect(refused({ orderContent: { rows: many } })).toBe(true);
    expect(refused({ drivers: { pallets: "twelve" } })).toBe(true);
    expect(refused({ drivers: { pallets: "1,250" } })).toBe(true);
    expect(refused({ drivers: { pallets: 12 } })).toBe(true);
    expect(refused({ monthlyOrders: "0.5" })).toBe(true);
    expect(refused({ monthlyOrders: "5000001" })).toBe(true);
  });

  it("covers the whole run assumptions: a closed object around the fulfillment answers", () => {
    expect(runAssumptionsSchema.safeParse({ residentialDefault: null, originZipDefault: null, overrideAllServices: false, fulfillment: ok }).success).toBe(true);
    expect(runAssumptionsSchema.safeParse({ residentialDefault: true, originZipDefault: "90001" }).success).toBe(true);
    expect(runAssumptionsSchema.safeParse({ overrideAllServices: false, other: 1 }).success).toBe(false);
    expect(runAssumptionsSchema.safeParse({ originZipDefault: "9001" }).success).toBe(false);
    expect(runAssumptionsSchema.safeParse({ fulfillment: { ...ok, orderShares: { inserts: { sharePct: "101", countPerOrder: 2 } } } }).success).toBe(false);
  });
});

describe("parseFulfillmentField (what the run action does with the posted JSON)", () => {
  it("reads no field as a form without step 2, and a null as no answers", () => {
    expect(parseFulfillmentField(null)).toEqual({ ok: true, value: undefined });
    expect(parseFulfillmentField("null")).toEqual({ ok: true, value: undefined });
  });

  it("parses valid answers and returns them for canonicalisation", () => {
    const r = parseFulfillmentField(JSON.stringify({ drivers: { pallets: "12.0", skus: null }, monthlyOrders: "1400" }));
    expect(r).toEqual({ ok: true, value: { drivers: { pallets: "12.0", skus: null }, monthlyOrders: "1400" } });
    expect(r.ok && canonicaliseAssumptions({ fulfillment: r.value }).fulfillment?.drivers?.pallets).toBe("12");
  });

  it("refuses unreadable, oversized and non-text fields with a step-level message", () => {
    for (const raw of ["{not json", "x".repeat(20_001), 42, new File([], "a")]) {
      const r = parseFulfillmentField(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(Object.keys(r.errors)).toEqual(["fulfillment"]);
    }
  });

  it("keys schema refusals by control, prefixed with the step, and keeps a step-level message", () => {
    const r = parseFulfillmentField(JSON.stringify({ orderShares: { inserts: { sharePct: "140", countPerOrder: 0 } }, drivers: { pallets: "twelve" }, monthlyOrders: "0" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(["fulfillment", "fulfillment.drivers.pallets", "fulfillment.monthlyOrders", "fulfillment.orderShares.inserts"]);
    const unknown = parseFulfillmentField(JSON.stringify({ surprise: 1 }));
    expect(unknown.ok === false && Object.keys(unknown.errors)).toEqual(["fulfillment"]);
    const content = parseFulfillmentField(JSON.stringify({ orderContent: { rows: [{ units: 1, lines: 1, sharePct: "60" }] } }));
    expect(content.ok === false && content.errors["fulfillment.orderContent.rows"]).toMatch(/add up to 60\.00%/);
  });
});

describe("fulfillmentProblemFromSql (the database's own PC001 messages, mapped to step 2)", () => {
  it("maps each message app.validate_fulfillment and start_simulation_run raise about the answers", () => {
    expect(fulfillmentProblemFromSql("no fee schedule is in effect for this customer on that date")?.fulfillment).toMatch(/Choose another date in step 1, or skip/);
    expect(fulfillmentProblemFromSql("monthly orders must be between 1 and 5,000,000")).toMatchObject({ "fulfillment.monthlyOrders": "Monthly orders must be between 1 and 5,000,000." });
    expect(fulfillmentProblemFromSql("packaging default must be up to 60 characters")).toHaveProperty(["fulfillment.packagingDefault"]);
    expect(fulfillmentProblemFromSql("driver pallets is not a question of this fee schedule")?.fulfillment).toMatch(/Reload the page/);
    expect(fulfillmentProblemFromSql("order driver inserts is not a question of this fee schedule")?.fulfillment).toMatch(/Reload the page/);
    expect(fulfillmentProblemFromSql("a returns rate is a percent of orders (0–100)")?.fulfillment).toMatch(/0 to 100/);
    expect(fulfillmentProblemFromSql('long-term quantity for "Long-term storage" exceeds the total stored')?.fulfillment).toBe("The long-term quantity for Long-term storage cannot be more than the total stored.");
    expect(fulfillmentProblemFromSql("order content must list 1–12 rows")).toHaveProperty(["fulfillment.orderContent.rows"]);
    expect(fulfillmentProblemFromSql("each order content row needs whole units, lines (1 to units) and a share of orders")?.["fulfillment.orderContent.rows"]).toMatch(/Each order content row/);
    expect(fulfillmentProblemFromSql("order content shares must add up to exactly 100.00")?.["fulfillment.orderContent.rows"]).toBe("Order content shares must add up to exactly 100.00%.");
    for (const m of ["fulfillment assumptions must be an object", "fulfillment assumptions are too large", "fulfillment assumptions carry an unknown field", "skip must be true or false", "drivers must be an object", "orderShares must be an object"]) {
      expect(fulfillmentProblemFromSql(m), m).toEqual({ fulfillment: "Your fulfillment answers could not be read. Reload the page and try again." });
    }
  });

  it("marks the question an answer-specific message names, without putting its key on screen", () => {
    for (const m of ["answer for pallets must be a number", "answer for pallets is out of range", "answer for pallets needs a share of orders (0–100) and a whole count per order (1–1000)"]) {
      const r = fulfillmentProblemFromSql(m)!;
      expect(Object.keys(r).sort(), m).toEqual(["fulfillment", "fulfillment.drivers.pallets", "fulfillment.orderShares.pallets"]);
      expect(r.fulfillment).not.toContain("pallets");
      expect(r["fulfillment.drivers.pallets"]).not.toContain("pallets");
    }
  });

  it("leaves every other message to the generic handling", () => {
    for (const m of ["invalid assumptions", "orders file is not ready", "rate card is not assigned to this customer", "a run with different settings is already in progress", "scenario not found"]) {
      expect(fulfillmentProblemFromSql(m), m).toBeNull();
    }
  });
});

describe("averageToContentRows", () => {
  const mean = (rows: { units: number; lines: number; sharePct: string }[], field: "units" | "lines") => rows.reduce((sum, r) => sum.plus(new D(r[field]).times(r.sharePct).div(100)), new D(0));
  const sharesTotal = (rows: { sharePct: string }[]) => rows.reduce((sum, r) => sum.plus(r.sharePct), new D(0));

  it("splits 1.4 items on 1.4 lines into two rows: 60 % with 1 and 40 % with 2", () => {
    expect(averageToContentRows("1.4", "1.4")).toEqual({
      ok: true,
      rows: [
        { units: 1, lines: 1, sharePct: "60.00" },
        { units: 2, lines: 2, sharePct: "40.00" },
      ],
    });
  });

  it("splits a whole-number average of lines into two rows", () => {
    expect(averageToContentRows("1.4", "1")).toEqual({
      ok: true,
      rows: [
        { units: 1, lines: 1, sharePct: "60.00" },
        { units: 2, lines: 1, sharePct: "40.00" },
      ],
    });
  });

  it("uses three coupled rows when the fractions differ, and still reproduces both averages exactly", () => {
    expect(averageToContentRows("1.4", "1.2")).toEqual({
      ok: true,
      rows: [
        { units: 1, lines: 1, sharePct: "60.00" },
        { units: 2, lines: 1, sharePct: "20.00" },
        { units: 2, lines: 2, sharePct: "20.00" },
      ],
    });
  });

  it("gives one row for a whole-number average", () => {
    expect(averageToContentRows("3", "2")).toEqual({ ok: true, rows: [{ units: 3, lines: 2, sharePct: "100.00" }] });
  });

  it("reproduces the averages exactly, never has more lines than items, and the shares total exactly 100.00", () => {
    const pairs: [string, string][] = [["1.4", "1.2"], ["2.1", "1.9"], ["1.9", "1.8"], ["2.0", "1.5"], ["1.3333", "1.0001"], ["12.75", "3.5"], ["1.0001", "1"], ["1", "1"], ["7.9999", "7.9999"], ["5.5", "5.25"]];
    for (const [u, l] of pairs) {
      const result = averageToContentRows(u, l);
      expect(result.ok, `${u}/${l}`).toBe(true);
      if (!result.ok) continue;
      expect(mean(result.rows, "units").toFixed(), `${u}/${l} items`).toBe(new D(u).toFixed());
      expect(mean(result.rows, "lines").toFixed(), `${u}/${l} lines`).toBe(new D(l).toFixed());
      expect(sharesTotal(result.rows).toFixed(2), `${u}/${l} total`).toBe("100.00");
      for (const r of result.rows) {
        expect(r.lines).toBeLessThanOrEqual(r.units);
        expect(r.lines).toBeGreaterThanOrEqual(1);
        expect(r.sharePct).toMatch(/^\d{1,3}\.\d{2}$/);
      }
      // The rows are what the database accepts.
      expect(fulfillmentAnswersSchema.safeParse({ orderContent: { rows: result.rows } }).success, `${u}/${l} schema`).toBe(true);
    }
  });

  it("refuses averages that cannot describe an order", () => {
    expect(averageToContentRows("1.2", "1.4")).toMatchObject({ ok: false, error: expect.stringContaining("more lines than items") });
    expect(averageToContentRows("0.5", "0.5")).toMatchObject({ ok: false });
    expect(averageToContentRows("2", "0")).toMatchObject({ ok: false });
    expect(averageToContentRows("", "1")).toMatchObject({ ok: false });
    expect(averageToContentRows("1.23456", "1")).toMatchObject({ ok: false });
    expect(averageToContentRows("1,5", "1")).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// Form state of step 2
// ---------------------------------------------------------------------------
const questions: FormQuestion[] = [
  { key: "pallets", label: "Pallets stored, on average", unit: "pallets", kind: "monthly_quantity", answers: "drivers", longTerm: null },
  { key: "long_pallets", label: "Pallets held longer than 90 days", unit: "pallets", kind: "monthly_quantity", answers: "drivers", longTerm: { mode: "replace", thresholdDays: 90, partOf: { key: "pallets", label: "Pallets stored, on average" } } },
  { key: "returns", label: "Share of orders returned", unit: "returns", kind: "returns_rate", answers: "drivers", longTerm: null },
  { key: "inserts", label: "Inserts", unit: "inserts", kind: "order_share", answers: "orderShares", longTerm: null },
];
const ctx: FulfillmentFormContext = { questions, canDeriveVolume: true, showPackaging: true, showContent: true };

function answered(patch: Partial<FulfillmentFormState> = {}): FulfillmentFormState {
  return {
    ...initialFulfillmentState(ctx, null),
    drivers: { pallets: { choice: "number", value: "12.0" }, long_pallets: { choice: "unsure", value: "" }, returns: { choice: "none", value: "" } },
    shares: { inserts: { choice: "number", sharePct: "40.00", count: "2" } },
    ...patch,
  };
}

describe("fulfillmentFromState", () => {
  it("opens with nothing chosen on a first run, so every question needs an answer before the run can start", () => {
    const state = initialFulfillmentState(ctx, null);
    const built = fulfillmentFromState(state, ctx);
    expect(Object.keys(built.errors).sort()).toEqual(["drivers.long_pallets", "drivers.pallets", "drivers.returns", "orderShares.inserts"]);
    expect(built.errors["drivers.pallets"]).toMatch(/Choose one/);
    expect(built.value).toEqual({});
  });

  it("blocks a blank number with the number choice selected", () => {
    const built = fulfillmentFromState(answered({ drivers: { pallets: { choice: "number", value: "  " }, long_pallets: { choice: "unsure", value: "" }, returns: { choice: "none", value: "" } } }), ctx);
    expect(built.errors).toEqual({ "drivers.pallets": "Enter a number, or choose one of the other answers." });
  });

  it('maps the three choices to a number, null ("not sure") and "0" ("we don\'t use this"), in canonical form', () => {
    const built = fulfillmentFromState(answered(), ctx);
    expect(built.errors).toEqual({});
    expect(built.value).toEqual({ drivers: { long_pallets: null, pallets: "12", returns: "0" }, orderShares: { inserts: { countPerOrder: 2, sharePct: "40" } } });
  });

  it("answers an order-share question with a share and a count, null, or an explicit zero share", () => {
    const none = fulfillmentFromState(answered({ shares: { inserts: { choice: "none", sharePct: "", count: "" } } }), ctx);
    expect(none.value.orderShares).toEqual({ inserts: { countPerOrder: 1, sharePct: "0" } });
    const unsure = fulfillmentFromState(answered({ shares: { inserts: { choice: "unsure", sharePct: "", count: "" } } }), ctx);
    expect(unsure.value.orderShares).toEqual({ inserts: null });
    const missingCount = fulfillmentFromState(answered({ shares: { inserts: { choice: "number", sharePct: "40", count: "" } } }), ctx);
    expect(missingCount.errors["orderShares.inserts"]).toMatch(/share of orders and how many/);
    const over = fulfillmentFromState(answered({ shares: { inserts: { choice: "number", sharePct: "140", count: "2" } } }), ctx);
    expect(over.errors["orderShares.inserts"]).toMatch(/between 0 and 100/);
    const zeroCount = fulfillmentFromState(answered({ shares: { inserts: { choice: "number", sharePct: "40", count: "0" } } }), ctx);
    expect(zeroCount.errors["orderShares.inserts"]).toMatch(/count per order/);
  });

  it("refuses a returns rate over 100 and a long-term quantity over the stored quantity", () => {
    const rate = fulfillmentFromState(answered({ drivers: { pallets: { choice: "number", value: "12" }, long_pallets: { choice: "unsure", value: "" }, returns: { choice: "number", value: "104.5" } } }), ctx);
    expect(rate.errors["drivers.returns"]).toMatch(/0 to 100/);
    const longTerm = fulfillmentFromState(answered({ drivers: { pallets: { choice: "number", value: "12" }, long_pallets: { choice: "number", value: "12.5" }, returns: { choice: "none", value: "" } } }), ctx);
    expect(longTerm.errors["drivers.long_pallets"]).toBe("This cannot be more than the total you entered for pallets stored, on average (12).");
    const fine = fulfillmentFromState(answered({ drivers: { pallets: { choice: "number", value: "12" }, long_pallets: { choice: "number", value: "12" }, returns: { choice: "none", value: "" } } }), ctx);
    expect(fine.errors).toEqual({});
  });

  it("turns off every check and carries only the switch when fulfillment costs are skipped", () => {
    const built = fulfillmentFromState(initialFulfillmentState(ctx, null), ctx);
    expect(Object.keys(built.errors).length).toBeGreaterThan(0);
    const skipped = fulfillmentFromState({ ...initialFulfillmentState(ctx, null), skip: true }, ctx);
    expect(skipped).toEqual({ value: { skip: true }, errors: {} });
  });

  it("states the volume only when the customer chose a different one (or when none can be derived)", () => {
    expect(fulfillmentFromState(answered({ volumeMode: "file", volume: "999" }), ctx).value.monthlyOrders).toBeUndefined();
    expect(fulfillmentFromState(answered({ volumeMode: "stated", volume: "1,400" }), ctx).errors.monthlyOrders).toMatch(/orders a month/);
    expect(fulfillmentFromState(answered({ volumeMode: "stated", volume: "" }), ctx).errors.monthlyOrders).toMatch(/Use this volume/);
    expect(fulfillmentFromState(answered({ volumeMode: "stated", volume: "1400.0" }), ctx).value.monthlyOrders).toBe("1400");
    expect(fulfillmentFromState(answered({ volumeMode: "stated", volume: "5000001" }), ctx).errors.monthlyOrders).toMatch(/between 1 and 5,000,000/);
    const noFileVolume: FulfillmentFormContext = { ...ctx, canDeriveVolume: false };
    expect(fulfillmentFromState(answered({ volume: "" }), noFileVolume).errors).toEqual({});
    expect(fulfillmentFromState(answered({ volume: "900" }), noFileVolume).value.monthlyOrders).toBe("900");
  });

  it("reads order content as rows or as an average, and refuses shares that do not add up", () => {
    const rows = fulfillmentFromState(
      answered({
        contentMode: "rows",
        contentRows: [
          { units: "1", lines: "1", sharePct: "60" },
          { units: "3", lines: "2", sharePct: "40.00" },
        ],
      }),
      ctx,
    );
    expect(rows.errors).toEqual({});
    expect(rows.value.orderContent).toEqual({
      rows: [
        { lines: 1, sharePct: "60", units: 1 },
        { lines: 2, sharePct: "40", units: 3 },
      ],
    });
    const off = fulfillmentFromState(answered({ contentMode: "rows", contentRows: [{ units: "1", lines: "1", sharePct: "60" }, { units: "3", lines: "2", sharePct: "30" }] }), ctx);
    expect(off.errors["orderContent.rows"]).toMatch(/add up to 90\.00%; they must add up to exactly 100\.00%/);
    const tooManyLines = fulfillmentFromState(answered({ contentMode: "rows", contentRows: [{ units: "1", lines: "2", sharePct: "100" }] }), ctx);
    expect(tooManyLines.errors["orderContent.rows.0.lines"]).toMatch(/more lines than items/);
    const blank = fulfillmentFromState(answered({ contentMode: "rows", contentRows: [{ units: "", lines: "", sharePct: "100" }] }), ctx);
    expect(blank.errors["orderContent.rows.0.units"]).toBeDefined();
    const average = fulfillmentFromState(answered({ contentMode: "average", averageUnits: "1.4", averageLines: "1.2" }), ctx);
    expect(average.errors).toEqual({});
    expect(average.value.orderContent?.rows).toEqual([
      { lines: 1, sharePct: "60", units: 1 },
      { lines: 1, sharePct: "20", units: 2 },
      { lines: 2, sharePct: "20", units: 2 },
    ]);
    expect(fulfillmentFromState(answered({ contentMode: "average", averageUnits: "1.2", averageLines: "1.4" }), ctx).errors["orderContent.average"]).toMatch(/more lines than items/);
    // Hidden questions are not asked and not sent.
    expect(fulfillmentFromState(answered({ contentMode: "rows", contentRows: [] }), { ...ctx, showContent: false }).value.orderContent).toBeUndefined();
  });

  it("sends the packaging default only when it is asked, and none for Not sure", () => {
    expect(fulfillmentFromState(answered({ packagingDefault: "poly mailer" }), ctx).value.packagingDefault).toBe("poly mailer");
    expect(fulfillmentFromState(answered({ packagingDefault: "" }), ctx).value.packagingDefault).toBeUndefined();
    expect(fulfillmentFromState(answered({ packagingDefault: "poly mailer" }), { ...ctx, showPackaging: false }).value.packagingDefault).toBeUndefined();
  });

  it("round-trips: a rerun opens with the previous answers and posts the very same canonical assumptions", () => {
    const first = fulfillmentFromState(
      answered({ volumeMode: "stated", volume: "1250.0", packagingDefault: "poly mailer", contentMode: "rows", contentRows: [{ units: "1", lines: "1", sharePct: "60.00" }, { units: "3", lines: "2", sharePct: "40.00" }] }),
      ctx,
    );
    expect(first.errors).toEqual({});
    const reopened = initialFulfillmentState(ctx, first.value);
    expect(reopened.drivers.pallets).toEqual({ choice: "number", value: "12" });
    expect(reopened.drivers.long_pallets).toEqual({ choice: "unsure", value: "" });
    expect(reopened.drivers.returns).toEqual({ choice: "none", value: "" });
    expect(reopened.shares.inserts).toEqual({ choice: "number", sharePct: "40", count: "2" });
    expect(reopened.volumeMode).toBe("stated");
    expect(reopened.volume).toBe("1250");
    expect(reopened.packagingDefault).toBe("poly mailer");
    expect(reopened.contentMode).toBe("rows");
    const second = fulfillmentFromState(reopened, ctx);
    expect(second.errors).toEqual({});
    expect(text(canonicaliseAssumptions({ fulfillment: second.value }))).toBe(text(canonicaliseAssumptions({ fulfillment: first.value })));
    expect(diffAssumptions({ fulfillment: first.value }, { fulfillment: second.value })).toEqual([]);
  });

  it("opens skipped when the previous run skipped, and leaves a new question unanswered", () => {
    expect(initialFulfillmentState(ctx, { skip: true }).skip).toBe(true);
    const state = initialFulfillmentState(ctx, { drivers: { pallets: "5" } });
    expect(state.drivers.pallets?.choice).toBe("number");
    expect(state.drivers.returns?.choice).toBeNull();
    expect(state.shares.inserts?.choice).toBeNull();
    expect(state.volumeMode).toBe("file");
    expect(initialFulfillmentState({ ...ctx, canDeriveVolume: false }, null).volumeMode).toBe("stated");
  });
});

// ---------------------------------------------------------------------------
// The volume sentence
// ---------------------------------------------------------------------------
const period = (patch: Partial<RunSetupPeriod> = {}): RunSetupPeriod => ({ population: 3770, dated: 3750, undated: 20, from: "2026-01-03", to: "2026-03-28", days: 85, months: "2.838710", inPeriod: 3740, trimmed: 10, ...patch });

describe("describePeriodVolume", () => {
  it("derives the monthly volume as the database does: orders in the period over the calendar months it covers", () => {
    // Jan 3–31 is 29/31, February 28/28, Mar 1–28 is 28/31 of a month: 2.838710 months. 2.83871 × 1,317.5 = 3,740.0003 > 3,740, so the volume is just under 1,317.5.
    const v = derivePeriodVolume(period());
    expect(v).toEqual({ ok: true, monthlyOrders: new D(3740).div("2.838710").toDecimalPlaces(4).toFixed() });
    expect(v.ok && v.monthlyOrders.startsWith("1317.4")).toBe(true);
  });

  it("writes the derivation with the trimmed and undated counts when they are not zero", () => {
    const d = describePeriodVolume(period());
    expect(d.sentence).toBe("Your file has 3,740 orders over Jan 3, 2026–Mar 28, 2026 (2.84 months): about 1,317 orders a month.");
    expect(d.notes).toEqual(["10 orders have dates far outside the rest and are left out of the period, so one stray date cannot stretch it.", "20 orders have no date and are not counted in the volume."]);
  });

  it("adds no notes when nothing was trimmed or undated, and says one month in the singular", () => {
    const d = describePeriodVolume(period({ trimmed: 0, undated: 0, from: "2026-01-01", to: "2026-01-31", days: 31, months: "1.000000", inPeriod: 1250 }));
    expect(d.sentence).toBe("Your file has 1,250 orders over Jan 1, 2026–Jan 31, 2026 (1 month): about 1,250 orders a month.");
    expect(d.notes).toEqual([]);
  });

  it("offers only a stated volume under 28 days, with no dates, or when the dates could not be read", () => {
    const short = describePeriodVolume(period({ from: "2026-01-01", to: "2026-01-14", days: 14, months: "0.451613", inPeriod: 400 }));
    expect(short.volume).toEqual({ ok: false, reason: "short" });
    expect(short.sentence).toMatch(/covers only 14 days/);
    const none = describePeriodVolume(period({ from: null, to: null, days: null, months: null, inPeriod: 0, dated: 0, population: 20 }));
    expect(none.volume).toEqual({ ok: false, reason: "no_dates" });
    expect(none.sentence).toMatch(/No order in your file has a usable date/);
    expect(describePeriodVolume(null).volume).toEqual({ ok: false, reason: "unreadable" });
    // Exactly 28 days is enough.
    expect(derivePeriodVolume(period({ from: "2026-02-01", to: "2026-02-28", days: 28, months: "1.000000", inPeriod: 700 }))).toEqual({ ok: true, monthlyOrders: "700" });
  });
});

describe("scheduleReadsOrderContent", () => {
  const rule = (patch: Partial<FeeRule>): FeeRule => ({ key: "r", name: "R", category: "pick_pack", scope: "order", basis: "order", method: "flat", amount: "1", percent: null, position: 1, ...patch });
  it("is true only when an order-scope rule reads items, lines or products", () => {
    expect(scheduleReadsOrderContent({ rules: [rule({ basis: "order" }), rule({ basis: "package" })] })).toBe(false);
    expect(scheduleReadsOrderContent({ rules: [rule({ basis: "unit" })] })).toBe(true);
    expect(scheduleReadsOrderContent({ rules: [rule({ basis: "sku" })] })).toBe(true);
    expect(scheduleReadsOrderContent({ rules: [rule({ basis: "order", conditions: { minUnits: 3 } })] })).toBe(true);
    expect(scheduleReadsOrderContent({ rules: [rule({ basis: "order_driver", includedQuantity: "1", includedPer: "line" })] })).toBe(true);
    expect(scheduleReadsOrderContent({ rules: [rule({ scope: "monthly", basis: "driver" })] })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadRunSetupData, with the database replaced by a stub
// ---------------------------------------------------------------------------
type Result = { data: unknown; error: { code?: string; message: string } | null };

/** A chainable, awaitable stand-in for a supabase-js query builder: every method returns the chain, awaiting it yields the result. */
function chain(result: Result) {
  const self: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "limit", "maybeSingle", "overrideTypes"]) self[m] = () => self;
  self.then = (resolve: (r: Result) => unknown) => resolve(result);
  return self;
}

function stubSupabase(o: { period?: Result; schedule?: Result; assignment?: Result; dataset?: Result; untyped?: Result }) {
  const tables: Record<string, Result> = {
    brand_fee_schedule_assignments: o.assignment ?? { data: { id: "a1", schedule_id: "s1", assigned_at: "2026-01-01T00:00:00Z", fee_schedules: { id: "s1", name: "Standard", description: null } }, error: null },
    order_datasets: o.dataset ?? { data: { line_count: 0, validation: { counts: { lines: 0, units: 0 } } }, error: null },
    packages: o.untyped ?? { data: [], error: null },
  };
  const rpcs: Record<string, Result> = {
    dataset_forecast_period: o.period ?? { data: { population: 10, dated: 10, undated: 0, from: "2026-01-01", to: "2026-01-31", days: 31, months: 1, inPeriod: 10, trimmed: 0 }, error: null },
    brand_fee_schedule_on: o.schedule ?? { data: { status: "no_schedule" }, error: null },
  };
  return {
    rpc: (name: string) => Promise.resolve(rpcs[name]),
    from: (table: string) => chain(tables[table]!),
  } as unknown as Parameters<typeof loadRunSetupData>[0];
}

const snapshotRules: FeeRule[] = [
  { id: "rule-id-1", key: "pick_first", name: "First pick", category: "pick_pack", scope: "order", basis: "unit", method: "flat", amount: "1.00", percent: null, includedQuantity: "1", includedPer: "order", position: 1 },
  { id: "rule-id-2", key: "storage_pallet", name: "Pallet storage", category: "storage", scope: "monthly", basis: "driver", method: "flat", amount: "18.00", percent: null, position: 2, helpText: "Pallets that hold your stock.", driver: { key: "pallets", label: "Pallets stored, on average", unit: "pallets", kind: "monthly_quantity" } },
  { id: "rule-id-3", key: "pack_poly", name: "Poly mailer", category: "packaging", scope: "order", basis: "package", method: "flat", amount: "0.40", percent: null, position: 3, conditions: { packagingTypes: ["poly mailer"] } },
  { id: "rule-id-4", key: "pack_other", name: "Other packaging", category: "packaging", scope: "order", basis: "package", method: "flat", amount: "0.90", percent: null, position: 4, conditions: { packagingTypes: ["*"] } },
];
const okSchedule: Result = { data: { status: "ok", snapshot: { scheduleId: "s1", name: "Standard", versionId: "v-secret", versionNumber: 7, effectiveDate: "2026-01-01", expirationDate: null, rounding: "invoice_line", rules: snapshotRules } }, error: null };

describe("loadRunSetupData", () => {
  it("shapes the questions, packaging types and period for the form, without versions, rule ids or notes", async () => {
    const data = await loadRunSetupData(
      stubSupabase({
        schedule: okSchedule,
        period: { data: { population: 3770, dated: 3750, undated: 20, from: "2026-01-03", to: "2026-03-28", days: 85, months: 2.83871, inPeriod: 3740, trimmed: 10 }, error: null },
        dataset: { data: { line_count: 5000, validation: { counts: { lines: 5000, units: 8000 } } }, error: null },
        untyped: { data: [{ id: "p1" }], error: null },
      }),
      "brand-1",
      "ds-1",
    );
    expect(data.period).toEqual({ population: 3770, dated: 3750, undated: 20, from: "2026-01-03", to: "2026-03-28", days: 85, months: "2.83871", inPeriod: 3740, trimmed: 10 });
    expect(data.hasUnits).toBe(true);
    expect(data.hasLines).toBe(true);
    expect(data.untypedPackages).toBe(true);
    expect(data.schedule.status).toBe("ok");
    if (data.schedule.status !== "ok") return;
    expect(data.schedule.name).toBe("Standard");
    expect(data.schedule.effectiveDate).toBe("2026-01-01");
    expect(data.schedule.packagingTypes).toEqual(["poly mailer"]);
    expect(data.schedule.readsOrderContent).toBe(true);
    expect(data.schedule.questions.map((q) => [q.key, q.label, q.answers])).toEqual([["pallets", "Pallets stored, on average", "drivers"]]);
    expect(data.schedule.questions[0]?.rules[0]).toMatchObject({ name: "Pallet storage", describe: "$18.00 per pallet per month" });
    const json = JSON.stringify(data);
    for (const hidden of ["v-secret", "versionNumber", "versionId", "rule-id-", "storage_pallet", "pick_first"]) expect(json).not.toContain(hidden);
  });

  it("reports no schedule, a schedule with no version in effect, and a failed load, never as no fees", async () => {
    expect((await loadRunSetupData(stubSupabase({ schedule: { data: { status: "no_schedule" }, error: null } }), "b", "d")).schedule).toEqual({ status: "none" });
    const notEffective = await loadRunSetupData(stubSupabase({ schedule: { data: { status: "not_effective", scheduleId: "s1", name: "Standard" }, error: null } }), "b", "d");
    expect(notEffective.schedule).toEqual({ status: "not_effective", name: "Standard" });
    const failed = await loadRunSetupData(stubSupabase({ schedule: { data: null, error: { code: "XX000", message: "boom" } } }), "b", "d");
    expect(failed.schedule).toEqual({ status: "unavailable" });
  });

  it("reports an unreadable period as null (the form then asks for a stated volume), not as an empty file", async () => {
    const data = await loadRunSetupData(stubSupabase({ period: { data: null, error: { message: "boom" } } }), "b", "d");
    expect(data.period).toBeNull();
    expect(describePeriodVolume(data.period).volume).toEqual({ ok: false, reason: "unreadable" });
  });

  it("reads what the file says from the validation counts, and asks about packaging when the check cannot be made", async () => {
    const none = await loadRunSetupData(stubSupabase({ dataset: { data: { line_count: 0, validation: { counts: { lines: 0, units: 0 } } }, error: null }, untyped: { data: [], error: null } }), "b", "d");
    expect([none.hasUnits, none.hasLines, none.untypedPackages]).toEqual([false, false, false]);
    const noValidation = await loadRunSetupData(stubSupabase({ dataset: { data: { line_count: 12, validation: null }, error: null } }), "b", "d");
    expect([noValidation.hasUnits, noValidation.hasLines]).toEqual([false, true]);
    const unknown = await loadRunSetupData(stubSupabase({ dataset: { data: null, error: null }, untyped: { data: null, error: { message: "boom" } } }), "b", "d");
    expect([unknown.hasUnits, unknown.hasLines, unknown.untypedPackages]).toEqual([false, false, true]);
  });
});

describe("FulfillmentStep: order content errors belong to the boxes they are about", () => {
  const ctx: FulfillmentFormContext = { questions: [], canDeriveVolume: true, showPackaging: false, showContent: true };
  const base = initialFulfillmentState(ctx, null);
  const step = (state: FulfillmentFormState, errors: Record<string, string>) =>
    renderToStaticMarkup(
      createElement(FulfillmentStep, { id: "x", audience: "brand", schedule: { name: "Standard", effectiveDate: "2026-01-01", questions: [], packagingTypes: [] }, period: null, showPackaging: false, showContent: true, state, setState: () => {}, errors, headingRef: createRef<HTMLHeadingElement>() }),
    );
  const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length;

  it("shares that do not add up to 100.00 mark every share box and point at the one message that exists", () => {
    const html = step({ ...base, contentMode: "rows", contentRows: [{ units: "1", lines: "1", sharePct: "60" }, { units: "2", lines: "1", sharePct: "30" }] }, { "orderContent.rows": "Order content shares must add up to exactly 100.00%." });
    expect(count(html, /aria-invalid="true"/g)).toBe(2);
    expect(count(html, /aria-describedby="x-rows-err"/g)).toBe(2);
    expect(html).toContain('id="x-rows-err"');
  });

  it("an average that cannot be turned into rows marks both boxes, so the first one can be focused", () => {
    const html = step({ ...base, contentMode: "average", averageUnits: "1", averageLines: "2" }, { "orderContent.average": "An order cannot have more lines than items." });
    expect(count(html, /aria-invalid="true"/g)).toBe(2);
    expect(count(html, /aria-describedby="x-avg-err"/g)).toBe(2);
    expect(html).toContain('id="x-avg-err"');
    expect(count(step({ ...base, contentMode: "average" }, {}), /aria-invalid/g)).toBe(0);
  });
});
