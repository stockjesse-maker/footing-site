import { describe, expect, it } from "vitest";
import { calculateShipment } from "@/engine/calculate";
import type { ShipmentInput } from "@/engine/types";
import { fixtureContext } from "../fixtures/pricing/load";

/**
 * Throughput guard for bulk modeling: the batch core prices windows of ~100 shipments inside a
 * ~4 s budget, so a single shipment must stay well under 10 ms on the fixture card (rules, ZIP
 * lists and a 1,852-row card). The number is also recorded in IMPLEMENTATION_STATUS.md.
 */
describe("engine throughput on the fixture context", () => {
  it("prices 2,000 varied shipments at under 10 ms each", () => {
    const ctx = fixtureContext({ withZipLists: true, withOverrides: true });
    const destinations = ["85001", "93920", "95991", "90210", "33101", "60601", "10001", "97201", "99501", "93620"];
    const inputs: ShipmentInput[] = Array.from({ length: 2000 }, (_, i) => ({
      shipDate: "2026-10-15",
      originZip: "90001",
      destinationZip: destinations[i % destinations.length]!,
      residential: i % 3 === 0,
      carrierCode: "ups",
      serviceCode: "ground",
      packages: [{ weight: String(1 + (i % 40)), weightUnit: "lb", length: String(6 + (i % 20)), width: "8", height: "6" }],
    }));
    const started = performance.now();
    let ok = 0;
    for (const input of inputs) if (calculateShipment(input, ctx).status === "ok") ok++;
    const perShipmentMs = (performance.now() - started) / inputs.length;
    expect(ok).toBeGreaterThan(1500);
    expect(perShipmentMs).toBeLessThan(10);
  });
});
