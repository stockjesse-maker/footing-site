import { describe, expect, it } from "vitest";
import { calculateShipment } from "@/engine";
import { fixtureContext } from "../fixtures/pricing/load";

describe("engine smoke", () => {
  it("prices a simple residential UPS Ground shipment with itemized lines that add up", () => {
    const ctx = fixtureContext();
    const result = calculateShipment(
      {
        shipDate: "2026-10-15",
        originZip: "90001",
        destinationZip: "85001",
        residential: true,
        carrierCode: "ups",
        serviceCode: "ground",
        packages: [{ weight: "3", weightUnit: "lb", length: "10", width: "8", height: "6" }],
      },
      ctx,
    );
    expect(result.status).toBe("ok");
    expect(result.zone?.zone).toBe("5");
    expect(result.packages[0]?.billableLb).toBe("4.0"); // 480 / 139 = 3.45 → rounds up to 4 lb
    const counted = result.lines.filter((l) => l.counted);
    const sum = counted.reduce((s, l) => s + Number(l.amount.amount), 0);
    expect(Number(result.totals.expected.amount)).toBeCloseTo(sum, 2);
    expect(result.lines.map((l) => [l.label, l.amount.amount, l.counted, l.chargeClass])).toMatchInlineSnapshot(`
      [
        [
          "UPS Ground base rate",
          "11.07",
          true,
          "definite",
        ],
        [
          "Residential surcharge",
          "5.00",
          true,
          "definite",
        ],
        [
          "Fuel surcharge",
          "2.49",
          true,
          "definite",
        ],
        [
          "Address correction (if needed)",
          "21.00",
          false,
          "conditional",
        ],
      ]
    `);
  });
});
