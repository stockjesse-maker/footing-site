import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static checks of the adjustment server layer against the migration and against the product's hard rules. They read source text, so they
 * catch what a fake client cannot: a function name or an argument name that the database does not have, an export a "use server" file may not
 * make, a write to a staff-only table from the wrong place, a `select *`, a path that reaches a platform administrator, a secret or a
 * carrier-cost field in the code.
 */
const root = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const OWNED = ["src/app/actions/adjustments.ts", "src/lib/adjustments/action-schemas.ts", "src/lib/adjustments/queries.ts", "src/lib/adjustments/context.ts"] as const;
const sources = Object.fromEntries(OWNED.map((f) => [f, read(f)])) as Record<(typeof OWNED)[number], string>;
const ACTIONS = sources["src/app/actions/adjustments.ts"];

// ---------------------------------------------------------------------------
// The functions the layer calls exist, with the arguments it sends
// ---------------------------------------------------------------------------
interface Signature {
  name: string;
  params: { name: string; required: boolean }[];
}

/** Every `create [or replace] function public.name(params)` of the migrations, last definition wins. */
function signatures(): Map<string, Signature> {
  const dir = path.join(root, "supabase/migrations");
  const out = new Map<string, Signature>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(path.join(dir, file), "utf8");
    for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)\s*\(([^)]*)\)/gi)) {
      const params = splitTopLevel(m[2]!)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => ({ name: p.split(/\s+/)[0]!, required: !/\bdefault\b/i.test(p) }));
      out.set(m[1]!, { name: m[1]!, params });
    }
  }
  return out;
}

function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of list) {
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts;
}

/** The keys at the top level of the object literal that follows `.rpc("name", `. */
function rpcCalls(source: string): { name: string; keys: string[] }[] {
  const calls: { name: string; keys: string[] }[] = [];
  for (const m of source.matchAll(/\.rpc\(\s*"(\w+)"\s*(,\s*\{)?/g)) {
    const keys: string[] = [];
    if (m[2]) {
      let depth = 1;
      let token = "";
      let afterColon = false;
      let quote: string | null = null;
      for (let i = m.index! + m[0].length; i < source.length && depth > 0; i++) {
        const ch = source[i]!;
        if (quote) {
          if (ch === quote && source[i - 1] !== "\\") quote = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
          quote = ch;
          continue;
        }
        if ("{[(".includes(ch)) {
          depth++;
          token = "";
          continue;
        }
        if ("}])".includes(ch)) {
          depth--;
          // The closing brace of the argument object ends a shorthand key (`{ p_a }`).
          if (depth === 0 && token && !afterColon) keys.push(token);
          token = "";
          continue;
        }
        if (depth !== 1) continue;
        if (/\w/.test(ch)) token += ch;
        else if (ch === ":" && !afterColon) {
          if (token) keys.push(token);
          afterColon = true;
          token = "";
        } else if (ch === ",") {
          if (token && !afterColon) keys.push(token);
          afterColon = false;
          token = "";
        } else if (!/\s/.test(ch) && !afterColon) token = "";
      }
    }
    calls.push({ name: m[1]!, keys });
  }
  return calls;
}

describe("the functions the layer calls", () => {
  const sigs = signatures();
  const calls = OWNED.flatMap((f) => rpcCalls(sources[f]).map((c) => ({ ...c, file: f })));

  it("calls a good number of them (the scanner finds the calls)", () => {
    expect(calls.length).toBeGreaterThanOrEqual(24);
    expect(new Set(calls.map((c) => c.name)).size).toBeGreaterThanOrEqual(21);
  });

  it("calls only functions the migrations create, with only arguments they declare and every required one", () => {
    for (const call of calls) {
      const sig = sigs.get(call.name);
      expect(sig, `${call.file}: ${call.name} exists`).toBeDefined();
      const declared = new Set(sig!.params.map((p) => p.name));
      for (const key of call.keys) expect(declared.has(key), `${call.name}(${key}) is a parameter`).toBe(true);
      for (const p of sig!.params.filter((x) => x.required)) expect(call.keys, `${call.name} sends ${p.name}`).toContain(p.name);
    }
  });

  it("reaches every database function of the module that a screen needs, and none that only the database may call", () => {
    const names = new Set(calls.map((c) => c.name));
    for (const needed of [
      "set_adjustment_policy", "end_adjustment_policy", "create_adjustment_import", "set_adjustment_import_mapping", "append_adjustment_records", "finalize_adjustment_import",
      "discard_adjustment_import", "withdraw_adjustment_import", "reset_adjustment_import", "adjustment_records_json", "save_adjustment_baseline", "delete_adjustment_baseline",
      "save_adjustment_scenario", "save_risk_estimate", "archive_adjustment_scenario", "archive_risk_estimate", "preview_customer_example", "publish_customer_example",
      "retire_customer_example", "adjustment_example_states", "brand_adjustment_examples",
    ]) expect(names.has(needed), needed).toBe(true);
    // The offboarding functions are for the service role only; the audit function refuses adjustment events from clients.
    for (const forbidden of ["purge_tenant_adjustment_data", "purge_brand_adjustment_data", "log_audit_event", "write_audit"]) expect(names.has(forbidden), forbidden).toBe(false);
  });

  it("checks the scanner itself on a call it should read", () => {
    expect(rpcCalls('await supabase.rpc("x_fn", { p_a: 1, p_b: { nested: 2, deeper: [1, { z: 3 }] }, p_c: "a, b: c", p_d: who.tenantId, p_e: f(1, 2), p_f });')).toEqual([{ name: "x_fn", keys: ["p_a", "p_b", "p_c", "p_d", "p_e", "p_f"] }]);
    expect(rpcCalls('supabase.rpc("no_args")')).toEqual([{ name: "no_args", keys: [] }]);
  });
});

// ---------------------------------------------------------------------------
// "use server": async functions only
// ---------------------------------------------------------------------------
describe('the "use server" module', () => {
  it("starts with the directive and exports nothing but async functions (and erased types)", () => {
    expect(ACTIONS.trimStart().startsWith('"use server";')).toBe(true);
    const exports = [...ACTIONS.matchAll(/^export\s+(.*)$/gm)].map((m) => m[1]!);
    expect(exports.length).toBeGreaterThanOrEqual(20);
    for (const e of exports) expect(e, e).toMatch(/^(async function \w+\(|type |interface )/);
    expect(ACTIONS).not.toMatch(/^export\s+(const|let|var|class|default|\{|\*)/m);
  });

  it("keeps every schema, constant and helper out of it, and keeps the directive out of the modules a page imports", () => {
    for (const f of OWNED.filter((x) => x !== "src/app/actions/adjustments.ts")) expect(sources[f], f).not.toMatch(/^\s*["']use server["'];?\s*$/m);
    // Its imports are pure (zod, the engine's pure modules, types): a form can import it.
    expect(sources["src/lib/adjustments/action-schemas.ts"]).not.toMatch(/^import\s+(?:.*\sfrom\s+)?["'](server-only|next\/[^"']*|@supabase\/[^"']*|@\/lib\/supabase[^"']*)["']/m);
  });
});

// ---------------------------------------------------------------------------
// Hard rules
// ---------------------------------------------------------------------------
describe("hard rules, in the source", () => {
  const M5_TABLES = ["adjustment_policies", "adjustment_imports", "adjustment_records", "adjustment_baselines", "adjustment_scenarios", "risk_estimates", "published_adjustment_examples"];

  it("writes to a staff-only table from nowhere: every change goes through a database function (the only table written is the upload)", () => {
    for (const f of OWNED) {
      for (const m of sources[f].matchAll(/\.from\(\s*"(\w+)"\s*\)([^;]*);/g)) {
        const [, table, chain] = m;
        if (M5_TABLES.includes(table!)) expect(chain, `${f}: ${table}`).not.toMatch(/\.(insert|update|upsert|delete)\(/);
      }
    }
    const written = [...ACTIONS.matchAll(/\.from\(\s*"(\w+)"\s*\)\s*\.(insert|update|upsert|delete)\(/g)].map((m) => m[1]);
    expect(new Set(written)).toEqual(new Set(["uploaded_files"]));
    const inserts = [...ACTIONS.matchAll(/\.from\("uploaded_files"\)\s*\.insert\(/g)];
    expect(inserts).toHaveLength(1);
  });

  it("never selects a whole row: every select names its columns", () => {
    for (const f of OWNED) {
      expect(sources[f], f).not.toMatch(/\.select\(\s*["'`]\s*\*/);
      expect(sources[f], f).not.toMatch(/select\(\s*\)\s*\./);
    }
  });

  it("never writes an audit row (the database does, from triggers, and refuses adjustment events from clients)", () => {
    for (const f of OWNED) {
      expect(sources[f], f).not.toMatch(/log_audit_event|write_audit|audit_log|"adjustment\.(policy|import|baseline|scenario|estimate|data)_/);
    }
  });

  it("has no path for a platform administrator, and no hardcoded key or token", () => {
    for (const f of OWNED) {
      expect(sources[f], f).not.toMatch(/isPlatformAdmin|is_platform_admin|requirePlatformAdmin|platform admin/i);
      expect(sources[f], f).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9]|service_role|SUPABASE_SERVICE|sk_live|apikey/i);
      expect(sources[f], f).not.toMatch(/process\.env/);
    }
  });

  it("has no carrier buy-rate field, argument or column anywhere in it", () => {
    for (const f of OWNED) {
      expect(sources[f], f).not.toMatch(/\b(buyRate|buy_rate|carrierCost|carrier_cost|carrierRate|carrier_rate|wholesale|negotiated_?rate|postage_?cost|label_?cost)\b/i);
    }
  });

  it("decides the tenant from the session in every action, and never reads one from a request", () => {
    expect(ACTIONS).toContain("ctx.active.tenantId");
    expect(ACTIONS).not.toMatch(/formData\.get\(\s*["']tenant|input\.tenantId|parsed\.data\.tenantId|\bv\.tenantId/i);
    for (const name of [...ACTIONS.matchAll(/^export async function (\w+)\(/gm)].map((m) => m[1]!)) {
      const start = ACTIONS.indexOf(`export async function ${name}(`);
      const next = ACTIONS.indexOf("\nexport async function", start + 10);
      const body = ACTIONS.slice(start, next === -1 ? undefined : next);
      expect(body, name).toMatch(/await actor\("adjustment\.(view|manage)"\)/);
      // The permission is the first thing every action asks, before any query or function call.
      const first = Math.min(...["createClient()", ".rpc(", ".from(", "safeParse("].map((t) => body.indexOf(t)).filter((i) => i >= 0));
      expect(body.indexOf("await actor("), name).toBeLessThan(first);
    }
  });

  it("asks for the permission that matches what the action does: view to read and price, manage to write", () => {
    const need = (name: string) => {
      const start = ACTIONS.indexOf(`export async function ${name}(`);
      return /await actor\("(adjustment\.\w+)"\)/.exec(ACTIONS.slice(start))![1];
    };
    for (const read of ["loadHistoryStatistics", "evaluateScenario", "previewExample", "listExamples", "forecastRisk"]) expect(need(read), read).toBe("adjustment.view");
    for (const write of ["setPolicy", "endPolicy", "uploadAdjustmentFile", "saveImportMapping", "validateImport", "commitImport", "discardImport", "withdrawImport", "saveBaseline", "deleteBaseline", "saveScenario", "archiveScenario", "publishExample", "retireExample", "saveRiskEstimate", "archiveRiskEstimate"]) {
      expect(need(write), write).toBe("adjustment.manage");
    }
  });

  it("parses an uploaded file and runs the header guard before it stores a byte (the source's own order)", () => {
    const start = ACTIONS.indexOf("export async function uploadAdjustmentFile(");
    const body = ACTIONS.slice(start, ACTIONS.indexOf("type ImportFile", start));
    const parse = body.indexOf("parseAdjustmentFile(");
    const refused = body.indexOf('parsed.status === "refused"');
    const store = body.indexOf('.from("uploaded_files")');
    const register = body.indexOf('rpc("create_adjustment_import"');
    expect(parse).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(parse);
    expect(store).toBeGreaterThan(refused);
    expect(register).toBeGreaterThan(store);
  });
});
