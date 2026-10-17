/**
 * Everything a customer reads on the "Possible adjustments" page, as fixed templates, plus the number and date helpers that fill them.
 * Nothing here is "use server": the page, the shared example view (used by the customer page and by the 3PL's preview), the hub card
 * and the tests all read this one file, so what the 3PL previews is the text the customer gets.
 *
 * Wording rules (design v2 section 6, customer review F5/F8 and its ADDITIONS):
 * - Say who decides and never promise. "Charge", never the words for a bill or an invoice. No "up to" unless a true upper bound exists.
 * - Plain component names: "Shipping charge difference" and "Separate adjustment fee". One clause defines a correction on the page.
 * - The word "scenario" never appears (the customer's own saved models already use it). "Absorbed" never appears: a charge the 3PL
 *   does not pass on is simply not listed, and the footer says that the list is not a promise that no other charge can apply.
 * - Amounts come from the published example only, in cents as strings; nothing is added, rounded or converted here except the one
 *   subtotal that exists inside the "Charged to you" group, which is exact integer-cent arithmetic.
 *
 * Banned in every generated or dynamic string (see `findBannedTokens`): bill, billed, invoice, will, guarantee, expected, average, likely,
 * absorb, incidence, loss, exposure, forecast, scenario. The three approved sentences that carry such a word inside a NEGATION are listed
 * in `ALLOWED_NEGATIVE_SENTENCES` and tested verbatim; nothing else is exempt.
 */

// ---------------------------------------------------------------------------
// Names of things
// ---------------------------------------------------------------------------
export const PAGE_TITLE = "Possible adjustments";
export const BACK_LINK_LABEL = "Model Costs";
/** The portal route of the page (the hub card links here). */
export const ADJUSTMENTS_PATH = "/portal/model/adjustments";
export const HUB_CARD_CTA = "See examples of adjustments";

export const GROUP_CHARGED = "Charged to you";
export const GROUP_CASE_BY_CASE = "Decided case by case";
export const PACKAGES_HEADING = "Packages in this example";
export const LABEL_POSTAGE_DIFFERENCE = "Shipping charge difference";
export const LABEL_SEPARATE_FEE = "Separate adjustment fee";
/** Shown after an amount the 3PL decides on case by case. */
export const IF_CHARGED = "if charged";
/** The label of a subtotal; it exists only inside "Charged to you" and only when that group has two lines. */
export const SUBTOTAL_LABEL = "Both charges together";

/** What an example is called while its amounts are hidden (the database sends the same word). */
export const NEUTRAL_TITLE = "Example";
export const BADGE_UNDER_REVIEW = "Under review";
export const BADGE_EXPIRED = "No longer current";

/** The words that stand for the 3PL when its name is not known. */
export const FALLBACK_3PL = "your 3PL";

export interface ThreePl {
  /** For the middle of a sentence ("Acme 3PL", "your 3PL"). */
  name: string;
  /** For the start of a sentence ("Acme 3PL", "Your 3PL"). */
  start: string;
}

/** The signed-in customer's 3PL, from the tenant name; "your 3PL" when there is none. */
export function threePl(name: string | null | undefined): ThreePl {
  const n = typeof name === "string" ? name.replace(/\s+/g, " ").trim() : "";
  if (!n) return { name: FALLBACK_3PL, start: FALLBACK_3PL.charAt(0).toUpperCase() + FALLBACK_3PL.slice(1) };
  return { name: n, start: n };
}

/** "Acme 3PL's", and "Northwind Logistics'" for a name that ends in s (the 3PL's name is its tenant name; many end in s). */
export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

// ---------------------------------------------------------------------------
// The approved sentences that contain a banned word inside a negation
// ---------------------------------------------------------------------------
export const SENTENCE_NOT_WHAT_HAPPENS = "They show how a charge is worked out, not what will happen to your orders, and they are not invoices.";
export const SENTENCE_NOT_A_PROMISE_TO_CHARGE = "This example does not mean it will be charged, and it does not mean it will not be.";
export const SENTENCE_NOT_AN_INVOICE = "Not an invoice and not a prediction of how often adjustments happen.";

/** The only sentences exempt from the banned-token scan, each tenant-independent and approved word for word in the customer review. */
export const ALLOWED_NEGATIVE_SENTENCES: readonly string[] = [SENTENCE_NOT_WHAT_HAPPENS, SENTENCE_NOT_A_PROMISE_TO_CHARGE, SENTENCE_NOT_AN_INVOICE];

/** The words no customer string may contain (whole words and their endings: "billed", "invoices", "expectation"...). */
export const BANNED_CUSTOMER_TOKENS = ["bill", "billed", "invoice", "will", "guarantee", "expected", "average", "likely", "absorb", "incidence", "loss", "exposure", "forecast", "scenario"] as const;

const BANNED_PATTERN = /\b(?:bill\w*|invoice\w*|guarantee\w*|expect\w*|average\w*|absorb\w*|loss\w*|forecast\w*|scenario\w*|will|likely|incidence|exposure)\b/gi;

/**
 * The banned words found in `text` once every allowed negative sentence is removed (an empty list means clean). Used by the unit tests on
 * every template and on the rendered markup, and available to any caller that composes customer text.
 */
export function findBannedTokens(text: string): string[] {
  let rest = text;
  for (const sentence of ALLOWED_NEGATIVE_SENTENCES) rest = rest.split(sentence).join(" ");
  return [...rest.matchAll(BANNED_PATTERN)].map((m) => m[0].toLowerCase());
}

// ---------------------------------------------------------------------------
// Page and hub card
// ---------------------------------------------------------------------------
/** The page's description: the one clause that says what a correction is, then what the examples are and are not. */
export function pageIntro(tenantName: string | null | undefined): string {
  const t = threePl(tenantName).name;
  return [
    `Examples of charges ${t} may add after a package ships if its weight or size turns out to be different from what was entered at the time.`,
    `Each example is a package ${t} chose, priced from your rate card.`,
    SENTENCE_NOT_WHAT_HAPPENS,
  ].join(" ");
}

/** The hub card's one-line description. */
export function hubCardDescription(tenantName: string | null | undefined): string {
  const t = threePl(tenantName).name;
  return `Examples of charges ${t} may add after a package ships if its weight or size is corrected. They are not part of your cost models.`;
}

/** No example has been shared. Never reads as "no adjustment can ever be charged". */
export const EMPTY_TITLE = "No examples shared yet";
export function emptyText(tenantName: string | null | undefined): string {
  const t = threePl(tenantName);
  return `${t.start} has not shared any adjustment examples yet. That does not mean no adjustment can ever be charged. Ask ${t.name} how corrected weights and sizes are handled for your account.`;
}

/** The examples could not be read: say so (never an empty list) and say what to do. */
export function loadFailedText(tenantName: string | null | undefined): string {
  const t = threePl(tenantName).name;
  return `We could not load your adjustment examples. Reload the page to try again. If it keeps happening, contact ${t}.`;
}

// ---------------------------------------------------------------------------
// Numbers and dates
// ---------------------------------------------------------------------------
const MONEY_RE = /^(\d{1,7})\.(\d{2})$/;
const DECIMAL_RE = /^(\d{1,6})(?:\.(\d{1,6}))?$/;

/** "$1,234.50" from a money string such as "1234.50"; null for anything that is not an amount in dollars and cents. Pure string work: no float arithmetic. */
export function formatDollars(amount: string): string | null {
  const m = MONEY_RE.exec(amount);
  if (!m) return null;
  const whole = String(Number(m[1])).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${whole}.${m[2]}`;
}

/** Adds money strings exactly, in whole cents; null when any is not an amount. */
export function addMoney(amounts: readonly string[]): string | null {
  let cents = 0;
  for (const a of amounts) {
    const m = MONEY_RE.exec(a);
    if (!m) return null;
    cents += Number(m[1]) * 100 + Number(m[2]);
  }
  const whole = Math.floor(cents / 100);
  return `${whole}.${String(cents % 100).padStart(2, "0")}`;
}

/** A decimal string as it reads: no leading zeros, no trailing zeros ("5.000000" is "5", "012.50" is "12.5"); null when it is not a plain decimal. Nothing is rounded. */
export function normalizeDecimal(value: string): string | null {
  const m = DECIMAL_RE.exec(value);
  if (!m) return null;
  const whole = String(Number(m[1]));
  const frac = (m[2] ?? "").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** "5 lb", "0.625 lb": the stored pounds as written, minus trailing zeros. */
export function formatWeightLb(value: string): string | null {
  const n = normalizeDecimal(value);
  return n === null ? null : `${n} lb`;
}

/** "12 x 10 x 8 in": length, width and height as written, minus trailing zeros. */
export function formatDimensionsIn(length: string, width: string, height: string): string | null {
  const parts = [length, width, height].map(normalizeDecimal);
  return parts.some((p) => p === null) ? null : `${parts.join(" x ")} in`;
}

const dateFmt = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

/** "Oct 16, 2026" from a date ("2026-10-16") or a timestamp (read in UTC, the zone the dates were set in); null when it is neither. */
export function formatExampleDate(value: string): string | null {
  const isDate = /^\d{4}-\d{2}-\d{2}$/.test(value);
  // Only the two shapes the database writes: a date, or a timestamp with an offset. Anything looser ("2026-10", "10/16/2026") is not a date here.
  if (!isDate && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  // The database writes microseconds ("...09:00:00.123456+00:00"); a Date reads milliseconds, so the extra digits are dropped (never rounded up into the next day).
  const d = isDate ? new Date(`${value}T00:00:00Z`) : new Date(value.replace(/(\.\d{3})\d+/, "$1"));
  if (Number.isNaN(d.getTime())) return null;
  return dateFmt.format(d);
}

// ---------------------------------------------------------------------------
// One example: heading, provenance, packages
// ---------------------------------------------------------------------------
export const HEADING_FALLBACK = "If a package is corrected";

export const headingWeight = (from: string, to: string) => `If a ${from} package is corrected to ${to}`;
export const headingSize = (from: string, to: string) => `If a ${from} package is measured at ${to}`;
export const headingSizeNotGiven = (to: string) => `If a package with no size given is measured at ${to}`;
export const headingWeightAndSize = (fromWeight: string, fromSize: string, toWeight: string, toSize: string) => `If a ${fromWeight}, ${fromSize} package is corrected to ${toWeight}, ${toSize}`;
export const headingWeightAndSizeNotGiven = (fromWeight: string, toWeight: string, toSize: string) => `If a ${fromWeight} package with no size given is corrected to ${toWeight}, ${toSize}`;
export const headingShipment = (changed: number, total: number) => (changed >= total ? `If the ${total} packages in a shipment are corrected` : `If ${changed} of the ${total} packages in a shipment ${changed === 1 ? "is" : "are"} corrected`);

export const contextWeightStays = (weight: string) => `Weight stays ${weight}.`;
export const contextSizeStays = (size: string) => `Size stays ${size}.`;

/** One line per package of a shipment with more than one package. */
export const packageWeightChange = (n: number, from: string, to: string) => `Package ${n}: weight corrected from ${from} to ${to}.`;
export const packageSizeChange = (n: number, from: string | null, to: string) => (from ? `Package ${n}: size measured at ${to} instead of ${from}.` : `Package ${n}: size measured at ${to}, where no size was given.`);
export const packageBothChange = (n: number, fromWeight: string, toWeight: string, fromSize: string | null, toSize: string) =>
  fromSize
    ? `Package ${n}: weight corrected from ${fromWeight} to ${toWeight}, size measured at ${toSize} instead of ${fromSize}.`
    : `Package ${n}: weight corrected from ${fromWeight} to ${toWeight}, size measured at ${toSize}, where no size was given.`;
export const packageUnchanged = (n: number, weight: string, size: string | null) => (size ? `Package ${n}: ${weight}, ${size}, not corrected.` : `Package ${n}: ${weight}, not corrected.`);

/** "UPS Ground" from the catalog names: the service alone when it already starts with the carrier's name. */
export function serviceLabel(carrier: string, service: string): string {
  const c = carrier.trim();
  const s = service.trim();
  if (!c) return s;
  return s.toLowerCase().startsWith(c.toLowerCase()) ? s : `${c} ${s}`;
}

/** "UPS Ground, zone 2, home delivery. Example package chosen by Acme. Not taken from your orders." (zone only when there is one). */
export function provenanceLine(args: { service: string; zone: number | null; residential: boolean; tenantName: string | null | undefined; shipment: boolean }): string {
  const t = threePl(args.tenantName).name;
  const parts = [args.service, ...(args.zone === null ? [] : [`zone ${args.zone}`]), args.residential ? "home delivery" : "business delivery"];
  return `${parts.join(", ")}. Example ${args.shipment ? "shipment" : "package"} chosen by ${t}. Not taken from your orders.`;
}

// ---------------------------------------------------------------------------
// One charge
// ---------------------------------------------------------------------------
export type ComponentKind = "postage_difference" | "separate_fee";
export type ComponentHandling = "pass_through" | "manual_approval";

export const componentLabel = (kind: ComponentKind) => (kind === "separate_fee" ? LABEL_SEPARATE_FEE : LABEL_POSTAGE_DIFFERENCE);

/**
 * What the 3PL does with the charge, in words that say who decides and promise nothing. When the example carries the two shipping totals
 * the first sentence shows how the difference is made up ("At your rates this package would cost $23.13 to ship instead of $17.83.").
 */
export function componentExplanation(args: { kind: ComponentKind; handling: ComponentHandling; tenantName: string | null | undefined; declaredTotal?: string; correctedTotal?: string; shipment?: boolean }): string {
  const t = threePl(args.tenantName);
  const declared = args.declaredTotal ? formatDollars(args.declaredTotal) : null;
  const corrected = args.correctedTotal ? formatDollars(args.correctedTotal) : null;
  const made = args.kind === "postage_difference" && declared && corrected ? `At your rates this ${args.shipment ? "shipment" : "package"} would cost ${corrected} to ship instead of ${declared}. ` : "";
  if (args.handling === "pass_through") {
    return args.kind === "postage_difference" ? `${made}${t.start} passes this difference on to you.` : `${t.start} charges this fee to you when a correction is made.`;
  }
  return args.kind === "postage_difference"
    ? `${made}${t.start} reviews each case and decides whether to pass this difference on to you. ${SENTENCE_NOT_A_PROMISE_TO_CHARGE}`
    : `${t.start} reviews each case and decides whether to charge it. ${SENTENCE_NOT_A_PROMISE_TO_CHARGE}`;
}

/** The whole line as one sentence group: "Separate adjustment fee: $2.00 if charged. Acme reviews each case ...". The page prints the same pieces in a list. */
export function componentSentence(args: { kind: ComponentKind; handling: ComponentHandling; amount: string; tenantName: string | null | undefined; declaredTotal?: string; correctedTotal?: string; shipment?: boolean }): string | null {
  const amount = formatDollars(args.amount);
  if (amount === null) return null;
  return `${componentLabel(args.kind)}: ${amount}${args.handling === "manual_approval" ? ` ${IF_CHARGED}` : ""}. ${componentExplanation(args)}`;
}

// ---------------------------------------------------------------------------
// The footer
// ---------------------------------------------------------------------------
/** "Based on Acme's rates in effect on Oct 16, 2026 (rate card effective Jan 1, 2026). Shared by Acme on Oct 16, 2026 and shown until Dec 31, 2026." */
export function footerDates(args: { tenantName: string | null | undefined; pricedOn: string; ratesEffectiveFrom: string; sharedOn: string; validThrough: string }): string | null {
  const t = threePl(args.tenantName).name;
  const priced = formatExampleDate(args.pricedOn);
  const rates = formatExampleDate(args.ratesEffectiveFrom);
  const shared = formatExampleDate(args.sharedOn);
  const until = formatExampleDate(args.validThrough);
  if (!priced || !rates || !shared || !until) return null;
  const based = priced === rates ? `Based on ${possessive(t)} rates in effect on ${priced}.` : `Based on ${possessive(t)} rates in effect on ${priced} (rate card effective ${rates}).`;
  return `${based} ${sharedByLine(t, shared)} and shown until ${until}.`;
}

/** "Shared by Acme on Oct 16, 2026" (no full stop: the footer continues the sentence, the hidden states end it). */
export const sharedByLine = (tenant: string, date: string) => `Shared by ${tenant} on ${date}`;

export const FOOTER_NOT_INCLUDED = "Not included in any total or cost per order in your models.";
export const FOOTER_PERCENT_FEES = "Order fees that are a percentage of shipping are not recalculated here.";

/** The standing caveats under every example. The last says what the list leaves out; it names the case-by-case group only when the example has one. */
export function footerNotes(tenantName: string | null | undefined, hasCaseByCase: boolean): string[] {
  const t = threePl(tenantName).name;
  return [
    SENTENCE_NOT_AN_INVOICE,
    FOOTER_NOT_INCLUDED,
    FOOTER_PERCENT_FEES,
    hasCaseByCase
      ? `This lists only charges ${t} passes on to you or decides case by case; it is not a promise that no other charge can apply.`
      : `This lists only charges ${t} passes on to you; it is not a promise that no other charge can apply.`,
  ];
}

// ---------------------------------------------------------------------------
// States that hide the amounts
// ---------------------------------------------------------------------------
/** The 3PL is updating the example (a rate, a rule or a decision changed): one neutral state whatever the cause. */
export function underReviewText(tenantName: string | null | undefined): string {
  return `${threePl(tenantName).start} is updating this example, so the amounts are hidden for now.`;
}

export function expiredText(validThrough: string): string | null {
  const d = formatExampleDate(validThrough);
  return d ? `This example was shown until ${d} and is no longer current.` : null;
}

export const expiredNextStep = (tenantName: string | null | undefined) => `Ask ${threePl(tenantName).name} for a current example.`;

/** "Note from Acme" above the 3PL's optional plain-text note. */
export const noteLabel = (tenantName: string | null | undefined) => `Note from ${threePl(tenantName).name}`;
