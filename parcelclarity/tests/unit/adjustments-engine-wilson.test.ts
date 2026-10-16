import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { incidenceConfidence, incidencePct, wilsonBounds, wilsonFraction } from "@/engine/adjustments";
import { int, rng } from "./adjustments-engine-support";

/**
 * The Wilson score interval (z = 1.96, closed form, Decimal sqrt). Checked against (a) values worked by hand in the
 * math review and the goldens, (b) a second, algebraically different closed form at 90 digits, (c) invariants.
 */
const HP = Decimal.clone({ precision: 90, rounding: Decimal.ROUND_HALF_UP });

/** (2k + z^2 -+ z sqrt(z^2 + 4k - 4k^2/N)) / (2 (N + z^2)): the textbook form, not the one the engine uses. */
function reference(k: number, N: number): { lower: Decimal; upper: Decimal } {
  const z2 = new HP("1.96").pow(2);
  const root = z2.plus(4 * k).minus(new HP(4).times(k).times(k).div(N)).sqrt().times("1.96");
  const centre = new HP(2).times(k).plus(z2);
  const denominator = new HP(2).times(new HP(N).plus(z2));
  return { lower: Decimal.max(0, centre.minus(root).div(denominator)), upper: Decimal.min(1, centre.plus(root).div(denominator)) };
}

describe("wilson interval", () => {
  it("reproduces the hand-worked values (math review R6, golden h13 to h16)", () => {
    expect(wilsonBounds(3, 100)).toMatchObject({ lowerPct4dp: "1.0254", upperPct4dp: "8.4521" });
    expect(wilsonBounds(0, 500)).toMatchObject({ lowerPct4dp: "0.0000", upperPct4dp: "0.7625", lowerPct10dp: "0.0000000000", upperPct10dp: "0.7624618531" });
    expect(wilsonBounds(20, 1000)).toMatchObject({ lowerPct4dp: "1.2984", upperPct4dp: "3.0690" });
    // The risk golden pins the unrounded lower bound through 1,947,537 E4 at V = 1000 and 150,000 E4 per affected package.
    expect(Math.abs(Number(wilsonBounds(20, 1000)!.lowerPct10dp) - (1947537 / 150_000_000) * 100)).toBeLessThan(5e-6);
    expect(wilsonBounds(1, 3200)).toMatchObject({ lowerPct4dp: "0.0055", upperPct4dp: "0.1768" });
  });

  it("agrees with the textbook closed form to 30 digits over seeded cases", () => {
    const r = rng(20261016);
    for (let i = 0; i < 300; i++) {
      const N = int(r, 1, 200_000);
      const k = int(r, 0, Math.min(N, r() < 0.3 ? 5 : N));
      const got = wilsonFraction(k, N)!;
      const want = reference(k, N);
      expect(got.lower.minus(want.lower.toString()).abs().lessThan("1e-30"), `k=${k} N=${N} lower`).toBe(true);
      expect(got.upper.minus(want.upper.toString()).abs().lessThan("1e-30"), `k=${k} N=${N} upper`).toBe(true);
    }
  });

  it("brackets the point estimate, stays in [0, 1], and narrows as N grows", () => {
    const r = rng(7);
    for (let i = 0; i < 200; i++) {
      const N = int(r, 1, 10_000);
      const k = int(r, 0, N);
      const f = wilsonFraction(k, N)!;
      const p = new Decimal(k).div(N);
      expect(f.lower.greaterThanOrEqualTo(0) && f.upper.lessThanOrEqualTo(1)).toBe(true);
      expect(f.lower.lessThanOrEqualTo(p.plus("1e-40")) && f.upper.greaterThanOrEqualTo(p.minus("1e-40"))).toBe(true);
    }
    const narrow = wilsonFraction(20, 1000)!;
    const wide = wilsonFraction(2, 100)!;
    expect(narrow.upper.minus(narrow.lower).lessThan(wide.upper.minus(wide.lower))).toBe(true);
  });

  it("k = N: the upper bound is exactly 1 and k = 0: the lower bound is exactly 0", () => {
    expect(wilsonBounds(50, 50)).toMatchObject({ upperPct4dp: "100.0000", upperPct10dp: "100.0000000000" });
    expect(wilsonBounds(0, 1)).toMatchObject({ lowerPct10dp: "0.0000000000" });
  });

  it("returns null for an impossible (k, N)", () => {
    expect(wilsonBounds(1, 0)).toBeNull();
    expect(wilsonBounds(5, 3)).toBeNull();
    expect(wilsonBounds(-1, 10)).toBeNull();
    expect(wilsonBounds(1.5, 10)).toBeNull();
  });

  it("displays incidence HALF_UP at 4 dp from the exact fraction (0.03125 percent shows 0.0313)", () => {
    expect(incidencePct(1, 3200)).toBe("0.0313");
    expect(incidencePct(1, 16)).toBe("6.2500");
    expect(incidencePct(1, 3)).toBe("33.3333");
    expect(incidencePct(2, 3)).toBe("66.6667");
  });

  it("rates confidence by the relative half-width: none, low, moderate, adequate", () => {
    expect(incidenceConfidence(0, 500)).toBe("none");
    expect(incidenceConfidence(3, 100)).toBe("low"); // 124 percent
    expect(incidenceConfidence(10, 1000)).toBe("low"); // 64 percent
    expect(incidenceConfidence(20, 1000)).toBe("moderate"); // 44 percent
    expect(incidenceConfidence(280, 10_000)).toBe("adequate"); // 12 percent
  });
});
