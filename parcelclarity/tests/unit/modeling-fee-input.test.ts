import { describe, expect, it } from "vitest";
import type { CompactResult, FoldShipment } from "@/engine/modeling";
import { buildOrderFeeInput, buildOrderShippingInput, createApportionment, orderMonthOf, type OrderContentSource } from "@/lib/modeling/fee-input";

/**
 * The pure helpers that turn batch rows into the fee engine's input. Apportionment expectations are
 * derived by hand: ordinal i goes to the row furthest behind its share, so over a run of N orders a
 * row with share p gets exactly N × p of them whenever that is a whole number.
 */

describe("createApportionment", () => {
  it("gives 60/40 shares exactly 6 and 4 of ordinals 1..10, interleaved", () => {
    const a = createApportionment([
      { units: 1, lines: 1, sharePct: "60.00" },
      { units: 3, lines: 2, sharePct: "40.00" },
    ]);
    const rows = Array.from({ length: 10 }, (_, i) => a.rowFor(i + 1));
    expect(rows.filter((r) => r === 0)).toHaveLength(6);
    expect(rows.filter((r) => r === 1)).toHaveLength(4);
    expect(rows).toEqual([0, 1, 0, 1, 0, 0, 1, 0, 1, 0]);
  });

  it("depends only on the ordinal, so a run split into batches or resumed assigns the same rows", () => {
    const rows = [
      { units: 1, lines: 1, sharePct: "50.00" },
      { units: 2, lines: 2, sharePct: "30.00" },
      { units: 5, lines: 3, sharePct: "20.00" },
    ];
    const whole = createApportionment(rows);
    const sequence = Array.from({ length: 10 }, (_, i) => whole.rowFor(i + 1));
    expect(sequence.filter((r) => r === 0)).toHaveLength(5);
    expect(sequence.filter((r) => r === 1)).toHaveLength(3);
    expect(sequence.filter((r) => r === 2)).toHaveLength(2);
    // A fresh instance asked for one ordinal out of order answers the same as the sequence did.
    for (const ordinal of [7, 3, 10, 1]) expect(createApportionment(rows).rowFor(ordinal)).toBe(sequence[ordinal - 1]);
    // Asking again never changes an answer.
    expect(Array.from({ length: 10 }, (_, i) => whole.rowFor(i + 1))).toEqual(sequence);
  });

  it("never lets a row drift more than one order from its share at any point of the sequence", () => {
    const shares = ["12.50", "37.50", "25.00", "25.00"];
    const a = createApportionment(shares.map((sharePct, i) => ({ units: i + 1, lines: 1, sharePct })));
    const counts = shares.map(() => 0);
    for (let i = 1; i <= 1000; i++) {
      const row = a.rowFor(i);
      counts[row] = (counts[row] ?? 0) + 1;
      for (let r = 0; r < shares.length; r++) expect(Math.abs(counts[r]! - (i * Number(shares[r])) / 100)).toBeLessThan(1);
    }
    expect(counts).toEqual([125, 375, 250, 250]);
  });

  it("refuses shares that do not add up to 100.00 or carry more than two decimals, and ordinals below one", () => {
    expect(() => createApportionment([{ units: 1, lines: 1, sharePct: "60.00" }])).toThrow(/not 100\.00%/);
    expect(() => createApportionment([{ units: 1, lines: 1, sharePct: "33.333" }, { units: 1, lines: 1, sharePct: "66.667" }])).toThrow(/two decimals/);
    expect(() => createApportionment([])).toThrow(/at least one row/);
    const a = createApportionment([{ units: 1, lines: 1, sharePct: "100.00" }]);
    expect(() => a.rowFor(0)).toThrow(/positive whole number/);
    expect(() => a.rowFor(1.5)).toThrow(/positive whole number/);
    expect(a.rowFor(1)).toBe(0);
  });
});

function result(opts: { definite: string; estimated?: string; conditional?: string; unresolved?: string; lines?: CompactResult["lines"]; status?: "ok" | "unavailable" }): CompactResult {
  const definite = opts.definite;
  const estimated = opts.estimated ?? "0.00";
  return {
    status: opts.status ?? "ok",
    unavailableReason: opts.status === "unavailable" ? "no_rate_for_weight" : null,
    rateCardVersionId: "rcv-1",
    shipDate: "2026-03-15",
    zone: "5",
    serviceId: "svc-1",
    billableLb: ["1"],
    definite,
    estimated,
    expected: (Number(definite) + Number(estimated)).toFixed(2),
    conditionalExposure: opts.conditional ?? "0.00",
    unresolved: opts.unresolved ?? "0.00",
    lines: opts.lines ?? [[0, Math.round(Number(definite) * 100), "c", "d", 0]],
    warningCodes: [],
  };
}

function ship(rowNo: number, r: CompactResult | null, excludedReason: FoldShipment["excludedReason"] = null): FoldShipment {
  return { rowNo, packageCount: 1, serviceId: "svc-1", serviceName: "Ground", carrierCode: "ups", excludedReason, result: r, assumed: { residential: false, originZip: false, weight: false, dimensions: false }, packagesWithoutDimensions: 0 };
}

describe("buildOrderShippingInput", () => {
  it("sums the order's counted shipping in E4, keeps base freight to the base and minimum-charge lines, and flags estimates and exposure", () => {
    const shipping = buildOrderShippingInput([
      // $10.00 base + $1.50 fuel (definite), one $0.40 minimum-charge adjustment.
      ship(1, result({ definite: "11.90", lines: [[0, 1000, "c", "d", 0], [1, 40, "c", "d", 0], [2, 150, "c", "d", 0]] })),
      // $8.00 base definite, $2.50 estimated residential, a $3.00 conditional line that is not counted.
      ship(2, result({ definite: "8.00", estimated: "2.50", conditional: "3.00", lines: [[0, 800, "c", "d", 0], [3, 250, "c", "e", 0], [4, 300, "n", "c", 0]] })),
    ]);
    expect(shipping).toEqual({ totalE4: 224000, baseFreightE4: 184000, estimated: true, hasExposure: true });
    const plain = buildOrderShippingInput([ship(1, result({ definite: "10.00" }))]);
    expect(plain).toEqual({ totalE4: 100000, baseFreightE4: 100000, estimated: false, hasExposure: false });
    expect(buildOrderShippingInput([ship(1, result({ definite: "10.00", unresolved: "1.25" }))])?.hasExposure).toBe(true);
  });

  it("is null when any shipment of the order was not priced ok", () => {
    expect(buildOrderShippingInput([ship(1, result({ definite: "10.00" })), ship(2, result({ definite: "0.00", status: "unavailable" }))])).toBeNull();
    expect(buildOrderShippingInput([ship(1, null, "weight_missing")])).toBeNull();
    expect(buildOrderShippingInput([ship(1, null, "order_cancelled"), ship(2, result({ definite: "10.00" }))])).toBeNull();
  });
});

describe("buildOrderFeeInput", () => {
  const source: OrderContentSource = { orderUnits: 3, orderLines: 2, orderSkus: 2, orderShipments: 1, orderSeq: 7, packages: [{ packagingTypeNormalized: "box" }, { packagingTypeNormalized: null }] };
  const content = createApportionment([
    { units: 1, lines: 1, sharePct: "60.00" },
    { units: 5, lines: 3, sharePct: "40.00" },
  ]);
  const shipping = { totalE4: 100000, baseFreightE4: 100000, estimated: false, hasExposure: false };

  it("takes every quantity from the file when the file has it, with nothing assumed", () => {
    expect(buildOrderFeeInput(source, shipping, content)).toEqual({ units: 3, lines: 2, distinctSkus: 2, packages: [{ packagingType: "box" }, { packagingType: null }], shipments: 1, shipping, assumed: {}, ordinal: 7 });
  });

  it("leaves unknown quantities null when nothing was assumed, so the engine reports them as not computed", () => {
    expect(buildOrderFeeInput({ ...source, orderUnits: null, orderLines: null, orderSkus: null }, null, null)).toEqual({ units: null, lines: null, distinctSkus: null, packages: [{ packagingType: "box" }, { packagingType: null }], shipments: 1, shipping: null, assumed: {}, ordinal: 7 });
  });

  it("takes units, lines and products from the apportioned content row when the file has none, flagging each as assumed", () => {
    // Ordinal 7 falls on the 40% row (see the apportionment test): 5 units, 3 lines, 3 products.
    expect(buildOrderFeeInput({ ...source, orderUnits: null, orderLines: null, orderSkus: null }, shipping, content)).toMatchObject({ units: 5, lines: 3, distinctSkus: 3, assumed: { units: true, lines: true, skus: true } });
    // Ordinal 1 falls on the 60% row.
    expect(buildOrderFeeInput({ ...source, orderUnits: null, orderLines: null, orderSkus: null, orderSeq: 1 }, shipping, content)).toMatchObject({ units: 1, lines: 1, distinctSkus: 1, assumed: { units: true, lines: true, skus: true } });
  });

  it("keeps the file's item count and assumes only the lines when the file has item counts but no line data, never more lines than items", () => {
    expect(buildOrderFeeInput({ ...source, orderUnits: 2, orderLines: null, orderSkus: null }, shipping, content)).toMatchObject({ units: 2, lines: 2, distinctSkus: 2, assumed: { lines: true, skus: true } });
    expect(buildOrderFeeInput({ ...source, orderUnits: 0, orderLines: null, orderSkus: null }, shipping, content)).toMatchObject({ units: 0, lines: 0, distinctSkus: 0, assumed: { lines: true, skus: true } });
    expect(buildOrderFeeInput({ ...source, orderUnits: 9, orderLines: null, orderSkus: null }, shipping, content)).toMatchObject({ units: 9, lines: 3, distinctSkus: 3, assumed: { lines: true, skus: true } });
  });

  it("never assumes lines when the file has line data, even when the item count is assumed", () => {
    expect(buildOrderFeeInput({ ...source, orderUnits: null, orderLines: 2, orderSkus: 1 }, shipping, content)).toMatchObject({ units: 5, lines: 2, distinctSkus: 1, assumed: { units: true } });
  });

  it("refuses an order without an ordinal", () => {
    expect(() => buildOrderFeeInput({ ...source, orderSeq: null }, shipping, null)).toThrow(/ordinal/);
    expect(() => buildOrderFeeInput({ ...source, orderSeq: 0 }, shipping, null)).toThrow(/ordinal/);
  });
});

describe("orderMonthOf", () => {
  it("reads the order date, else the first ship date, as written", () => {
    expect(orderMonthOf("2026-03-14", "2026-03-20")).toBe("2026-03");
    expect(orderMonthOf(null, "2026-04-02")).toBe("2026-04");
    expect(orderMonthOf(null, null)).toBeNull();
    expect(orderMonthOf("March", null)).toBeNull();
  });
});
