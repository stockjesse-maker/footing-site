import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ALLOWED_NEGATIVE_SENTENCES, findBannedTokens } from "@/lib/adjustments/customer-copy";
// The barrel and the view import nothing server-only: this file has no mock of "server-only", and the imports below would throw if they needed one.
import { ExampleView, buildExampleModel, exampleHeading, type ExampleViewExample } from "@/components/adjustments/customer";
import { EXAMPLE_ID, TENANT, caseOnlyPayload, chargedPayload, example, flattenHeadings, headings, hidden, html, mixedPayload, readableAttributes, text, textOf, withoutAllowedSentences, type Payload } from "./adjustments-customer-support";

/**
 * The shared example view: one example as a customer reads it, in every state. Rendered with react-dom/server; no browser. Figures are the
 * fictional hand-derived ones of the customer review (5 lb corrected to 20 lb: 17.83 declared, 23.13 corrected, 5.30 difference, 2.00 fee).
 */
const view = (e: ExampleViewExample, over: Record<string, unknown> = {}) => createElement(ExampleView, { example: e, tenantName: TENANT, ...over });
const render = (e: ExampleViewExample, over: Record<string, unknown> = {}) => html(view(e, over));

const packages = (...p: [string, ...string[]][]) => p.map(([weightLb, l, w, h]) => ({ weightLb, ...(l ? { lengthIn: l, widthIn: w, heightIn: h } : {}) }));

describe("a current example", () => {
  it("is headed by a sentence made from the declared and corrected package, with the provenance line under it", () => {
    const t = text(view(example()));
    expect(t).toContain("If a 5 lb package is corrected to 20 lb");
    expect(t).toContain("UPS Ground, zone 2, home delivery. Example package chosen by Acme 3PL. Not taken from your orders.");
    const h = headings(render(example()));
    expect(h[0]).toEqual({ level: 2, text: "If a 5 lb package is corrected to 20 lb" });
  });

  it("groups the charges the 3PL passes on under 'Charged to you', with the approved sentences, and adds them together only there", () => {
    const t = text(view(example()));
    expect(t).toContain("Charged to you");
    expect(t).toContain("Shipping charge difference $5.30 At your rates this package would cost $23.13 to ship instead of $17.83. Acme 3PL passes this difference on to you.");
    expect(t).toContain("Separate adjustment fee $2.00 Acme 3PL charges this fee to you when a correction is made.");
    expect(t).toContain("Both charges together $7.30");
    expect(t).not.toContain("Decided case by case");
    expect(t).not.toContain("if charged");
  });

  it("puts a charge the 3PL decides case by case in its own group, says it is 'if charged', and NEVER adds it to a charged amount", () => {
    const t = text(view(example({ payload: mixedPayload() })));
    expect(t).toContain("Charged to you");
    expect(t).toContain("Decided case by case");
    expect(t).toContain("Separate adjustment fee $2.00 if charged Acme 3PL reviews each case and decides whether to charge it. This example does not mean it will be charged, and it does not mean it will not be.");
    // 5.30 + 2.00 = 7.30 must appear nowhere: a charged amount and an if-charged amount are never summed. One charged line has no subtotal at all.
    expect(t).not.toContain("7.30");
    expect(t).not.toContain("Both charges together");
    // The if-charged line sits after the charged group, never inside it.
    expect(t.indexOf("Charged to you")).toBeLessThan(t.indexOf("Decided case by case"));
    expect(t.indexOf("$5.30")).toBeLessThan(t.indexOf("Decided case by case"));
    expect(t.indexOf("Separate adjustment fee")).toBeGreaterThan(t.indexOf("Decided case by case"));
  });

  it("shows no subtotal for a lone charge, nor for two charges that are both decided case by case", () => {
    const lone = chargedPayload({ components: [{ kind: "postage_difference", handling: "pass_through", amount: "5.30" }] });
    expect(text(view(example({ payload: lone })))).not.toContain("Both charges together");
    const bothCase = chargedPayload({
      components: [
        { kind: "postage_difference", handling: "manual_approval", amount: "5.30", declaredTotal: "17.83", correctedTotal: "23.13" },
        { kind: "separate_fee", handling: "manual_approval", amount: "2.00" },
      ],
    });
    const t = text(view(example({ payload: bothCase })));
    expect(t).not.toContain("Both charges together");
    expect(t).not.toContain("7.30");
    expect(t).not.toContain("Charged to you");
    expect(t).toContain("Shipping charge difference $5.30 if charged");
    expect(t).toContain("Separate adjustment fee $2.00 if charged");
  });

  it("a fee-only example has no 'At your rates' sentence and no shipping charge difference line", () => {
    const t = text(view(example({ payload: caseOnlyPayload() })));
    expect(t).not.toContain("At your rates");
    expect(t).not.toContain("Shipping charge difference");
    expect(t).toContain("Decided case by case");
  });

  it("puts the charges in a fixed order (shipping difference first) whatever order the payload lists them", () => {
    const flipped = chargedPayload({ components: [...chargedPayload().components].reverse() });
    const t = text(view(example({ payload: flipped })));
    expect(t.indexOf("Shipping charge difference")).toBeLessThan(t.indexOf("Separate adjustment fee"));
  });

  it("prints the footer on every example: rates, shared and shown-until dates and the standing sentences", () => {
    const t = text(view(example()));
    expect(t).toContain("Based on Acme 3PL's rates in effect on Oct 16, 2026 (rate card effective Jan 1, 2026). Shared by Acme 3PL on Oct 16, 2026 and shown until Dec 31, 2026.");
    expect(t).toContain("Not an invoice and not a prediction of how often adjustments happen.");
    expect(t).toContain("Not included in any total or cost per order in your models.");
    expect(t).toContain("Order fees that are a percentage of shipping are not recalculated here.");
    expect(t).toContain("This lists only charges Acme 3PL passes on to you; it is not a promise that no other charge can apply.");
    expect(textOf(render(example({ payload: mixedPayload() })))).toContain("passes on to you or decides case by case; it is not a promise");
    expect(render(example())).toMatch(/<footer\b/);
  });

  it("shows the 3PL's note as plain text labelled as from the 3PL, only when there is one, and keeps its line breaks", () => {
    expect(text(view(example()))).not.toContain("Note from");
    expect(text(view(example({ note: "   " })))).not.toContain("Note from");
    const h = render(example({ note: "Ground only.\nCall us with questions." }));
    expect(textOf(h)).toContain("Note from Acme 3PL Ground only. Call us with questions.");
    expect(h).toContain("whitespace-pre-line");
    expect(h).toContain("Ground only.\nCall us with questions.");
  });

  it("shows the 3PL's own title under the generated heading only when it says something else", () => {
    expect(headings(render(example({ title: "Standard small box" })))[0]).toEqual({ level: 2, text: "If a 5 lb package is corrected to 20 lb" });
    expect(text(view(example({ title: "Standard small box" })))).toContain("Standard small box");
    const same = textOf(render(example()));
    expect(same.split("If a 5 lb package is corrected to 20 lb")).toHaveLength(2);
  });

  it("falls back to 'your 3PL' when the tenant name is missing", () => {
    const t = text(createElement(ExampleView, { example: example(), tenantName: "" }));
    expect(t).toContain("Example package chosen by your 3PL.");
    expect(t).toContain("Your 3PL charges this fee to you when a correction is made.");
    expect(t).not.toContain("undefined");
    expect(t).not.toContain("null");
  });
});

describe("how the heading reads", () => {
  const payload = (declared: Payload["input"]["declared"]["packages"], corrected: Payload["input"]["corrected"]["packages"], over: Partial<Payload["input"]> = {}): Payload =>
    chargedPayload({ input: { ...chargedPayload().input, declared: { packages: declared }, corrected: { packages: corrected }, ...over } });
  const model = (p: Payload) => buildExampleModel(p, TENANT)!;

  it("names a weight correction, a size correction and both, in inches and pounds", () => {
    expect(model(payload(packages(["5.000000"]), packages(["20"]))).heading).toBe("If a 5 lb package is corrected to 20 lb");
    expect(model(payload(packages(["5", "12", "10", "8"]), packages(["5", "16", "12", "10"]))).heading).toBe("If a 12 x 10 x 8 in package is measured at 16 x 12 x 10 in");
    expect(model(payload(packages(["5", "12", "10", "8"]), packages(["20", "16", "12", "10"]))).heading).toBe("If a 5 lb, 12 x 10 x 8 in package is corrected to 20 lb, 16 x 12 x 10 in");
  });

  it("says what stayed the same", () => {
    expect(model(payload(packages(["5", "12", "10", "8"]), packages(["20", "12", "10", "8"]))).context).toBe("Size stays 12 x 10 x 8 in.");
    expect(model(payload(packages(["5", "12", "10", "8"]), packages(["5", "16", "12", "10"]))).context).toBe("Weight stays 5 lb.");
    expect(model(payload(packages(["5"]), packages(["20"]))).context).toBeNull();
    expect(model(payload(packages(["5", "12", "10", "8"]), packages(["20", "16", "12", "10"]))).context).toBeNull();
  });

  it("handles a size that was not given (dimensions added where none were known)", () => {
    expect(model(payload(packages(["5"]), packages(["5", "16", "12", "10"]))).heading).toBe("If a package with no size given is measured at 16 x 12 x 10 in");
    expect(model(payload(packages(["5"]), packages(["20", "16", "12", "10"]))).heading).toBe("If a 5 lb package with no size given is corrected to 20 lb, 16 x 12 x 10 in");
  });

  it("writes weights with sensible precision and no float arithmetic", () => {
    expect(model(payload(packages(["0.0625"]), packages(["1.5"]))).heading).toBe("If a 0.0625 lb package is corrected to 1.5 lb");
    expect(model(payload(packages(["5.000000"]), packages(["20.000000"]))).heading).toBe("If a 5 lb package is corrected to 20 lb");
    expect(model(payload(packages(["12.5", "10.0", "8", "6"]), packages(["12.5", "12.25", "8", "6"]))).heading).toBe("If a 10 x 8 x 6 in package is measured at 12.25 x 8 x 6 in");
  });

  it("lists every package of a shipment, and says how many were corrected", () => {
    const two = model(payload(packages(["5"], ["3"]), packages(["20"], ["3"])));
    expect(two.heading).toBe("If 1 of the 2 packages in a shipment is corrected");
    expect(two.packages).toEqual(["Package 1: weight corrected from 5 lb to 20 lb.", "Package 2: 3 lb, not corrected."]);
    expect(two.provenance).toContain("Example shipment chosen by Acme 3PL.");
    const all = model(payload(packages(["5"], ["3"], ["1"]), packages(["6"], ["4"], ["2"])));
    expect(all.heading).toBe("If the 3 packages in a shipment are corrected");
    const some = model(payload(packages(["5"], ["3"], ["1"]), packages(["6"], ["4"], ["1"])));
    expect(some.heading).toBe("If 2 of the 3 packages in a shipment are corrected");
    const sized = model(payload(packages(["5", "12", "10", "8"], ["3", "6", "6", "6"]), packages(["5", "16", "12", "10"], ["3", "6", "6", "6"])));
    expect(sized.packages).toEqual(["Package 1: size measured at 16 x 12 x 10 in instead of 12 x 10 x 8 in.", "Package 2: 3 lb, 6 x 6 x 6 in, not corrected."]);
    const both = model(payload(packages(["5", "12", "10", "8"], ["3"]), packages(["20", "16", "12", "10"], ["3"])));
    expect(both.packages![0]).toBe("Package 1: weight corrected from 5 lb to 20 lb, size measured at 16 x 12 x 10 in instead of 12 x 10 x 8 in.");
  });

  it("renders a shipment's packages as a labelled list, and its totals as a shipment", () => {
    const p = payload(packages(["5"], ["3"]), packages(["20"], ["3"]));
    const h = render(example({ payload: p }));
    expect(headings(h).map((x) => x.text)).toContain("Packages in this example");
    expect(textOf(h)).toContain("Package 2: 3 lb, not corrected.");
    expect(textOf(h)).toContain("At your rates this shipment would cost $23.13 to ship instead of $17.83.");
    expect(h).toMatch(/<ul[^>]*>\s*<li>Package 1:/);
  });

  it("is available to the share form as a suggested title, and is null for a payload that cannot be written", () => {
    expect(exampleHeading(chargedPayload())).toBe("If a 5 lb package is corrected to 20 lb");
    expect(exampleHeading(payload(packages(["abc"]), packages(["20"])))).toBeNull();
  });

  it("refuses a payload it cannot write in words (a part-size, a mismatched package count, a bad amount), never a half-written example", () => {
    const partial = chargedPayload({ input: { ...chargedPayload().input, declared: { packages: [{ weightLb: "5", lengthIn: "12" }] } } });
    expect(buildExampleModel(partial, TENANT)).toBeNull();
    const mismatch = chargedPayload({ input: { ...chargedPayload().input, corrected: { packages: packages(["20"], ["3"]) } } });
    expect(buildExampleModel(mismatch, TENANT)).toBeNull();
    expect(buildExampleModel(chargedPayload({ components: [{ kind: "separate_fee", handling: "pass_through", amount: "2" }] }), TENANT)).toBeNull();
    expect(buildExampleModel(chargedPayload({ components: [] }), TENANT)).toBeNull();
  });
});

describe("the states that hide the amounts", () => {
  it("under review: one neutral sentence and the shared date, no amount, no title, no note, no payload, even if the database sent them", () => {
    const leaky = hidden("under_review", { title: "SECRET TITLE $5.30", note: "SECRET NOTE", payload: chargedPayload() });
    const h = render(leaky);
    const t = textOf(h);
    expect(t).toContain("Acme 3PL is updating this example, so the amounts are hidden for now.");
    expect(t).toContain("Shared by Acme 3PL on Oct 16, 2026.");
    expect(t).toContain("Under review");
    expect(t).toContain("Example");
    expect(h).not.toContain("$");
    for (const secret of ["SECRET", "5.30", "17.83", "23.13", "2.00", "If a 5 lb", "Charged to you", "UPS Ground", "Note from"]) expect(t, secret).not.toContain(secret);
    expect(h).not.toMatch(/<footer\b/);
  });

  it("expired: when it was shown until, that it is no longer current, and what to do; no amount", () => {
    const h = render(hidden("expired", { validThrough: "2026-11-30", payload: chargedPayload(), note: "SECRET NOTE", title: "SECRET TITLE" }));
    const t = textOf(h);
    expect(t).toContain("This example was shown until Nov 30, 2026 and is no longer current.");
    expect(t).toContain("Ask Acme 3PL for a current example.");
    expect(t).toContain("No longer current");
    expect(t).toContain("Shared by Acme 3PL on Oct 16, 2026.");
    expect(h).not.toContain("$");
    expect(t).not.toContain("SECRET");
  });

  it("a current example whose payload is missing or cannot be written fails closed to the under-review sentence (never a blank or partial example)", () => {
    for (const e of [example({ payload: null }), example({ payload: chargedPayload({ components: [] }) }), example({ validThrough: "soon" }), example({ pricedOn: "yesterday" })]) {
      const h = render(e);
      expect(textOf(h)).toContain("is updating this example, so the amounts are hidden for now.");
      expect(h).not.toContain("$");
    }
  });

  it("has a heading whatever the state, so the article is always labelled", () => {
    for (const e of [example(), hidden("under_review"), hidden("expired")]) {
      const h = render(e);
      expect(headings(h)).toHaveLength(headings(h).filter((x) => x.level >= 2).length);
      const id = /<article[^>]*aria-labelledby="([^"]+)"/.exec(h)?.[1];
      expect(id).toBeTruthy();
      expect(h).toContain(`id="${id}"`);
    }
  });
});

describe("what a customer can never read here", () => {
  const FORBIDDEN = /\b(?:incidence|frequency|monthly|annual(?:ly)?|per (?:shipment|month|year|1,000|thousand)|a month|a year|each month|every month|how many|rate of|exposure|absorbed|loss|margin|buy rate|carrier cost)\b/i;

  it("renders no incidence, count, rate, per-shipment, monthly or annual wording or figure, whatever the database sends along", () => {
    const sentinel = { ...example({ payload: mixedPayload(), note: "Ground only." }), incidence: "7.3719", exposure: "91317.29", monthly: "1460.00", count: 42, internalNote: "SENTINEL_PRIVATE", ruleKey: "SENTINEL_RULE", pins: { ruleVersionIds: ["x"] } };
    const payload = { ...sentinel.payload!, absorbed: "91317.29", notBilledToCustomer: "42.6143", input: { ...sentinel.payload!.input, ruleKey: "SENTINEL_RULE", serviceId: "SENTINEL_ID" } };
    for (const e of [sentinel, { ...sentinel, payload }]) {
      const h = render(e as unknown as ExampleViewExample);
      const clean = withoutAllowedSentences(textOf(h));
      expect(clean).not.toMatch(FORBIDDEN);
      expect(clean).not.toMatch(/\d+(?:\.\d+)?\s?%/);
      for (const s of ["7.3719", "91317", "1460", "42.6143", "SENTINEL", "ruleKey", "incidence"]) expect(h, s).not.toContain(s);
    }
  });

  it("shows only the numbers it was given: the amounts, the two totals, the weights, the sizes, the zone and the dates", () => {
    const t = textOf(render(example()));
    const numbers = new Set([...t.matchAll(/\d+(?:,\d{3})*(?:\.\d+)?/g)].map((m) => m[0]));
    // 5, 20 lb; zone 2; $5.30, $2.00, $7.30; $23.13, $17.83; 3PL; the dates (2026, 16, 1, 31 ...).
    const allowed = new Set(["5", "20", "2", "5.30", "2.00", "7.30", "23.13", "17.83", "3", "2026", "16", "1", "31"]);
    for (const n of numbers) expect(allowed.has(n), `unexpected number ${n} in: ${t}`).toBe(true);
  });

  it("shows no id, rule key, version number or service id of any kind", () => {
    const h = render(example());
    expect(h).not.toContain(EXAMPLE_ID);
    expect(h).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(h).not.toMatch(/ruleKey|rule_key|versionId|serviceId|brandId|tenantId/);
  });

  it("is free of every banned word, in the text AND in every attribute a screen reader or a tooltip reads, in every state", () => {
    const states: ExampleViewExample[] = [
      example(),
      example({ payload: mixedPayload(), note: "Ground only." }),
      example({ payload: caseOnlyPayload() }),
      hidden("under_review"),
      hidden("expired"),
      example({ payload: null }),
    ];
    for (const mode of ["customer", "staffPreview"] as const) {
      for (const e of states) {
        const h = render(e, { mode });
        // The whole markup, class names and ids included: not just the visible text.
        expect(findBannedTokens(h), `${mode} ${e.state}`).toEqual([]);
        for (const a of readableAttributes(h)) expect(findBannedTokens(a), a).toEqual([]);
        expect(h).not.toMatch(/scenario/i);
      }
    }
  });

  it("uses each approved negative sentence only where approved, and no other sentence with a banned word", () => {
    const h = render(example({ payload: mixedPayload() }));
    const rest = withoutAllowedSentences(textOf(h));
    expect(findBannedTokens(rest)).toEqual([]);
    for (const s of ALLOWED_NEGATIVE_SENTENCES) expect(textOf(h).split(s).length - 1, s).toBeLessThanOrEqual(1);
  });
});

describe("hostile text is plain text", () => {
  const HOSTILE_TITLE = `<img src=x onerror=alert(1)> "quoted" & <script>alert('t')</script>`;
  const HOSTILE_NOTE = `<script>alert(1)</script>\n<a href="javascript:alert(2)">click</a> &amp; <b>bold</b> "x" 'y'`;

  it("escapes the title, the note and the 3PL's name, so none of it can become markup", () => {
    const h = html(createElement(ExampleView, { example: example({ title: HOSTILE_TITLE, note: HOSTILE_NOTE }), tenantName: `<b>Evil</b> & "Co"` }));
    expect(h).not.toContain("<img");
    expect(h).not.toContain("<script");
    expect(h).not.toContain("<a href");
    expect(h).not.toContain("<b>");
    expect(h).not.toContain("javascript:alert(2)\"");
    expect(h).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(h).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(h).toContain("&lt;b&gt;Evil&lt;/b&gt;");
    // It reads back exactly as typed.
    const t = textOf(h);
    expect(t).toContain(HOSTILE_TITLE);
    expect(t).toContain("<a href=\"javascript:alert(2)\">click</a> &amp; <b>bold</b>");
    // No attribute the 3PL's text could have closed early.
    expect([...h.matchAll(/\son[a-z]+="/g)]).toEqual([]);
  });

  it("treats hostile package or service names the same way", () => {
    const p = chargedPayload({ input: { ...chargedPayload().input, service: { carrier: `<i>UPS</i>`, service: `"><svg onload=alert(1)>` } } });
    const h = render(example({ payload: p }));
    expect(h).not.toContain("<svg");
    expect(h).not.toContain("<i>");
    expect(h).toContain("&lt;svg onload=alert(1)&gt;");
  });
});

describe("it reads at 360 px: stacked, wrapping, nothing wider than the phone", () => {
  it("is a description list in a card: no table, tabular amounts, text that wraps anywhere, no fixed widths", () => {
    const h = render(example({ payload: mixedPayload(), note: "Ground only." }));
    expect(h).not.toMatch(/<table|<thead|<tbody|<tr[\s>]|<td[\s>]|<th[\s>]|role="(?:table|grid|row|cell)"/);
    expect(h).toMatch(/<dl\b/);
    expect(h).toMatch(/<dt\b/);
    expect(h).toMatch(/<dd\b/);
    expect(h).toContain("[overflow-wrap:anywhere]");
    // Amounts: tabular numerals.
    for (const m of h.matchAll(/<span class="([^"]*)">(\$\d[\d,]*\.\d{2})<\/span>/g)) expect(m[1], m[2]).toContain("tabular");
    expect([...h.matchAll(/<span class="[^"]*tabular[^"]*">\$/g)].length).toBe(2);
    // With the subtotal of two charged lines, three.
    expect([...render(example()).matchAll(/<span class="[^"]*tabular[^"]*">\$/g)].length).toBe(3);
    // Mobile first: one column, two from the small breakpoint up; nothing forces a width or stops a line from wrapping.
    expect(h).toContain("sm:grid-cols-[minmax(0,1fr)_auto]");
    expect(h).not.toMatch(/whitespace-nowrap|\b(?:min-w|w)-\[\d|\bw-\d{2,}\b|overflow-x-/);
  });

  it("keeps each description list valid: only dt and dd inside groups, no stray paragraphs", () => {
    const h = render(example());
    for (const dl of h.matchAll(/<dl\b[^>]*>([\s\S]*?)<\/dl>/g)) {
      const inner = dl[1]!.replace(/<div\b[^>]*>|<\/div>/g, "");
      expect(inner).not.toMatch(/<p\b/);
      expect(inner).toMatch(/^\s*<dt\b/);
    }
  });
});

describe("the heading outline and the roles", () => {
  it("makes the example an h2 and its groups h3 (the page supplies the h1); the shipment's package list is an h3 too", () => {
    const h = headings(render(example({ payload: mixedPayload() })));
    expect(h).toEqual([
      { level: 2, text: "If a 5 lb package is corrected to 20 lb" },
      { level: 3, text: "Charged to you" },
      { level: 3, text: "Decided case by case" },
    ]);
    const multi = chargedPayload({ input: { ...chargedPayload().input, declared: { packages: packages(["5"], ["3"]) }, corrected: { packages: packages(["20"], ["3"]) } } });
    expect(headings(render(example({ payload: multi }))).map((x) => x.level)).toEqual([2, 3, 3]);
  });

  it("is one article labelled by its heading; the groups add no landmarks and no ids of their own that could repeat", () => {
    const h = render(example({ payload: mixedPayload() }));
    expect((h.match(/<article\b/g) ?? []).length).toBe(1);
    expect((h.match(/<section\b|role="region"|<aside\b|<nav\b/g) ?? []).length).toBe(0);
    const ids = [...h.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(/aria-labelledby="([^"]+)"/.exec(h)?.[1]).toBe("example-title");
  });

  it("takes a position-based id prefix so several examples on one page never share an id", () => {
    const a = render(example(), { idPrefix: "example-0" });
    const b = render(example(), { idPrefix: "example-1" });
    expect(a).toContain('id="example-0-title"');
    expect(b).toContain('id="example-1-title"');
    expect(a).not.toContain("example-1-title");
  });

  it("says state in words as well as colour: a badge with text for under review and for no longer current", () => {
    expect(render(hidden("under_review"))).toMatch(/>Under review</);
    expect(render(hidden("expired"))).toMatch(/>No longer current</);
  });
});

describe("staffPreview mode: the same example, nothing added, nothing taken away", () => {
  const states: [string, ExampleViewExample][] = [
    ["charged", example()],
    ["mixed with a note", example({ payload: mixedPayload(), note: "Ground only.\nCall us." })],
    ["case by case only", example({ payload: caseOnlyPayload() })],
    ["under review", hidden("under_review")],
    ["expired", hidden("expired")],
  ];

  it("renders markup identical to the customer's except the heading level (h3 and h4 under the 3PL page's h1 and h2)", () => {
    for (const [name, e] of states) {
      const customer = render(e);
      const preview = render(e, { mode: "staffPreview" });
      expect(flattenHeadings(preview), name).toBe(flattenHeadings(customer));
      expect(preview, name).not.toBe(customer);
      expect(textOf(preview), name).toBe(textOf(customer));
    }
  });

  it("moves each heading one level down, and no more", () => {
    const customer = headings(render(example({ payload: mixedPayload() })));
    const preview = headings(render(example({ payload: mixedPayload() }), { mode: "staffPreview" }));
    expect(preview.map((h) => h.text)).toEqual(customer.map((h) => h.text));
    expect(preview.map((h) => h.level)).toEqual([3, 4, 4]);
    expect(customer.map((h) => h.level)).toEqual([2, 3, 3]);
    expect(headings(render(example(), { mode: "staffPreview" })).some((h) => h.level === 1)).toBe(false);
  });

  it("adds no staff frame, no private note, no hidden-charge list and no preview label of its own (the caller owns the frame)", () => {
    const t = textOf(render(example({ payload: mixedPayload() }), { mode: "staffPreview" }));
    for (const s of ["Preview", "Not shown to them", "Private note", "private", "Only your team", "absorb", "staff", "internal", "Customer will read this"]) expect(t.toLowerCase(), s).not.toContain(s.toLowerCase());
    expect(render(example(), { mode: "staffPreview" })).not.toMatch(/role="region"|data-testid|<section\b/);
  });

  it("lets a caller pick the heading level directly", () => {
    expect(headings(render(example(), { headingLevel: 3 })).map((h) => h.level)).toEqual([3, 4]);
    expect(headings(render(example(), { mode: "staffPreview", headingLevel: 2 })).map((h) => h.level)).toEqual([2, 3]);
  });

  it("shows the share date the caller passes, so a preview reads as the example would on the day it is shared", () => {
    const t = textOf(render(example({ publishedAt: "2026-10-20" }), { mode: "staffPreview" }));
    expect(t).toContain("Shared by Acme 3PL on Oct 20, 2026");
  });
});
