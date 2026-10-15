import { describe, expect, it } from "vitest";
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS } from "@/lib/auth/permissions";
import { sql } from "./harness";

// RLS enforces public.role_permissions; server code checks src/lib/auth/permissions.ts.
// If they disagree, either the UI promises something the database refuses or, worse,
// server code allows something RLS should forbid. This test keeps them identical.
describe("TypeScript permission model matches the database", () => {
  it("has the same roles", async () => {
    const rows = await sql<{ key: string }>("select key from public.roles order by key");
    expect(rows.map((r) => r.key)).toEqual([...ROLES].sort());
  });

  it("has the same permissions", async () => {
    const rows = await sql<{ key: string }>("select key from public.permissions order by key");
    expect(rows.map((r) => r.key)).toEqual([...PERMISSIONS].sort());
  });

  it("grants every role exactly the same permissions", async () => {
    const rows = await sql<{ role_key: string; permission_key: string }>("select role_key, permission_key from public.role_permissions");
    const fromDb: Record<string, string[]> = {};
    for (const r of rows) (fromDb[r.role_key] ??= []).push(r.permission_key);
    for (const role of ROLES) {
      expect((fromDb[role] ?? []).sort(), role).toEqual([...ROLE_PERMISSIONS[role]].sort());
    }
  });
});
