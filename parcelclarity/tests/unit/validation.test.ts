import { describe, expect, it } from "vitest";
import { emailSchema, fieldErrors, nameSchema, passwordSchema } from "@/lib/auth/validation";
import { z } from "zod";

describe("emailSchema", () => {
  it("trims and lower-cases", () => {
    expect(emailSchema.parse("  Jesse@ShippingBros.COM ")).toBe("jesse@shippingbros.com");
  });
  it.each(["", "nope", "a@b", "a b@c.com"])("rejects %j", (v) => {
    expect(emailSchema.safeParse(v).success).toBe(false);
  });
});

describe("passwordSchema", () => {
  it("requires at least 10 characters", () => {
    expect(passwordSchema.safeParse("123456789").success).toBe(false);
    expect(passwordSchema.safeParse("1234567890").success).toBe(true);
  });
  it("rejects passwords longer than 72 bytes (bcrypt would silently truncate them)", () => {
    expect(passwordSchema.safeParse("a".repeat(72)).success).toBe(true);
    expect(passwordSchema.safeParse("a".repeat(73)).success).toBe(false);
    expect(passwordSchema.safeParse("é".repeat(37)).success).toBe(false); // 74 bytes
  });
});

describe("nameSchema and fieldErrors", () => {
  it("trims names and bounds their length", () => {
    expect(nameSchema.parse("  Acme  ")).toBe("Acme");
    expect(nameSchema.safeParse("   ").success).toBe(false);
    expect(nameSchema.safeParse("x".repeat(121)).success).toBe(false);
  });
  it("keeps the first message per field", () => {
    const result = z.object({ a: z.string().min(3, "first").regex(/z/, "second") }).safeParse({ a: "" });
    expect(result.success).toBe(false);
    if (!result.success) expect(fieldErrors(result.error)).toEqual({ a: "first" });
  });
});
