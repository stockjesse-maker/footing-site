import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The product's hard rules, checked over the WORDS of the adjustment engine (code, strings AND comments) and of the golden rule book:
 *  - "absorbed" and "decided case by case" mean foregone revenue at customer-facing rates, never a loss, a cost or a margin;
 *  - no carrier buy rate is ever read, stored or computed;
 *  - the amount of the 3PL is never called a cost, a loss, a margin or a profit.
 * The words may appear only to DENY them ("never a loss, cost or margin", "there is no carrier cost"), as the verb of a customer's charge
 * ("what would it cost the customer") or in the import guard's list of headers it refuses. UI authors copy these comments, so they are held to it.
 */
const engineDir = path.resolve(__dirname, "../../src/engine/adjustments");
const rulesPath = path.resolve(__dirname, "../fixtures/adjustments/RULES.md");

const BANNED = /\b(costs?|loss(?:es)?|margins?|profit(?:s|able)?|buy[ -]rates?)\b/i;
const EXCUSES: RegExp[] = [
  /\b(never|no|not|nor|without|cannot|neither)\b/i, // the sentence denies it
  /\bcost the customer\b/i, // what a charge costs the customer: the customer-facing amount
  /\bheaders?\b/i, // the import guard's list of refused headers
  /\bwhole words?\b/i, // ... and the sentence that lists the words it refuses
  /history-carrier-cost/i, // the name of the guard's refusal fixture
];

/** The text of every comment of a TypeScript source, joined into paragraphs (consecutive comment lines are one paragraph). */
function comments(source: string): string[] {
  const out: string[] = [];
  for (const block of source.match(/\/\*[\s\S]*?\*\//g) ?? []) out.push(block.replace(/^\/\*+|\*+\/$/g, "").split("\n").map((l) => l.replace(/^\s*\*\s?/, "")).join("\n"));
  let run: string[] = [];
  for (const line of source.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")) {
    const m = /^\s*\/\/\s?(.*)$/.exec(line);
    if (m) run.push(m[1]!);
    else if (run.length) {
      out.push(run.join("\n"));
      run = [];
    }
  }
  if (run.length) out.push(run.join("\n"));
  return out;
}

/** Sentences that use a banned word without an excuse. */
function offending(text: string): string[] {
  return text
    .split(/(?<=[.;!?])\s+|\n\s*\n/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => BANNED.test(s) && !EXCUSES.some((e) => e.test(s)));
}

const sources = readdirSync(engineDir).filter((f) => f.endsWith(".ts")).map((f) => [f, readFileSync(path.join(engineDir, f), "utf8")] as const);

describe("the engine's words follow the hard rules", () => {
  it("covers every engine source file", () => {
    expect(sources.map(([f]) => f)).toEqual(expect.arrayContaining(["history.ts", "risk.ts", "scenario.ts", "storage.ts", "types.ts", "wilson.ts", "policy.ts", "num.ts", "index.ts"]));
  });

  it("no comment of src/engine/adjustments calls the 3PL's amount a cost, a loss, a margin or a profit (or names a buy rate) except to deny it", () => {
    for (const [file, text] of sources) {
      for (const paragraph of comments(text)) expect(offending(paragraph), `${file}`).toEqual([]);
    }
  });

  it("no string literal, message or code of src/engine/adjustments uses those words at all", () => {
    for (const [file, text] of sources) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const literal of code.match(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? []) expect(literal, `${file}`).not.toMatch(BANNED);
      expect(code, `${file}`).not.toMatch(BANNED);
    }
  });

  it("the golden rule book (RULES.md) follows the same rule", () => {
    expect(offending(readFileSync(rulesPath, "utf8"))).toEqual([]);
  });

  it("the check itself catches the wording it was written for (the 3PL's own possible cost) and lets a denial through", () => {
    expect(offending("The 3PL's own possible cost of cases it decides one by one: 0 to the whole bucket.")).toHaveLength(1);
    expect(offending("This is the loss on absorbed amounts.")).toHaveLength(1);
    expect(offending("An absorbed amount earns a margin of zero.")).toHaveLength(1);
    expect(offending("The profit is the buy rate minus the customer rate.")).toHaveLength(1);
    expect(offending("Foregone revenue, 0 to the whole bucket.")).toEqual([]);
    expect(offending("Absorbed is foregone revenue, never a loss, cost or margin.")).toEqual([]);
    expect(offending("What would it cost the customer if the package is corrected?")).toEqual([]);
    expect(offending("The engine never reads, stores or computes a carrier buy rate.")).toEqual([]);
  });
});

describe("the rule book says what v2 and amendment A2 say (F11)", () => {
  const rulesMd = readFileSync(rulesPath, "utf8");

  it("A7 states that a no_adjustment scenario has a not_triggered fee whether or not a rule exists, before the no-candidate step", () => {
    const a7 = rulesMd.slice(rulesMd.indexOf("### A7 Separate fee component"), rulesMd.indexOf("### A8 Basis"));
    expect(a7).toMatch(/0\. status `no_adjustment` -> `not_triggered`, whether or not a fee rule exists/);
    expect(a7.indexOf("0. status `no_adjustment`")).toBeLessThan(a7.indexOf("1. no candidate"));
    expect(a7).toMatch(/price plateau[^]*not_configured/);
  });

  it("C2 keys an affected package by customer, carrier and reference, and no longer says 'packageRef ?? id'", () => {
    expect(rulesMd).not.toMatch(/packageRef \?\? id/);
    expect(rulesMd).toMatch(/distinct `\(brandId[^`]*carrierCode, packageRef\)`/);
    expect(rulesMd).toMatch(/one reference on TWO customers/);
  });

  it("D4 words the range as foregone revenue, 0 to the whole bucket", () => {
    expect(rulesMd).toMatch(/foregone revenue at customer-facing rates, 0 to the whole bucket/);
  });
});
