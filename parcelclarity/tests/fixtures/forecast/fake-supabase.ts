import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A fake Supabase client for the server-side glue of the forecast screens: every table and function
 * answers with the rows the test gives it. Query builders are thenables that ignore their filters
 * (`select`, `eq`, `is`, `order`, … return the builder), `maybeSingle()` and `single()` answer the
 * first row or null, and a table listed in `errors` answers with that error. Each table holds only the
 * rows the query under test is about.
 */
export type FakeResult = { data: unknown; error: { code?: string; message: string } | null };

export interface FakeOptions {
  tables?: Record<string, unknown[]>;
  errors?: Record<string, { code?: string; message: string }>;
  rpc?: Record<string, FakeResult | ((args: Record<string, unknown>) => FakeResult)>;
}

export function fakeSupabase(opts: FakeOptions): SupabaseClient {
  const query = (table: string) => {
    let single = false;
    const proxy: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") {
            return (resolve: (v: FakeResult) => void) => {
              const error = opts.errors?.[table] ?? null;
              const rows = opts.tables?.[table] ?? [];
              resolve({ data: error ? null : single ? (rows[0] ?? null) : rows, error });
            };
          }
          if (prop === "maybeSingle" || prop === "single") {
            return () => {
              single = true;
              return proxy;
            };
          }
          return () => proxy;
        },
      },
    );
    return proxy;
  };
  const client = {
    from: (table: string) => query(table),
    rpc: async (name: string, args: Record<string, unknown>): Promise<FakeResult> => {
      const r = opts.rpc?.[name];
      if (!r) return { data: null, error: { code: "42883", message: `no function ${name}` } };
      return typeof r === "function" ? r(args) : r;
    },
  };
  return client as unknown as SupabaseClient;
}
