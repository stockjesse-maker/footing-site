import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sql } from "./harness";

/**
 * app.canon_package_ref is the one definition of "the same package" in the database: the unique index, the duplicate checks and the
 * "already imported" count all compare the canonical form. The TypeScript library implements the identical function; both are held to
 * tests/fixtures/adjustments/package-refs.json, a list of {input, canonical} pairs derived by hand (not read from either side).
 */
interface Pair { input: string; canonical: string | null; note: string }
const doc = JSON.parse(readFileSync(path.resolve(__dirname, "../fixtures/adjustments/package-refs.json"), "utf8")) as { cases: Pair[] };

const canon = async (inputs: (string | null)[]): Promise<(string | null)[]> =>
  (await sql<{ c: string | null }>("select app.canon_package_ref(t.v) as c from unnest($1::text[]) with ordinality as t(v, n) order by t.n", [inputs])).map((r) => r.c);

describe("app.canon_package_ref against the shared list", () => {
  it("answers every hand-derived pair of tests/fixtures/adjustments/package-refs.json exactly", async () => {
    expect(doc.cases.length).toBeGreaterThanOrEqual(30);
    const got = await canon(doc.cases.map((c) => c.input));
    const wrong = doc.cases.map((c, i) => ({ c, got: got[i] })).filter((x) => x.got !== x.c.canonical).map((x) => `${JSON.stringify(x.c.input)} (${x.c.note}): expected ${JSON.stringify(x.c.canonical)}, got ${JSON.stringify(x.got)}`);
    expect(wrong).toEqual([]);
  });

  it("is idempotent, answers NULL for NULL, never returns an empty string, and keeps its output free of whitespace and invisible characters", async () => {
    const inputs = doc.cases.map((c) => c.input);
    const once = await canon(inputs);
    const twice = await canon(once);
    expect(twice).toEqual(once);
    expect(await canon([null])).toEqual([null]);
    for (const out of once) {
      if (out === null) continue;
      expect(out.length).toBeGreaterThan(0);
      expect(out).not.toMatch(/[\s\u{0085}\u{00ad}\u{200b}-\u{200f}\u{2028}\u{2029}\u{202a}-\u{202e}\u{2060}-\u{2064}\u{feff}\u{fffd}]/u);
      expect(out).not.toMatch(/[a-z]/);
    }
  });

  it("is a pure function: IMMUTABLE and PARALLEL SAFE, so an index or a check may rely on it, with an empty search_path", async () => {
    const [f] = await sql<{ provolatile: string; proparallel: string; config: string[] | null }>("select provolatile, proparallel, proconfig as config from pg_proc where pronamespace = 'app'::regnamespace and proname = 'canon_package_ref'");
    expect(f).toMatchObject({ provolatile: "i", proparallel: "s" });
    expect(f!.config).toContain('search_path=""');
  });
});
