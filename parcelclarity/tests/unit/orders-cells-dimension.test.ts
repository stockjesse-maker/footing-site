import { describe, expect, it } from "vitest";
import { parseDimension } from "@/lib/orders/cells";

const HOSTILE_RUN_LENGTH = 100_000;
const SLOW_PARSE_LIMIT_MS = 50;

describe("parseDimension", () => {
  it("reads plain and unit-suffixed lengths", () => {
    expect(parseDimension("10")).toBe("10");
    expect(parseDimension("10.5 in")).toBe("10.5");
    expect(parseDimension('.5"')).toBe("0.5");
    expect(parseDimension("  ")).toBeNull();
  });

  it("refuses zero and malformed text", () => {
    expect(parseDimension("0")).toBe("invalid");
    expect(parseDimension("ten")).toBe("invalid");
  });

  it("refuses a very long cell quickly instead of backtracking", () => {
    const hostile = `1${" ".repeat(HOSTILE_RUN_LENGTH)}x`;
    const started = Date.now();
    expect(parseDimension(hostile)).toBe("invalid");
    expect(Date.now() - started).toBeLessThan(SLOW_PARSE_LIMIT_MS);
  });
});
