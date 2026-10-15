import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["tests/unit/**/*.test.ts"], environment: "node" },
      },
      {
        // Authorization/RLS tests run against a real PostgreSQL database that has the
        // real Supabase Auth schema (see tests/db/global-setup.ts and TESTING.md).
        extends: true,
        test: {
          name: "db",
          include: ["tests/db/**/*.test.ts"],
          environment: "node",
          globalSetup: ["tests/db/global-setup.ts"],
          testTimeout: 30_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
