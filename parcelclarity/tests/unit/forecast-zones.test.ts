import { describe, expect, it } from "vitest";
import { contentRows } from "@/engine/forecast";
import { X } from "@/engine/forecast/grid";
import type { RateRow, ZoneRow } from "@/engine/types";
import { resolveZone } from "@/engine/zones";
import { describeShareSum, spreadEvenly, sumShares } from "@/components/forecast/forecast-model";
import { ALL_ZONES, originOnChart, prefixToZip, representativeZips, zonesFromRows } from "@/lib/forecast/zone-model";
import { averageToContentRows } from "@/lib/modeling/assumptions";
import { fixtureContext } from "../fixtures/pricing/load";

/**
 * The pure parts of the forecast screens: which representative ZIP stands for each zone, which zones
 * a service prices from an origin, "spread evenly" and the live "sums to X%" arithmetic, and how an
 * average becomes the exact two-point rows the engine prices. Expectations were worked out by hand
 * from the fictional fixture zone chart (tests/fixtures/pricing/fixture-zone-chart.csv):
 *   UPS from 900xx: zone 2 = 900–935, 3 = 936–961, 4 = 962–994, 8 = 995–999 and 005–299,
 *   5 = 800–899, 6 = 600–799, 7 = 300–599; one 5-digit row sends 903 from 90210 to zone 3.
 */
const card = fixtureContext().rateCard;
const UPS_GROUND = "svc-ups-ground";
const USPS_GA = "svc-usps-ga";

describe("representative destination ZIPs", () => {
  it("pads a destination prefix to a 5-digit ZIP", () => {
    expect(prefixToZip("901")).toBe("90100");
    expect(prefixToZip("005")).toBe("00500");
    expect(prefixToZip("90210")).toBe("90210");
  });

  it("picks the lowest destination prefix of each zone for the origin, padded to 5 digits", () => {
    expect(representativeZips(card.zones, "ups", "default", "90001")).toEqual({
      "2": "90000",
      "3": "93600",
      "4": "96200",
      "5": "80000",
      // Zone 8 has two ranges (995–999 and 005–299): the lowest prefix is 005.
      "8": "00500",
      "6": "60000",
      "7": "30000",
    });
  });

  it("gives every ZIP back through the same lookup the engine prices with", () => {
    for (const carrier of ["ups", "usps"]) {
      const zips = representativeZips(card.zones, carrier, "default", "90001");
      expect(Object.keys(zips).length).toBe(7);
      for (const [zone, zip] of Object.entries(zips)) {
        expect(zip).toMatch(/^\d{5}$/);
        const found = resolveZone(card.zones, carrier, "default", "90001", zip);
        expect(found.ok && found.zone.zone).toBe(zone);
      }
    }
  });

  it("uses the origin's own chart rows only: a 5-digit origin row that sends 903 to zone 3 is the whole chart for 90210", () => {
    // 90210 starts with 902, not 900, so none of the 900-prefix rows apply to it.
    expect(representativeZips(card.zones, "ups", "default", "90210")).toEqual({ "3": "90300" });
    expect(originOnChart(card.zones, "ups", "default", "90210")).toBe(true);
    expect(originOnChart(card.zones, "ups", "default", "10001")).toBe(false);
    expect(representativeZips(card.zones, "ups", "default", "10001")).toEqual({});
  });

  it("skips a ZIP that a more specific row sends to another zone, and leaves out a zone with no ZIP of its own", () => {
    const row = (originPrefix: string, from: string, to: string, zone: string): ZoneRow => ({ carrierCode: "ups", originPrefix, destPrefixFrom: from, destPrefixTo: to, zone, zoneChartKey: "default" });
    const chart = [row("900", "100", "199", "A"), row("900", "200", "299", "B"), row("90001", "100", "150", "B")];
    // From 90001 the 5-digit row wins: 10000 is zone B. Zone A's only candidate (100) is overridden, so A has no representative ZIP.
    expect(representativeZips(chart, "ups", "default", "90001")).toEqual({ B: "10000" });
    // From another 900xx origin the 3-digit rows apply as written.
    expect(representativeZips(chart, "ups", "default", "90002")).toEqual({ A: "10000", B: "20000" });
  });

  it("ignores another carrier's chart and another chart key", () => {
    expect(representativeZips(card.zones, "fedex", "default", "90001")).toEqual({});
    expect(representativeZips(card.zones, "ups", "other_chart", "90001")).toEqual({});
  });
});

describe("zones available per service", () => {
  const services = [
    { serviceId: UPS_GROUND, zoneIndependent: false },
    { serviceId: USPS_GA, zoneIndependent: false },
  ];

  it("lists the zones of each service's rate rows, numerically sorted", () => {
    const zones = zonesFromRows(card.rows, "90001", services);
    expect(zones[UPS_GROUND]).toEqual(["2", "3", "4", "5", "6", "7", "8"]);
    expect(zones[USPS_GA]).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
  });

  it("counts an origin-specific row only for an origin that starts with its prefix", () => {
    const zones = zonesFromRows(card.rows, "10001", services);
    expect(zones[UPS_GROUND]).toEqual(["2", "3", "4", "5", "6", "7", "8"]);
    expect(zones[USPS_GA]).toEqual([]);
  });

  it("counts every row while no origin is known", () => {
    expect(zonesFromRows(card.rows, null, services)[USPS_GA]).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
  });

  it('gives a zone-independent service the single zone "ALL", whatever its rows say', () => {
    const zones = zonesFromRows(card.rows, "90001", [{ serviceId: UPS_GROUND, zoneIndependent: true }]);
    expect(zones[UPS_GROUND]).toEqual([ALL_ZONES]);
  });

  it("sorts numbers before text and numerically (2, 9, 10, then A)", () => {
    const rows = ["10", "A", "2", "9", "10"].map((zone): Pick<RateRow, "serviceId" | "originPrefix" | "zone"> => ({ serviceId: "s", originPrefix: null, zone }));
    expect(zonesFromRows(rows, "90001", [{ serviceId: "s", zoneIndependent: false }]).s).toEqual(["2", "9", "10", "A"]);
  });

  it("normalises the zone text of a row (zone 4 = 4)", () => {
    const rows: Pick<RateRow, "serviceId" | "originPrefix" | "zone">[] = [{ serviceId: "s", originPrefix: null, zone: "Zone 4" }];
    expect(zonesFromRows(rows, null, [{ serviceId: "s", zoneIndependent: false }]).s).toEqual(["4"]);
  });
});

describe("spread evenly", () => {
  it("gives 3 rows 33.34, 33.33, 33.33: exactly 100.00", () => {
    const shares = spreadEvenly(3);
    expect(shares).toEqual(["33.34", "33.33", "33.33"]);
    expect(sumShares(shares)).toBe("100.00");
  });

  it("gives 7 rows 14.29 four times and 14.28 three times: exactly 100.00", () => {
    const shares = spreadEvenly(7);
    expect(shares).toEqual(["14.29", "14.29", "14.29", "14.29", "14.28", "14.28", "14.28"]);
    expect(sumShares(shares)).toBe("100.00");
  });

  it("totals exactly 100.00 for every row count the form allows, with no row more than a hundredth from another", () => {
    for (let n = 1; n <= 30; n++) {
      const shares = spreadEvenly(n);
      expect(shares).toHaveLength(n);
      expect(sumShares(shares), `n = ${n}`).toBe("100.00");
      const hundredths = shares.map((s) => Math.round(Number(s) * 100));
      expect(Math.max(...hundredths) - Math.min(...hundredths)).toBeLessThanOrEqual(1);
      // Never below a hundredth, so every row passes "greater than zero".
      expect(Math.min(...hundredths)).toBeGreaterThan(0);
    }
  });

  it("is empty for no rows", () => {
    expect(spreadEvenly(0)).toEqual([]);
    expect(spreadEvenly(-2)).toEqual([]);
  });

  it("is what the engine accepts as a distribution (it adds up to exactly 100.00)", () => {
    for (const n of [1, 3, 7, 14]) expect(spreadEvenly(n).reduce((s, v) => s.plus(v), new X(0)).eq(100)).toBe(true);
  });
});

describe("live share totals", () => {
  it("sums in whole hundredths, with no floating point", () => {
    expect(sumShares(["60", "40"])).toBe("100.00");
    expect(sumShares(["33.33", "33.33", "33.33"])).toBe("99.99");
    expect(sumShares(["0.1", "0.2"])).toBe("0.30");
    expect(sumShares(["12.5", "87.5"])).toBe("100.00");
  });

  it("is null while any share is blank or not a percentage with up to 2 decimals", () => {
    expect(sumShares(["60", ""])).toBeNull();
    expect(sumShares(["60", "abc"])).toBeNull();
    expect(sumShares(["60", "40.001"])).toBeNull();
    expect(sumShares(["1000"])).toBeNull();
  });

  it("says in words whether the shares are exact", () => {
    expect(describeShareSum(["60", "40"])).toEqual({ text: "Shares add up to 100.00%.", exact: true });
    expect(describeShareSum(["60", "30"])).toEqual({ text: "Shares add up to 90.00%; they must add up to exactly 100.00%.", exact: false });
    expect(describeShareSum(["60", ""]).exact).toBe(false);
    expect(describeShareSum(["60", ""]).text).toContain("Enter a share for every row");
  });
});

describe("an average becomes exact two-point rows", () => {
  const weighted = (rows: { units: number; lines: number; sharePct: string }[], field: "units" | "lines") => rows.reduce((s, r) => s.plus(new X(r[field]).times(r.sharePct).div(100)), new X(0));

  it("1.4 items on 1.4 lines is 60% of orders with 1 item and 40% with 2 (two rows, lines coupled with items)", () => {
    expect(contentRows({ averageUnits: "1.4", averageLines: "1.4" })).toEqual([
      { units: 1, lines: 1, sharePct: "60" },
      { units: 2, lines: 2, sharePct: "40" },
    ]);
  });

  it("1.4 items on 1 line: lines never exceed items and the larger orders are the 2-item ones", () => {
    expect(contentRows({ averageUnits: "1.4", averageLines: "1" })).toEqual([
      { units: 1, lines: 1, sharePct: "60" },
      { units: 2, lines: 1, sharePct: "40" },
    ]);
  });

  it("1.4 items on 1.2 lines takes three rows, because the two fractions differ", () => {
    expect(contentRows({ averageUnits: "1.4", averageLines: "1.2" })).toEqual([
      { units: 1, lines: 1, sharePct: "60" },
      { units: 2, lines: 1, sharePct: "20" },
      { units: 2, lines: 2, sharePct: "20" },
    ]);
  });

  it("a whole average is one row", () => {
    expect(contentRows({ averageUnits: "3", averageLines: "2" })).toEqual([{ units: 3, lines: 2, sharePct: "100" }]);
  });

  it("reproduces both averages exactly and adds up to 100%, and agrees with the run-setup form's split", () => {
    for (const [u, l] of [["1.4", "1.2"], ["2.75", "1.5"], ["1.0001", "1"], ["3.3333", "3.3333"], ["12.5", "4.25"], ["1.9999", "1.0001"]] as const) {
      const rows = contentRows({ averageUnits: u, averageLines: l });
      expect(weighted(rows, "units").toFixed(), `${u}/${l} units`).toBe(new X(u).toFixed());
      expect(weighted(rows, "lines").toFixed(), `${u}/${l} lines`).toBe(new X(l).toFixed());
      expect(rows.reduce((s, r) => s.plus(r.sharePct), new X(0)).eq(100)).toBe(true);
      expect(rows.every((r) => r.lines <= r.units && r.lines >= 1)).toBe(true);
      const form = averageToContentRows(u, l);
      expect(form.ok).toBe(true);
      if (form.ok) {
        const key = (r: { units: number; lines: number; sharePct: string }) => `${r.units}/${r.lines}/${new X(r.sharePct).toFixed()}`;
        expect(form.rows.map(key).sort()).toEqual(rows.map(key).sort());
      }
    }
  });

  it("rejects more lines than items", () => {
    expect(() => contentRows({ averageUnits: "1.2", averageLines: "1.4" })).toThrow(/lines per order cannot exceed/);
  });
});
