import { describe, expect, it } from "vitest";
import * as copy from "@/lib/adjustments/customer-copy";
import {
  ALLOWED_NEGATIVE_SENTENCES,
  BANNED_CUSTOMER_TOKENS,
  addMoney,
  componentExplanation,
  componentSentence,
  emptyText,
  expiredNextStep,
  expiredText,
  findBannedTokens,
  footerDates,
  footerNotes,
  formatDimensionsIn,
  formatDollars,
  formatExampleDate,
  formatWeightLb,
  hubCardDescription,
  loadFailedText,
  noteLabel,
  normalizeDecimal,
  pageIntro,
  provenanceLine,
  serviceLabel,
  threePl,
  underReviewText,
} from "@/lib/adjustments/customer-copy";

/**
 * The customer's wording as fixed templates. The approved strings of the customer review (ADDITIONS, the ten key strings) are asserted
 * verbatim with the figures of its fuel-v1 example (5 lb corrected to 20 lb: 17.83 declared, 23.13 corrected, difference 5.30; fee 2.00).
 * Every template is then run across every kind, handling, tenant name and shape and scanned for the banned words, with the three
 * approved negative sentences the only exemption.
 */
const T = "Acme 3PL";

describe("the approved strings, word for word", () => {
  it("1. the page's description", () => {
    expect(pageIntro(T)).toBe(
      "Examples of charges Acme 3PL may add after a package ships if its weight or size turns out to be different from what was entered at the time. Each example is a package Acme 3PL chose, priced from your rate card. They show how a charge is worked out, not what will happen to your orders, and they are not invoices.",
    );
  });

  it("2. the provenance line, with and without a zone, home and business delivery", () => {
    expect(provenanceLine({ service: "UPS Ground", zone: 2, residential: true, tenantName: T, shipment: false })).toBe("UPS Ground, zone 2, home delivery. Example package chosen by Acme 3PL. Not taken from your orders.");
    expect(provenanceLine({ service: "UPS Ground", zone: null, residential: false, tenantName: T, shipment: false })).toBe("UPS Ground, business delivery. Example package chosen by Acme 3PL. Not taken from your orders.");
    expect(provenanceLine({ service: "UPS Ground", zone: 0, residential: false, tenantName: T, shipment: false })).toContain("UPS Ground, zone 0, business delivery.");
    // A shipment of more than one package says so.
    expect(provenanceLine({ service: "UPS Ground", zone: 2, residential: true, tenantName: T, shipment: true })).toContain("Example shipment chosen by Acme 3PL.");
  });

  it("3. the two charged lines", () => {
    expect(componentSentence({ kind: "postage_difference", handling: "pass_through", amount: "5.30", tenantName: T, declaredTotal: "17.83", correctedTotal: "23.13" })).toBe(
      "Shipping charge difference: $5.30. At your rates this package would cost $23.13 to ship instead of $17.83. Acme 3PL passes this difference on to you.",
    );
    expect(componentSentence({ kind: "separate_fee", handling: "pass_through", amount: "2.00", tenantName: T })).toBe("Separate adjustment fee: $2.00. Acme 3PL charges this fee to you when a correction is made.");
  });

  it("4. the fee decided case by case", () => {
    expect(componentSentence({ kind: "separate_fee", handling: "manual_approval", amount: "2.00", tenantName: T })).toBe(
      "Separate adjustment fee: $2.00 if charged. Acme 3PL reviews each case and decides whether to charge it. This example does not mean it will be charged, and it does not mean it will not be.",
    );
  });

  it("5. the footer: the review's wording, with 'Shared by' for the date the 3PL shared it (the page has no later confirmation)", () => {
    const dates = footerDates({ tenantName: T, pricedOn: "2026-10-16", ratesEffectiveFrom: "2026-10-16", sharedOn: "2026-10-16", validThrough: "2026-12-31" });
    expect(dates).toBe("Based on Acme 3PL's rates in effect on Oct 16, 2026. Shared by Acme 3PL on Oct 16, 2026 and shown until Dec 31, 2026.");
    expect(footerNotes(T, false).join(" ")).toBe(
      "Not an invoice and not a prediction of how often adjustments happen. Not included in any total or cost per order in your models. Order fees that are a percentage of shipping are not recalculated here. This lists only charges Acme 3PL passes on to you; it is not a promise that no other charge can apply.",
    );
  });

  it("5b. the footer's last sentence names the case-by-case group only when the example has one", () => {
    expect(footerNotes(T, true).at(-1)).toBe("This lists only charges Acme 3PL passes on to you or decides case by case; it is not a promise that no other charge can apply.");
    expect(footerNotes(T, false).at(-1)).not.toContain("case by case");
  });

  it("5c. the rate card's own date is shown only when it differs from the day the example was priced", () => {
    expect(footerDates({ tenantName: T, pricedOn: "2026-10-16", ratesEffectiveFrom: "2026-01-01", sharedOn: "2026-10-15T09:00:00.123456+00:00", validThrough: "2026-12-14" })).toBe(
      "Based on Acme 3PL's rates in effect on Oct 16, 2026 (rate card effective Jan 1, 2026). Shared by Acme 3PL on Oct 15, 2026 and shown until Dec 14, 2026.",
    );
    // A date that cannot be read is never printed as something else: no footer at all.
    expect(footerDates({ tenantName: T, pricedOn: "soon", ratesEffectiveFrom: "2026-01-01", sharedOn: "2026-10-16", validThrough: "2026-12-14" })).toBeNull();
  });

  it("6. the states that hide the amounts, and the empty list", () => {
    expect(underReviewText(T)).toBe("Acme 3PL is updating this example, so the amounts are hidden for now.");
    expect(expiredText("2026-12-31")).toBe("This example was shown until Dec 31, 2026 and is no longer current.");
    expect(expiredText("never")).toBeNull();
    expect(expiredNextStep(T)).toBe("Ask Acme 3PL for a current example.");
    expect(emptyText(T)).toBe("Acme 3PL has not shared any adjustment examples yet. That does not mean no adjustment can ever be charged. Ask Acme 3PL how corrected weights and sizes are handled for your account.");
    expect(copy.EMPTY_TITLE).toBe("No examples shared yet");
    expect(loadFailedText(T)).toBe("We could not load your adjustment examples. Reload the page to try again. If it keeps happening, contact Acme 3PL.");
  });

  it("names: the page, the groups, the components, the labels", () => {
    expect(copy.PAGE_TITLE).toBe("Possible adjustments");
    expect(copy.GROUP_CHARGED).toBe("Charged to you");
    expect(copy.GROUP_CASE_BY_CASE).toBe("Decided case by case");
    expect(copy.LABEL_POSTAGE_DIFFERENCE).toBe("Shipping charge difference");
    expect(copy.LABEL_SEPARATE_FEE).toBe("Separate adjustment fee");
    expect(copy.HUB_CARD_CTA).toBe("See examples of adjustments");
    expect(noteLabel(T)).toBe("Note from Acme 3PL");
    expect(copy.ADJUSTMENTS_PATH).toBe("/portal/model/adjustments");
  });
});

describe("the postage-difference line when the example has no totals, or a shipment of several packages", () => {
  it("leaves out the 'At your rates' sentence unless BOTH totals are present (a half-made-up comparison is never printed)", () => {
    const base = { kind: "postage_difference" as const, handling: "pass_through" as const, tenantName: T };
    expect(componentExplanation(base)).toBe("Acme 3PL passes this difference on to you.");
    expect(componentExplanation({ ...base, declaredTotal: "17.83" })).toBe("Acme 3PL passes this difference on to you.");
    expect(componentExplanation({ ...base, correctedTotal: "23.13" })).toBe("Acme 3PL passes this difference on to you.");
    expect(componentExplanation({ ...base, declaredTotal: "17.83", correctedTotal: "23.13", shipment: true })).toBe(
      "At your rates this shipment would cost $23.13 to ship instead of $17.83. Acme 3PL passes this difference on to you.",
    );
  });

  it("a shipping charge difference decided case by case says who decides and promises nothing", () => {
    expect(componentSentence({ kind: "postage_difference", handling: "manual_approval", amount: "5.30", tenantName: T, declaredTotal: "17.83", correctedTotal: "23.13" })).toBe(
      "Shipping charge difference: $5.30 if charged. At your rates this package would cost $23.13 to ship instead of $17.83. Acme 3PL reviews each case and decides whether to pass this difference on to you. This example does not mean it will be charged, and it does not mean it will not be.",
    );
  });

  it("an amount that is not dollars and cents makes no sentence (never a guess)", () => {
    for (const bad of ["5.3", "5", "-5.30", "$5.30", "5,30", "", "NaN", "1e3", "12345678.00"]) {
      expect(componentSentence({ kind: "separate_fee", handling: "pass_through", amount: bad, tenantName: T }), bad).toBeNull();
    }
  });
});

describe("the 3PL's name", () => {
  it("comes from the tenant name, trimmed and on one line", () => {
    expect(threePl("  Acme   3PL ")).toEqual({ name: "Acme 3PL", start: "Acme 3PL" });
  });

  it("falls back to 'your 3PL' (capitalised at the start of a sentence) when there is none", () => {
    for (const none of [undefined, null, "", "   "]) {
      expect(threePl(none)).toEqual({ name: "your 3PL", start: "Your 3PL" });
    }
    expect(emptyText(undefined)).toBe("Your 3PL has not shared any adjustment examples yet. That does not mean no adjustment can ever be charged. Ask your 3PL how corrected weights and sizes are handled for your account.");
    expect(underReviewText(null)).toBe("Your 3PL is updating this example, so the amounts are hidden for now.");
    expect(componentSentence({ kind: "separate_fee", handling: "pass_through", amount: "2.00", tenantName: "" })).toBe("Separate adjustment fee: $2.00. Your 3PL charges this fee to you when a correction is made.");
    expect(pageIntro(undefined)).toContain("Examples of charges your 3PL may add");
    expect(footerDates({ tenantName: undefined, pricedOn: "2026-10-16", ratesEffectiveFrom: "2026-10-16", sharedOn: "2026-10-16", validThrough: "2026-12-31" })).toContain("Based on your 3PL's rates in effect on");
  });
});

describe("money, weight, size and dates", () => {
  it("formats dollars from a string, with thousands separators, and nothing else", () => {
    expect(formatDollars("5.30")).toBe("$5.30");
    expect(formatDollars("0.56")).toBe("$0.56");
    expect(formatDollars("0.01")).toBe("$0.01");
    expect(formatDollars("1234.50")).toBe("$1,234.50");
    expect(formatDollars("1234567.89")).toBe("$1,234,567.89");
    expect(formatDollars("007.10")).toBe("$7.10");
    for (const bad of ["0.5", "5", ".50", "-0.56", "+1.00", "1.000", "1,000.00", "12345678.00", " 1.00", "1.00 ", "abc"]) expect(formatDollars(bad), bad).toBeNull();
  });

  it("adds charges exactly, in whole cents (no float drift), and refuses what is not an amount", () => {
    expect(addMoney(["5.30", "2.00"])).toBe("7.30");
    expect(addMoney(["0.10", "0.20"])).toBe("0.30");
    expect(addMoney(["0.99", "0.01"])).toBe("1.00");
    expect(addMoney(["9999999.99", "0.01"])).toBe("10000000.00");
    expect(addMoney(["19.99", "19.99", "19.99"])).toBe("59.97");
    expect(addMoney(["5.30", "2"])).toBeNull();
    expect(addMoney([])).toBe("0.00");
  });

  it("shows a decimal as written, minus zeros that mean nothing, and rounds nothing", () => {
    const table: [string, string | null][] = [
      ["5", "5"],
      ["5.0", "5"],
      ["5.000000", "5"],
      ["20.0", "20"],
      ["012.50", "12.5"],
      ["0.0625", "0.0625"],
      ["0.002205", "0.002205"],
      ["0", "0"],
      ["0.000000", "0"],
      ["123456.123456", "123456.123456"],
      ["5.", null],
      [".5", null],
      ["-1", null],
      ["1,5", null],
      ["1234567", null],
      ["5.1234567", null],
      ["", null],
    ];
    for (const [input, want] of table) expect(normalizeDecimal(input), input).toBe(want);
    expect(formatWeightLb("5.000000")).toBe("5 lb");
    expect(formatWeightLb("5.125")).toBe("5.125 lb");
    expect(formatWeightLb("x")).toBeNull();
    expect(formatDimensionsIn("12.0", "10", "8.50")).toBe("12 x 10 x 8.5 in");
    expect(formatDimensionsIn("12", "ten", "8")).toBeNull();
  });

  it("writes dates unambiguously, reads a timestamp in UTC (dropping microseconds, never rounding them up), and refuses what is not a date", () => {
    expect(formatExampleDate("2026-10-16")).toBe("Oct 16, 2026");
    expect(formatExampleDate("2026-01-05")).toBe("Jan 5, 2026");
    expect(formatExampleDate("2026-10-15T09:00:00.123456+00:00")).toBe("Oct 15, 2026");
    expect(formatExampleDate("2026-12-31T23:59:59.999999+00:00")).toBe("Dec 31, 2026");
    expect(formatExampleDate("2026-10-16T01:00:00+02:00")).toBe("Oct 15, 2026");
    expect(formatExampleDate("2026-10-16T09:00:00Z")).toBe("Oct 16, 2026");
    for (const bad of ["", "soon", "2026-13-45", "16/10/2026", "2026-10"]) expect(formatExampleDate(bad), bad).toBeNull();
  });

  it("names a service once: the service alone when it already starts with the carrier", () => {
    expect(serviceLabel("UPS", "UPS Ground")).toBe("UPS Ground");
    expect(serviceLabel("UPS", "Ground")).toBe("UPS Ground");
    expect(serviceLabel("FedEx", "fedex Home Delivery")).toBe("fedex Home Delivery");
    expect(serviceLabel("", "Ground")).toBe("Ground");
    expect(serviceLabel("  ", " Ground ")).toBe("Ground");
  });
});

describe("the banned words", () => {
  it("are the fourteen of the customer review", () => {
    expect([...BANNED_CUSTOMER_TOKENS].sort()).toEqual(["absorb", "average", "bill", "billed", "expected", "forecast", "guarantee", "incidence", "invoice", "likely", "loss", "exposure", "scenario", "will"].sort());
  });

  it("are found by the scan, as whole words and with their endings, in any case (the scan itself is tested before it is trusted)", () => {
    for (const token of BANNED_CUSTOMER_TOKENS) {
      expect(findBannedTokens(`This ${token} here`), token).not.toEqual([]);
      expect(findBannedTokens(`THIS ${token.toUpperCase()}.`), token).not.toEqual([]);
    }
    for (const stem of ["billing", "bills", "invoices", "invoiced", "guaranteed", "expects", "expectation", "averages", "absorbs", "absorbed", "losses", "forecasts", "scenarios"]) {
      expect(findBannedTokens(`about ${stem} today`), stem).not.toEqual([]);
    }
    // Whole words: a name that merely starts like one is not a hit.
    expect(findBannedTokens("Willow Logistics")).toEqual([]);
    expect(findBannedTokens("Scenic Route Shipping")).toEqual([]);
  });

  it("exempt exactly three approved sentences, each tenant-independent, and nothing near them", () => {
    expect(ALLOWED_NEGATIVE_SENTENCES).toEqual([
      "They show how a charge is worked out, not what will happen to your orders, and they are not invoices.",
      "This example does not mean it will be charged, and it does not mean it will not be.",
      "Not an invoice and not a prediction of how often adjustments happen.",
    ]);
    for (const s of ALLOWED_NEGATIVE_SENTENCES) {
      expect(findBannedTokens(s), s).toEqual([]);
      // The same sentence with one word changed is NOT exempt.
      expect(findBannedTokens(s.replace("not", "never")), s).not.toEqual([]);
      expect(findBannedTokens(`${s} It will be charged.`), s).toEqual(["will"]);
    }
    expect(findBannedTokens("This example will be charged.")).toEqual(["will"]);
    expect(findBannedTokens("Not an invoice.")).toEqual(["invoice"]);
  });

  it("appear in no template, whatever it is filled with", () => {
    const tenants = ["Acme 3PL", "Harbor Fulfillment Co.", "", undefined, "Z"];
    const kinds = ["postage_difference", "separate_fee"] as const;
    const handlings = ["pass_through", "manual_approval"] as const;
    const out: string[] = [];
    for (const tenant of tenants) {
      out.push(pageIntro(tenant), hubCardDescription(tenant), emptyText(tenant), loadFailedText(tenant), underReviewText(tenant), expiredNextStep(tenant), noteLabel(tenant));
      out.push(...footerNotes(tenant, true), ...footerNotes(tenant, false));
      out.push(footerDates({ tenantName: tenant, pricedOn: "2026-10-16", ratesEffectiveFrom: "2026-01-01", sharedOn: "2026-10-16T09:00:00+00:00", validThrough: "2026-12-31" })!);
      for (const shipment of [true, false]) {
        for (const residential of [true, false]) for (const zone of [null, 2, 8]) out.push(provenanceLine({ service: "UPS Ground", zone, residential, tenantName: tenant, shipment }));
        for (const kind of kinds)
          for (const handling of handlings)
            for (const totals of [true, false]) {
              const args = { kind, handling, tenantName: tenant, shipment, ...(totals ? { declaredTotal: "17.83", correctedTotal: "23.13" } : {}) };
              out.push(componentExplanation(args), componentSentence({ ...args, amount: "5.30" })!);
            }
      }
    }
    out.push(expiredText("2026-12-31")!);
    expect(out.length).toBeGreaterThan(100);
    for (const s of out) expect(findBannedTokens(s), s).toEqual([]);
  });

  it("appear in no exported constant of the copy file (a new constant is scanned the day it is added)", () => {
    const constants = Object.entries(copy).filter(([, v]) => typeof v === "string") as [string, string][];
    expect(constants.length).toBeGreaterThan(15);
    for (const [name, value] of constants) expect(findBannedTokens(value), name).toEqual([]);
  });

  it("appear in the heading and package templates either", () => {
    const out = [
      copy.headingWeight("5 lb", "20 lb"),
      copy.headingSize("12 x 10 x 8 in", "16 x 12 x 10 in"),
      copy.headingSizeNotGiven("16 x 12 x 10 in"),
      copy.headingWeightAndSize("5 lb", "12 x 10 x 8 in", "20 lb", "16 x 12 x 10 in"),
      copy.headingWeightAndSizeNotGiven("5 lb", "20 lb", "16 x 12 x 10 in"),
      copy.headingShipment(1, 2),
      copy.headingShipment(2, 2),
      copy.headingShipment(3, 5),
      copy.contextWeightStays("5 lb"),
      copy.contextSizeStays("12 x 10 x 8 in"),
      copy.packageWeightChange(1, "5 lb", "20 lb"),
      copy.packageSizeChange(1, "12 x 10 x 8 in", "16 x 12 x 10 in"),
      copy.packageSizeChange(2, null, "16 x 12 x 10 in"),
      copy.packageBothChange(1, "5 lb", "20 lb", "12 x 10 x 8 in", "16 x 12 x 10 in"),
      copy.packageBothChange(1, "5 lb", "20 lb", null, "16 x 12 x 10 in"),
      copy.packageUnchanged(2, "3 lb", null),
      copy.packageUnchanged(2, "3 lb", "10 x 8 x 6 in"),
      copy.HEADING_FALLBACK,
    ];
    for (const s of out) expect(findBannedTokens(s), s).toEqual([]);
  });
});

describe("no number about how often, how many or how much a month ever appears in a template", () => {
  it("(frequency, counts, rates, per-shipment, monthly and annual wording is absent; the one 'how often' is inside an approved negation)", () => {
    const strings = [pageIntro(T), hubCardDescription(T), emptyText(T), underReviewText(T), ...footerNotes(T, true), ...footerNotes(T, false), ...Object.values(copy).filter((v): v is string => typeof v === "string")];
    for (const s of strings) {
      const cleaned = ALLOWED_NEGATIVE_SENTENCES.reduce((acc, sentence) => acc.split(sentence).join(" "), s);
      expect(cleaned, s).not.toMatch(/\b(?:incidence|frequency|monthly|annual(?:ly)?|per (?:shipment|month|year|1,000|thousand)|a month|a year|each month|every month|how many|how often|percent of your|rate of)\b/i);
      expect(cleaned, s).not.toMatch(/\d+(?:\.\d+)?\s?%/);
    }
  });
});
