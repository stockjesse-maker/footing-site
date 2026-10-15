import { describe, expect, it } from "vitest";
import { safeNext } from "@/lib/auth/safe-redirect";

describe("safeNext (open-redirect protection)", () => {
  it.each(["/", "/app", "/app/customers?page=2", "/accept-invite?token=abc_DEF-123"])("accepts same-site path %s", (path) => {
    expect(safeNext(path)).toBe(path);
  });

  it.each([
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "javascript:alert(1)",
    "evil.example",
    "/ok\nSet-Cookie: x=1",
    "",
    null,
    undefined,
    42,
  ])("rejects %j", (value) => {
    expect(safeNext(value)).toBe("/");
  });

  it("uses the supplied fallback", () => {
    expect(safeNext("https://evil.example", "/portal")).toBe("/portal");
  });
});
