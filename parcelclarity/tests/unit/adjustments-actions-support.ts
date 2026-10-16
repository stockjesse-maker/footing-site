import { readFileSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Shared test support for the adjustment server actions and read models (Milestone 5): a recording fake database client, the sessions
 * the actions can be called under, and a few builders. Everything here is fictional.
 *
 * The fake answers `from(table)` queries from in-memory rows and EVALUATES the simple filters (`eq`, `neq`, `is`, `in`, `not`, `gte`, `lte`),
 * so a test can prove that a query named the session's tenant: a row of another tenant is not returned unless the query forgot the filter.
 * A row lacking the column a filter names never matches. Every call (table, operation, payload, filters) and every function call
 * (name, arguments) is recorded, so a test can assert what was and was not sent: zero inserts for a refused file, no M5 table
 * in a customer's path, the exact arguments of a function.
 */
export const TENANT = "22222222-2222-4222-8222-222222222222";
export const OTHER_TENANT = "33333333-3333-4333-8333-333333333333";
export const USER = "11111111-1111-4111-8111-111111111111";
export const BRAND = "77777777-7777-4777-8777-777777777777";
export const BRAND_B = "88888888-8888-4888-8888-888888888888";
export const FOREIGN_BRAND = "99999999-9999-4999-8999-999999999999";
export const IMPORT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const FILE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const POLICY = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
export const BASELINE = "ffffffff-ffff-4fff-8fff-ffffffffffff";
export const SCENARIO = "abababab-abab-4bab-8bab-abababababab";
export const EXAMPLE = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
export const ESTIMATE = "efefefef-efef-4fef-8fef-efefefefefef";
export const RUN = "12121212-1212-4212-8212-121212121212";
export const NEW_ID = "01010101-0101-4101-8101-010101010101";
export const UPS_GROUND = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
export const USPS_GA = "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2";
export const UPS_2DA = "a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3";
export const CARD = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
export const CARD_VERSION = "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2";

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
const base = { user: { id: USER }, profile: { id: USER, email: "admin@example.test", fullName: null }, memberships: [] };
export const adminSession = { ...base, active: { id: "m1", tenantId: TENANT, tenantName: "Fixture 3PL", brandId: null, brandName: null, role: "tenant_admin", portal: "tenant" } };
export const employeeSession = { ...base, active: { id: "m2", tenantId: TENANT, tenantName: "Fixture 3PL", brandId: null, brandName: null, role: "tenant_employee", portal: "tenant" } };
/** A customer's own administrator: the brand portal, never the 3PL's. */
export const brandSession = { ...base, active: { id: "m3", tenantId: TENANT, tenantName: "Fixture 3PL", brandId: BRAND, brandName: "Acme", role: "brand_admin", portal: "brand" } };

// ---------------------------------------------------------------------------
// The fake database
// ---------------------------------------------------------------------------
export type Row = Record<string, unknown>;
export type DbError = { code?: string; message: string; details?: string | null; hint?: string | null };
type Result = { data: unknown; error: DbError | null; count?: number | null };
export type RpcHandler = Result | ((args: Record<string, unknown>) => Result | Promise<Result>);

export interface Filter {
  op: string;
  column: string;
  value: unknown;
}

export interface Call {
  table: string;
  op: "select" | "insert" | "update" | "delete";
  columns?: string;
  payload?: unknown;
  filters: Filter[];
  single: boolean;
  head: boolean;
  returning: boolean;
  range?: [number, number];
  limit?: number;
}

export interface FakeOptions {
  tables?: Record<string, Row[]>;
  /** An error for every call on a table (any operation), or for one operation ("table:insert"). */
  errors?: Record<string, DbError>;
  rpc?: Record<string, RpcHandler>;
  /** What an insert that asks for its row back returns, by table. */
  inserted?: Record<string, Row>;
}

export interface FakeDb {
  client: SupabaseClient;
  calls: Call[];
  rpcs: { name: string; args: Record<string, unknown> }[];
  tables: Record<string, Row[]>;
  /** Calls on a table, optionally one operation. */
  on: (table: string, op?: Call["op"]) => Call[];
  rpcNamed: (name: string) => Record<string, unknown>[];
  /** Everything that happened, in order: "select:table", "insert:table", "rpc:name", ... */
  log: string[];
  /** Every table any call touched. */
  touchedTables: () => string[];
  inserts: () => Call[];
  /** The calls that wrote (insert, update or delete). */
  writes: () => Call[];
}

function matches(row: Row, f: Filter): boolean {
  const v = row[f.column];
  switch (f.op) {
    case "eq":
      return v !== undefined && String(v) === String(f.value);
    case "neq":
      return v !== undefined && String(v) !== String(f.value);
    case "is":
      return f.value === null ? v === null || v === undefined : v === f.value;
    case "in":
      return v !== undefined && (f.value as unknown[]).map(String).includes(String(v));
    case "not":
      return f.value === null ? v !== null && v !== undefined : true;
    case "gte":
      return v !== undefined && v !== null && String(v) >= String(f.value);
    case "lte":
      return v !== undefined && v !== null && String(v) <= String(f.value);
    default:
      return true;
  }
}

export function makeDb(opts: FakeOptions = {}): FakeDb {
  const calls: Call[] = [];
  const rpcs: { name: string; args: Record<string, unknown> }[] = [];
  const log: string[] = [];
  const tables = opts.tables ?? {};

  class Query implements PromiseLike<Result> {
    readonly call: Call;
    private recorded = false;
    constructor(table: string) {
      this.call = { table, op: "select", filters: [], single: false, head: false, returning: false };
    }
    select(columns?: string, o?: { count?: string; head?: boolean }) {
      if (this.call.op === "select") {
        this.call.columns = columns;
        this.call.head = o?.head === true;
      } else this.call.returning = true;
      return this;
    }
    insert(payload: unknown) {
      this.call.op = "insert";
      this.call.payload = payload;
      return this;
    }
    update(payload: unknown) {
      this.call.op = "update";
      this.call.payload = payload;
      return this;
    }
    delete() {
      this.call.op = "delete";
      return this;
    }
    private filter(op: string, column: string, value: unknown) {
      this.call.filters.push({ op, column, value });
      return this;
    }
    eq(c: string, v: unknown) {
      return this.filter("eq", c, v);
    }
    neq(c: string, v: unknown) {
      return this.filter("neq", c, v);
    }
    is(c: string, v: unknown) {
      return this.filter("is", c, v);
    }
    in(c: string, v: unknown[]) {
      return this.filter("in", c, v);
    }
    not(c: string, _op: string, v: unknown) {
      return this.filter("not", c, v);
    }
    gte(c: string, v: unknown) {
      return this.filter("gte", c, v);
    }
    lte(c: string, v: unknown) {
      return this.filter("lte", c, v);
    }
    or(expr: string) {
      return this.filter("or", "", expr);
    }
    order() {
      return this;
    }
    limit(n: number) {
      this.call.limit = n;
      return this;
    }
    range(from: number, to: number) {
      this.call.range = [from, to];
      return this;
    }
    maybeSingle() {
      this.call.single = true;
      return this;
    }
    single() {
      this.call.single = true;
      return this;
    }
    overrideTypes() {
      return this;
    }
    then<A, B>(onfulfilled?: ((value: Result) => A | PromiseLike<A>) | null, onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
      return Promise.resolve(this.run()).then(onfulfilled, onrejected);
    }
    private run(): Result {
      const c = this.call;
      if (!this.recorded) {
        this.recorded = true;
        calls.push(c);
        log.push(`${c.op}:${c.table}`);
      }
      const error = opts.errors?.[`${c.table}:${c.op}`] ?? opts.errors?.[c.table];
      if (error) return { data: null, error };
      if (c.op === "select") {
        let rows = (tables[c.table] ?? []).filter((r) => c.filters.every((f) => matches(r, f)));
        if (c.range) rows = rows.slice(c.range[0], c.range[1] + 1);
        if (c.limit !== undefined) rows = rows.slice(0, c.limit);
        if (c.head) return { data: null, error: null, count: rows.length };
        return { data: c.single ? (rows[0] ?? null) : rows, error: null };
      }
      if (c.op === "insert" && c.returning) {
        const row = opts.inserted?.[c.table] ?? { id: NEW_ID };
        return { data: c.single ? row : [row], error: null };
      }
      return { data: null, error: null };
    }
  }

  const client = {
    from: (table: string) => new Query(table),
    rpc: async (name: string, args: Record<string, unknown> = {}): Promise<Result> => {
      rpcs.push({ name, args });
      log.push(`rpc:${name}`);
      const h = opts.rpc?.[name];
      if (!h) return { data: null, error: { code: "42883", message: `no function ${name}` } };
      return typeof h === "function" ? await h(args) : h;
    },
  } as unknown as SupabaseClient;

  return {
    client,
    calls,
    rpcs,
    tables,
    on: (table, op) => calls.filter((c) => c.table === table && (op === undefined || c.op === op)),
    rpcNamed: (name) => rpcs.filter((r) => r.name === name).map((r) => r.args),
    log,
    touchedTables: () => [...new Set(calls.map((c) => c.table))],
    inserts: () => calls.filter((c) => c.op === "insert"),
    writes: () => calls.filter((c) => c.op !== "select"),
  };
}

// ---------------------------------------------------------------------------
// Files and builders
// ---------------------------------------------------------------------------
const fixtureDir = path.resolve(__dirname, "../fixtures/adjustments");
export const fixtureText = (name: string): string => readFileSync(path.join(fixtureDir, name), "utf8");
export const fixtureJson = <T = unknown>(name: string): T => JSON.parse(fixtureText(name)) as T;

export const csvFile = (text: string, name = "history.csv"): File => new File([text], name, { type: "text/csv" });

/** The `uploaded_files` row a stored upload comes back as (bytea is hex text with a "\x" prefix). */
export const storedUploadRow = (text: string, over: Row = {}): Row => ({
  id: FILE,
  tenant_id: TENANT,
  purpose: "adjustment_import",
  filename: "history.csv",
  mime_type: "text/csv",
  content: `\\x${Buffer.from(text).toString("hex")}`,
  ...over,
});

/** The catalog the import library matches carriers and services against. */
export const CATALOG_ROWS = [
  { id: UPS_GROUND, carrierCode: "ups", carrierName: "UPS", code: "ground", name: "UPS Ground" },
  { id: USPS_GA, carrierCode: "usps", carrierName: "USPS", code: "ground_advantage", name: "USPS Ground Advantage" },
  { id: UPS_2DA, carrierCode: "ups", carrierName: "UPS", code: "2nd_day_air", name: "UPS 2nd Day Air" },
];

/** A well-formed history file of `rows` rows with the template's headers (fictional, unique package references). */
export function historyCsv(rows: number, opts: { brand?: string; carrier?: string; start?: string } = {}): string {
  const header = "ship_date,adjusted_on,carrier,service,brand,adjustment_type,cause,reason,package_ref,declared_weight,actual_weight,weight_unit,original_length,original_width,original_height,corrected_length,corrected_width,corrected_height,dimension_unit,customer_charge_original,customer_charge_corrected,customer_adjustment_fee,handling";
  const lines = [header];
  const day0 = Date.parse(`${opts.start ?? "2026-01-01"}T00:00:00Z`);
  for (let i = 0; i < rows; i++) {
    const d = new Date(day0 + (i % 28) * 86_400_000).toISOString().slice(0, 10);
    lines.push(`${d},,${opts.carrier ?? "UPS"},,${opts.brand ?? ""},reweight,carrier_reweigh,,1ZT${String(i).padStart(7, "0")},2,3,lb,,,,,,,in,10.00,11.50,3.00,`);
  }
  return `${lines.join("\n")}\n`;
}

/** What `append_adjustment_records` answers for a database that accepts everything, tracking its own cursor like the real function. */
export function appendEmulator(state: { committed: number; skipped: number; accepted: number }): RpcHandler {
  return (args) => {
    const rows = (args.p_rows as unknown[]).length;
    const from = args.p_from_row as number;
    if (from !== state.committed + state.skipped + 1) return { data: null, error: { code: "PC002", message: "the chunk does not start at the cursor" } };
    state.committed += rows;
    return { data: { applied: true, inserted: rows, skipped: 0, nextRow: state.committed + state.skipped + 1, committed: state.committed, skippedTotal: state.skipped }, error: null };
  };
}
