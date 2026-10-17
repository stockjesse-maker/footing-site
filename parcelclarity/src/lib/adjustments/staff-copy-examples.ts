/**
 * Wording of the 3PL's Examples and Risk screens (Milestone 5, design v2 section 7). NOT a "use server" module: client components import it.
 * Everything here is for the 3PL's own team, except the sentences a customer reads inside the preview frame, which come from
 * `customer-copy.ts` through the shared `ExampleView`, never from this file.
 *
 * Wording rules (the unit tests scan these strings):
 *  - the 3PL's own amounts are never called a cost, a loss, a margin or a profit. "Not billed to the customer" is revenue the 3PL chose not to
 *    bill, at its own customer-facing rates. The one place the word "carrier cost" appears is the permanent footnote that says the product
 *    never uses it (`NOT_BILLED_FOOTNOTE`);
 *  - the word "scenario" is not used: an example is an example, an estimate is an estimate;
 *  - an unknown figure reads "Not computed" or "Not decided", never $0.00;
 *  - handling is always words plus a badge, never colour alone;
 *  - every money field says "Enter what your customer is charged, never what the carrier bills you.".
 */
import type { Basis, ConfidenceLevel, Direction, E4, FeeState, Handling, PolicyComponent, ScenarioNotice, ScenarioStatus, ScenarioWarning } from "@/engine/adjustments/types";
import type { UnavailableReason } from "@/engine/types";
import { CONFIDENCE_LABELS, HANDLING_BADGES, HANDLING_LABELS, POLICY_COMPONENT_LABELS, formatCount, formatE4, formatIsoDate } from "./staff-copy";

// ---------------------------------------------------------------------------
// Money and number display (strings from the engine are already cents; E4 is ten-thousandths of a dollar)
// ---------------------------------------------------------------------------
const CENTS_DIGITS = 2;
const E4_PER_DOLLAR = 10_000;
const E4_DECIMALS = 4;

// Puts a comma between thousands of a run of digits: "1234567" becomes "1,234,567"; "123" stays "123" (a position inside a group is never matched).
const THOUSANDS = /\B(?=(\d{3})+(?!\d))/g;
const group3 = (digits: string): string => digits.replace(THOUSANDS, ",");

// A plain decimal with an optional minus: "5.30" and "-1.20" match; "5,30", "$5.30" and "1e3" do not.
const PLAIN_DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;
// A non-negative decimal: "1234.5" matches; "-1" and "12 3" do not.
const NON_NEGATIVE_DECIMAL = /^(\d+)(\.\d+)?$/;

/** "5.30" is "$5.30", "1234.5" is "$1,234.50", "-1.20" is "-$1.20". Text that is not a plain decimal is returned as it came, never as a guess. */
export function usd(amount: string): string {
  const m = PLAIN_DECIMAL.exec(amount.trim());
  if (!m) return amount;
  const frac = (m[3] ?? "").padEnd(CENTS_DIGITS, "0").slice(0, CENTS_DIGITS);
  return `${m[1]}$${group3(m[2]!)}.${frac}`;
}

/** The same, and a negative amount says "credit" in words (never a colour or a minus sign alone). */
export function usdWords(amount: string): string {
  const text = usd(amount);
  return text.startsWith("-") ? `${text} credit` : text;
}

/** Four decimals, for the figures that are small per package: 1,460 a month over 10,000 packages is "$0.1460". */
export function formatE4Precise(e4: E4): string {
  const abs = Math.abs(e4);
  const dollars = Math.floor(abs / E4_PER_DOLLAR);
  const frac = String(abs % E4_PER_DOLLAR).padStart(E4_DECIMALS, "0");
  return `${e4 < 0 && abs > 0 ? "-" : ""}$${group3(String(dollars))}.${frac}`;
}

/** "10000" is "10,000"; "1234.5" is "1,234.5". */
export function formatDecimalText(text: string): string {
  const m = NON_NEGATIVE_DECIMAL.exec(text.trim());
  return m ? `${group3(m[1]!)}${m[2] ?? ""}` : text;
}

// ---------------------------------------------------------------------------
// Words that are used on more than one screen
// ---------------------------------------------------------------------------
export const MONEY_FIELD_FIRST_LINE = "Enter what your customer is charged, never what the carrier bills you.";
export const CUSTOMER_WILL_READ = "Customer will read this";
export const TEAM_ONLY = "Only your team can read this";
export const POLICIES_HREF = "/app/adjustments/policies";
export const policiesHref = (brandId: string | null): string => (brandId ? `${POLICIES_HREF}?customer=${encodeURIComponent(brandId)}` : POLICIES_HREF);

/** The four buckets of who pays, with the staff labels. The second is a range, never an assumed approval share. */
export const BUCKET_LABELS = {
  customerPays: "Charged to the customer",
  decidedCaseByCase: "Decided case by case",
  notBilledToCustomer: "Not billed to the customer (at your customer rates)",
  notDecided: "Not decided yet",
} as const;

export const BUCKET_HELP = {
  customerPays: "You pass this on to the customer under your agreement.",
  decidedCaseByCase: "You review each case and decide whether to charge it.",
  notBilledToCustomer: "Revenue you chose not to bill, counted at your customer rates.",
  notDecided: "You have not chosen who pays yet.",
} as const;

export const BUCKET_ORDER = ["customerPays", "decidedCaseByCase", "notBilledToCustomer", "notDecided"] as const;
export type BucketKey = (typeof BUCKET_ORDER)[number];

/** Permanent footnote under every set of buckets. */
export const NOT_BILLED_FOOTNOTE = "Not billed to the customer is revenue you chose not to bill, not your carrier cost; ParcelClarity never uses carrier cost.";

const HANDLING_WORD_TABLE: Record<Handling | "mixed", string> = {
  ...HANDLING_LABELS,
  unconfigured: "Not decided",
  mixed: "Handled in more than one way",
};
export const HANDLING_WORDS = (h: Handling | "mixed"): string => HANDLING_WORD_TABLE[h];
export const HANDLING_BADGE_WORDS = (h: Handling | "mixed"): string => (h === "mixed" ? "Mixed" : HANDLING_BADGES[h]);
export const READ_ONLY_EXAMPLES = "You can view examples and price one, but only administrators can save, share or archive them.";
export const READ_ONLY_RISK = "You can work out an estimate, but only administrators can save or archive one.";

// ---------------------------------------------------------------------------
// Examples: the list
// ---------------------------------------------------------------------------
export const EXAMPLES_INTRO = "Price a package that is corrected after labelling, at one customer's rates. Share the result with that customer, or keep it for your own estimates.";
export const EXAMPLES_EMPTY_TITLE = "No examples yet";
export const EXAMPLES_EMPTY_BODY = "Price a package that is corrected after labelling, then share it with a customer.";
export const BUILD_EXAMPLE = "Build an example";
export const buildExampleFor = (customer: string): string => `Build an example for ${customer}`;
export const FILTER_LABEL = "Show examples for";
export const FILTER_ALL = "All customers";
export const FILTER_BUTTON = "Show";
export const FILTER_CLEAR = "Show all customers";
export const FILTER_UNKNOWN_CUSTOMER = "That customer was not found, so the list shows every customer.";

export type ExampleStateKey = "current" | "under_review" | "expired" | "retired";
export const EXAMPLE_STATE_LABELS: Record<ExampleStateKey, string> = { current: "Current", under_review: "Under review", expired: "Expired", retired: "Stopped sharing" };
export const EXAMPLE_STATE_TONES: Record<ExampleStateKey, "success" | "warning" | "neutral"> = { current: "success", under_review: "warning", expired: "neutral", retired: "neutral" };
export const EXAMPLE_STATE_HELP: Record<ExampleStateKey, string> = {
  current: "The customer can read the amounts.",
  under_review: "Something this example depends on changed. The customer sees that you are updating it, and the amounts are hidden from them.",
  expired: "The shown-until date has passed. The customer sees that this example has expired.",
  retired: "The customer no longer sees this example. It is kept so you can show what they saw on a given date.",
};

/** What can put a shared example under review, in words for the 3PL (the customer sees one neutral state whatever the cause). */
export const CAUSE_SENTENCES: Record<string, string> = {
  rate_card_changed: "The rate card it was priced on changed.",
  assignment_changed: "The customer's rate card or allowed services changed.",
  rule_changed: "A surcharge or fee rule it depends on changed.",
  exception_changed: "A customer exception on one of its rules changed.",
  zip_list_changed: "A ZIP list it depends on was published again.",
  policy_changed: "A decision on who pays changed.",
  brand_inactive: "The customer is not active.",
  valid_through_passed: "The shown-until date has passed.",
};
export const causeSentence = (code: string): string => CAUSE_SENTENCES[code] ?? "Something it depends on changed.";

export const NEEDS_REVIEW_TITLE = "Needs review";
export const NEEDS_REVIEW_HELP = "The customer cannot read the amounts of these examples until you update them or stop sharing them.";
export const SHARED_TITLE = "Shared with customers";
export const SHARED_EMPTY = "Nothing is shared with a customer right now. Save an example, preview it, then share it.";
export const SAVED_TITLE = "Saved examples";
export const SAVED_EMPTY = "No saved examples. Price a package, then save it.";
export const STOPPED_TITLE = "Stopped sharing";
export const OPEN_EXAMPLE = "Open example";
export const UPDATE_SHARED = "Update shared example";
export const STOP_SHARING = "Stop sharing";
export const ARCHIVE_EXAMPLE = "Archive example";
export const ARCHIVE_CONFIRM = "Archive this example? It leaves your list. A shared copy is not affected.";
export const ARCHIVE_BLOCKED = "Stop sharing before you archive.";
export const stopSharingConfirm = (customer: string): string => `Stop sharing this example with ${customer}? They stop seeing it at once. You can still show what they saw on a given date.`;
export const stopSharingButton = (customer: string): string => `Stop sharing with ${customer}`;
export const EXPLORATION_BADGE = "Exploration only";
export const EXPLORATION_HELP = "Priced without a customer, so it cannot be shared.";
export const SHARED_BADGE = "Shared";
export const ARCHIVED_BADGE = "Archived";
export const SAVED_NOT_SHAREABLE: Record<string, string> = {
  estimate: "An estimate cannot be shared.",
  credit: "A credit cannot be shared.",
  no_change: "Nothing changes, so there is nothing to share.",
  not_priced: "It could not be priced.",
};
export const LOAD_EXAMPLES_FAILED = "the examples";

// ---------------------------------------------------------------------------
// Examples: the builder
// ---------------------------------------------------------------------------
export const BUILDER_TITLE = "Build an example";
export const BUILDER_INTRO = "Say what was labelled and what it was corrected to. You see what the customer is charged under your rates, and who pays each part under your decisions.";
export const CUSTOMER_STEP_TITLE = "Customer";
export const CUSTOMER_LABEL = "Customer";
export const CUSTOMER_PLACEHOLDER = "Choose a customer…";
export const CUSTOMER_NONE = "No customer (explore only)";
export const CUSTOMER_BUTTON = "Use this customer";
export const CUSTOMER_HINT = "The example is priced at this customer's rates, with their exceptions and your decisions for them. It can only be shared with this customer.";
export const CUSTOMER_PICK_FIRST = "Choose a customer to price an example at their rates, or choose no customer to explore a price on a rate card.";
export const NO_CUSTOMERS = "You have no customers yet. Add a customer, assign a rate card, then build an example for them.";
export const EXPLORATION_NOTICE_TITLE = "Exploration only";
export const EXPLORATION_NOTICE = "Without a customer this example is priced on a rate card you choose and cannot be shared with anyone. You can still save it and use it as the one example shipment in a risk estimate.";
export const NO_RATE_CARD_TITLE = "No rate card to price against";
export const noRateCardFor = (customer: string | null): string => (customer ? `${customer} has no active rate card assigned, so nothing can be priced for them. Assign a rate card to this customer first.` : "You have no active rate card. Create and activate one first.");
export const SHIPMENT_TITLE = "Shipment";
export const RATE_CARD_LABEL = "Rate card";
export const RATE_CARD_PLACEHOLDER = "Choose a rate card…";
export const SERVICE_LABEL = "Service";
export const SERVICE_PLACEHOLDER = "Choose a service…";
export const SERVICE_NEEDS_CARD = "Choose a rate card first.";
export const SHIP_DATE_LABEL = "Ship date";
export const SHIP_DATE_HINT = "The example is priced at the rates in effect on this date.";
export const ORIGIN_LABEL = "Ship-from ZIP";
export const DESTINATION_LEGEND = "Send to";
export const DESTINATION_ZIP = "Destination ZIP";
export const DESTINATION_ZONE = "Destination zone";
export const ZONE_HINT = "As printed on the rate card, for example 5.";
export const RESIDENTIAL_LABEL = "Residential address";
export const RESIDENTIAL_HINT = "Delivery to a home rather than a business.";
export const PACKAGES_TITLE = "Packages";
export const PACKAGES_HELP = "The package count stays the same: a correction changes a package, it does not add or remove one.";
export const packageTitle = (n: number): string => `Package ${n}`;
export const ADD_PACKAGE = "Add package";
export const removePackage = (n: number): string => `Remove package ${n}`;
export const DECLARED_LEGEND = "As labelled (declared)";
export const CORRECTED_LEGEND = "Corrected to";
export const CORRECTED_HINT = "Fill in only what changed. Leave a field empty if it did not change.";
export const DECLARED_WEIGHT = "Declared weight";
export const CORRECTED_WEIGHT = "Corrected weight";
export const UNIT_LABEL = "Unit";
export const DIMS_DECLARED = "Declared dimensions (in)";
export const DIMS_CORRECTED = "Corrected dimensions (in)";
export const DIMS_HINT = "Enter all three, or leave them empty.";
export const DIM_NAMES = { length: "Length", width: "Width", height: "Height" } as const;
export const SOURCE_LEGEND = "Where did the declared weight come from?";
export const SOURCE_ENTERED = "A weight that was entered or measured";
export const SOURCE_FALLBACK = "My WMS or scale used a fallback weight";
export const SOURCE_FALLBACK_HELP = "Enter the fallback weight your system used when it printed the label.";
export const FALLBACK_ZERO_REFUSAL = "A label cannot be created at 0 lb; enter the fallback your system used.";
export const PRICE_BUTTON = "Price this example";
export const PRICE_PENDING = "Pricing…";
export const NOTHING_CHANGED = "Enter a corrected weight or corrected dimensions for at least one package.";
export const WEIGHT_NEEDED = "Enter the weight as a number, for example 2.5.";
export const WEIGHT_ZERO = "The weight must be more than zero.";
export const DIMS_NEEDED = "Enter length, width and height, or leave all three empty.";
export const DIM_NUMBER = "Enter each dimension as a number, for example 12.";
export const ZIP_NEEDED = "Enter a 5-digit ZIP code.";
export const ZONE_NEEDED = "Enter the zone as printed on the rate card, for example 5.";
export const DATE_NEEDED = "Enter the date the example is priced on.";
export const SERVICE_NEEDED = "Choose a service.";
export const RATE_CARD_NEEDED = "Choose a rate card.";
export const STALE_RESULT = "You changed the example after pricing it. Price it again to see the new result.";

export const RESULT_TITLE = "Result";
export const RESULT_PENDING = "Pricing the example…";

/** One sentence per status; the engine's own message follows where it has one. */
export const STATUS_TITLES: Record<Exclude<ScenarioStatus, "ok">, string> = {
  no_adjustment: "No adjustment",
  declared_unavailable: "The declared package cannot be priced",
  corrected_unavailable: "The corrected package cannot be priced",
  both_unavailable: "Neither package can be priced",
  invalid_input: "This example cannot be priced as entered",
};
export const NO_ADJUSTMENT_BODY = "The corrected package is charged the same as the declared one and bills the same weight. There is nothing to share.";
export const UNAVAILABLE_BODY = "No amounts are shown. Nothing is estimated, and no other service is used in its place. Fix the package or the date, or check the rate card.";
export const UNAVAILABLE_REASONS: Record<UnavailableReason, string> = {
  service_not_on_rate_card: "The service is not on the rate card",
  zone_unresolved: "The zone could not be worked out",
  zone_ambiguous: "The zone is ambiguous",
  no_rate_for_weight: "The rate card has no rate for this weight",
  no_rate_for_zone: "The rate card has no rate for this zone",
  no_rate_for_origin: "The rate card has no rate for this ship-from ZIP",
  rate_card_not_effective: "The rate card is not in effect on the ship date",
  invalid_input: "A value was not valid",
};
export const SIDE_NAMES = { declared: "Declared package", corrected: "Corrected package" } as const;

export const TYPE_SENTENCE: Record<string, string> = {
  reweight: "A reweigh: the weight is corrected.",
  remeasure: "A remeasure: the dimensions are corrected.",
  combined: "Both together: the weight and the dimensions are corrected.",
};

export const DIRECTION_TEXT: Record<Direction, string | null> = {
  increase: null,
  decrease: "The corrected charge is lower. This is a credit, not an adjustment charge.",
  none: "The corrected package is charged the same shipping charge, so the shipping charge difference is $0.00.",
};
export const CREDIT_NOT_SHAREABLE = "A credit is shown to you only. It cannot be shared with a customer.";

export const BASIS_TEXT: Record<Basis, { title: string; body: string }> = {
  exact: { title: "Exact", body: "Every amount comes from your rate card and your rules." },
  estimate: { title: "Estimate", body: "Part of the price rests on an assumption, such as missing dimensions, a ZIP list that is not loaded, or a charge that could not be decided." },
};
export const ESTIMATE_NOT_SHAREABLE = "An estimate cannot be shared. Add the missing package details and price it again.";
export const undecidedSentence = (amount: string, side: "declared" | "corrected", label: string): string => `The difference includes ${usd(amount)} that could not be decided on the ${side} side (${label}).`;
export const SIDE_WARNING_TEXT: Record<string, string> = {
  dimensions_missing: "Dimensions are missing, so a charge that depends on size could not be decided.",
  dim_divisor_missing: "The rate card has no dimensional-weight divisor for this service.",
  zip_list_missing: "A ZIP list a rule needs is not loaded.",
  assumed_inputs: "Some inputs were assumed.",
  unverified_rule_applied: "A rule that is not verified was applied.",
};

export const COMPONENT_TITLES: Record<PolicyComponent, string> = POLICY_COMPONENT_LABELS;
export const POSTAGE_DETAIL = (declaredTotal: string, correctedTotal: string): string => `At your customer rates the corrected package is charged ${usd(correctedTotal)} instead of ${usd(declaredTotal)}.`;
export const FEE_STATE_TEXT: Record<Exclude<FeeState, "conditional" | "undecided">, string> = {
  waived_for_customer: "Waived for this customer by an exception you set.",
  included_in_rate: "Included in this customer's rate, so nothing is added.",
  not_configured: "No separate adjustment fee is configured, so none is shown. This is not a $0.00 fee.",
  not_triggered: "No separate adjustment fee applies to this example.",
};
export const feeUndecidedText = (upTo: string | undefined): string => (upTo ? `A fee could apply but could not be decided. It could add up to ${usd(upTo)}.` : "A fee could apply but could not be decided.");
export const FEE_MIXED_TEXT = "The parts of this fee are handled differently (for example a reweigh fee and a correction fee), so it cannot be shared as one amount.";
export const FEE_LINES_TITLE = "Fee lines";
const FEE_METHOD_TEXT = { flat: "A flat charge.", per_unit: "A charge per unit." } as const;
export function feeLineText(method: "flat" | "percent" | "per_unit", covered: number[] | null): string {
  if (method !== "percent") return FEE_METHOD_TEXT[method];
  if (!covered || covered.length === 0) return "A percent of the corrected shipping rate.";
  return `A percent of the corrected shipping rate, on ${covered.length === 1 ? "package" : "packages"} ${covered.map((i) => i + 1).join(", ")}.`;
}
export const DECIDE_WHO_PAYS = (component: string): string => `Decide who pays the ${component.toLowerCase()}`;

export const BUCKETS_TITLE = "Who pays";
export const BUCKETS_HELP = "The four amounts add up to the shipping charge difference and the separate fee together. Credits are never added.";
export const SIDES_TITLE = "What each package is charged";
export const BILLABLE_WEIGHT = "Billable weight";

export const SCENARIO_WARNING_TEXT: Record<ScenarioWarning, string> = {
  adjustment_fee_rule_not_conditional: "A reweigh, remeasure or correction fee rule is not set as a conditional charge. It is treated as one here. Fix the rule so every screen agrees.",
  adjustment_fee_rules_stack: "Two or more fee rules apply together. If they should not add up, put them in one exclusivity group.",
  adjustment_fee_rule_excludes_ignored: "A fee rule lists rules it replaces, or another rule replaces it. A fee is charged after shipping, so that is ignored here.",
  adjustment_fee_rule_floor_ignored: "A fee rule has a minimum billable weight. A minimum never changes the shipping charge difference or the fee, so it is ignored here.",
  adjustment_fee_rule_group_ignored: "A fee rule shares an exclusivity group with a rule that is not a fee rule. Exclusivity is kept among fee rules only.",
  adjustment_fee_rule_companion_ignored: "Another rule depends on a fee rule. That rule is left out of this example.",
};
export const NOTICE_TEXT: Record<ScenarioNotice["code"], string> = {
  fuel_on_adjustment_fee_not_modelled: "Fuel on the adjustment fee is not modelled: the fee shown is the fee alone.",
  percent_of_shipping_fees_not_modelled: "Postage only: your fee schedule has percent-of-shipping fees that also move when the shipping charge changes. They are not modelled here.",
};
export const WARNINGS_TITLE = "Check before you rely on this";

export const BLOCKERS_TITLE = "Why this cannot be shared yet";
export const READY_TO_SAVE = "This example can be shared. Save it, then preview what the customer would see.";
export const BLOCKER_TEXT = {
  no_customer: "It was priced without a customer. Choose a customer and price it again.",
  not_priced: "It could not be priced.",
  no_adjustment: "Nothing changes, so there is nothing to share.",
  estimate: ESTIMATE_NOT_SHAREABLE,
  credit: "The corrected charge is lower. This is a credit, not an adjustment charge.",
  mixed: FEE_MIXED_TEXT,
  nothing_visible: "Nothing in it is charged to the customer or decided case by case.",
} as const;
export const blockerUndecided = (component: string): string => `Decide who pays the ${component.toLowerCase()} for this customer first.`;
export const blockerBelowMinimum = (component: string): string => `The ${component.toLowerCase()} is less than $0.01.`;
export const blockerUndecidedCharge = (component: string): string => `The ${component.toLowerCase()} could not be decided.`;

export const SAVE_TITLE = "Save this example";
export const NAME_LABEL = "Name";
export const NAME_HINT = "A name for your own list, for example the customer and the package.";
export const NAME_NEEDED = "Enter a name for the example.";
export const NAME_TOO_LONG = "Use at most 160 characters.";
export const SAVE_BUTTON = "Save example";
export const SAVE_PENDING = "Saving…";
export const SAVED_MESSAGE = "Example saved.";
export const SAVE_MANAGE_ONLY = "Only administrators can save an example.";
export const REPLACING_TITLE = "You are updating a shared example";
export const replacingBody = (customer: string, title: string, sharedOn: string): string => `This replaces "${title}" shared with ${customer} on ${formatIsoDate(sharedOn)}. Price it again at today's rates, save it, then share it. The old one stops being shared when the new one is.`;
export const PRIOR_AMOUNTS = "Amounts in the shared example";
export const PRIOR_NOT_READABLE = "The amounts of the shared example could not be read.";
export function priorLine(label: string, before: string, after: string | null): string {
  if (after === null) return `${label}: ${before} before.`;
  if (before === after) return `${label}: ${after}, the same as before.`;
  return `${label}: ${after} now, ${before} before.`;
}

// ---------------------------------------------------------------------------
// Examples: preview and share
// ---------------------------------------------------------------------------
export const SHARE_TITLE = "Preview and share";
export const PREVIEW_BADGE = "Preview";
export const previewFrameLabel = (customer: string, absorbedCount: number): string =>
  `Preview: exactly what ${customer} will see. Not shown to them: ${absorbedCount > 0 ? `${absorbedCount} ${absorbedCount === 1 ? "charge" : "charges"} you absorb, ` : ""}your private notes, and everything outside this frame.`;
export const WITHHELD_TITLE = (customer: string): string => `Not shown to ${customer}`;
export const WITHHELD_REASONS: Record<string, string> = {
  absorbed: "you do not bill it to them (at your customer rates)",
  not_configured: "no such fee is configured, so there is nothing to show",
  waived_for_customer: "it is waived for this customer",
  included_in_rate: "it is included in their rate",
  not_triggered: "it does not apply to this example",
};
export const withheldLine = (component: string, reason: string): string => `${component}: ${WITHHELD_REASONS[reason] ?? "it is not part of what a customer can see"}.`;
export const WITHHELD_ALWAYS = "Your private note, how often adjustments happen, and anything outside the frame are never shown to them.";
export const SEPARATE_FEE_NOT_CONFIGURED_WARNING = "No separate adjustment fee is configured, so the example shows the shipping charge difference only. The example says it lists only charges you pass on, but a customer may still read it as 'no fee'.";
export const SHARE_WARNING_TEXT: Record<string, string> = { separate_fee_not_configured: SEPARATE_FEE_NOT_CONFIGURED_WARNING };

/** The refusal reasons, one plain sentence per code of the database's build function. */
export const SHARE_PROBLEM_TEXT: Record<string, string> = {
  not_found: "This example could not be found.",
  archived: "This example is archived, so it cannot be shared. Price it again to share it.",
  no_customer: "This example was priced without a customer, so it cannot be shared. Price it again for the customer you want to share it with.",
  wrong_customer: "This example was priced for a different customer. Price it again for this one.",
  customer_inactive: "This customer is not active, so nothing can be shared with them.",
  no_adjustment: "Nothing changes in this example, so there is nothing to share.",
  not_priced: "This example could not be priced, so it cannot be shared.",
  estimate_basis: "This example is an estimate: part of its price rests on an assumption. An estimate cannot be shared. Add the missing package details, such as dimensions, and price it again.",
  not_an_increase: "The corrected charge is lower. This is a credit, not an adjustment charge, so it cannot be shared.",
  rate_card_not_assigned: "The rate card or service this example was priced on is not available to this customer. Price it again.",
  rate_card_not_in_effect: "The rate card this example was priced on is not in effect today. Price it again.",
  context_changed: "A rate, rule, ZIP list or customer exception this example was priced with changed after you saved it. Price it again.",
  policy_changed: "The decision on who pays changed after you saved this example. Price it again.",
  invalid_result: "The saved result is not valid. Price it again.",
  mixed_handling: "The parts of one charge are handled differently, or a decision changed, so it cannot be shared as one amount. Price it again, and check that your fee rules and decisions agree.",
  undecided_policy: "Decide who pays before you share this example.",
  component_below_minimum: "A charge in this example is less than $0.01, so it cannot be shared.",
  component_undecided: "Part of this example could not be decided, so it cannot be shared. Add the missing package details and price it again.",
  no_customer_visible_component: "Nothing in this example is charged to the customer or decided case by case, so there is nothing to share.",
  input_incomplete: "The saved package details are incomplete. Price it again.",
  ended: "A rate, rule or decision this example depends on has already ended. Price it again.",
  payload_invalid: "This example cannot be shown to a customer in its present form.",
};
/** Problems the person fixes by pricing again (so the page offers that), and the one fixed on the Policies screen. */
export const REPRICE_CODES: readonly string[] = [
  "archived",
  "no_customer",
  "wrong_customer",
  "not_priced",
  "estimate_basis",
  "not_an_increase",
  "rate_card_not_assigned",
  "rate_card_not_in_effect",
  "context_changed",
  "policy_changed",
  "invalid_result",
  "mixed_handling",
  "component_undecided",
  "input_incomplete",
  "ended",
];
export const POLICY_CODES: readonly string[] = ["undecided_policy", "mixed_handling", "policy_changed"];
export const SHARE_PROBLEM_FALLBACK = "This example cannot be shared yet.";
export const REFUSED_TITLE = "This example cannot be shared yet";
export const REPRICE_LINK = "Price it again";
export const repriceLinkFor = (customer: string): string => `Price it again for ${customer}`;
export const DECIDE_LINK = "Decide who pays";
export const NO_PREVIEW_TITLE = "No preview";
export const NO_PREVIEW_BODY = "A preview needs a customer. Price this example for the customer you want to share it with.";
export const PREVIEW_FAILED = "The preview could not be built. Reload the page to try again.";
export const NOT_PROJECTABLE = "The preview cannot be shown in its present form. Price the example again.";

export const TITLE_LABEL = "Title";
export const TITLE_HINT = "Shown to the customer above the example. One line, up to 120 characters.";
export const TITLE_NEEDED = "Enter a title for the customer.";
export const TITLE_ONE_LINE = "Use one line.";
export const TITLE_TOO_LONG = "Use at most 120 characters.";
export const NOTE_LABEL = "Note to the customer";
export const NOTE_HINT = "Optional. Up to 300 characters. Do not put your private figures here.";
export const NOTE_TOO_LONG = "Use at most 300 characters.";
export const noteCounter = (n: number): string => `${n} of 300 characters`;
export const PRIVATE_LABEL = "Private note";
export const PRIVATE_HINT = "Optional. Up to 1,000 characters. Kept with the shared example.";
export const PRIVATE_TOO_LONG = "Use at most 1,000 characters.";
export const PLAIN_TEXT_ONLY = "Use plain text: no angle brackets or hidden characters.";
export const VALID_LABEL = "Shown until";
export const validHint = (max: string): string => `Customers see the example until this date. You can shorten it, not lengthen it: the latest is ${formatIsoDate(max)}, the earliest date a rate, rule or decision it depends on ends, or 90 days from today.`;
export const validTooLate = (max: string): string => `Choose ${formatIsoDate(max)} or earlier.`;
export const VALID_TOO_EARLY = "Choose today or a later date.";
export const VALID_NEEDED = "Enter a date.";
export const SHARE_BUTTON = "Share with customer";
export const SHARE_DISABLED_HINT = "Fix the highlighted fields to share.";
export const shareConfirmButton = (customer: string): string => `Share with ${customer}`;
export const shareConfirmText = (customer: string): string =>
  `Share this example with ${customer}? They will see the title, the example package, and the charges they would pay or that you decide case by case. They will not see charges you absorb, how often adjustments happen, or your private notes. Amounts are hidden automatically if your rates or policy change.`;
export const UPDATE_CONFIRM_BUTTON = (customer: string): string => `Update shared example for ${customer}`;
const UPDATE_CONFIRM_TAIL = (customer: string): string =>
  `They will see the title, the example package, and the charges they would pay or that you decide case by case. They will not see charges you absorb, how often adjustments happen, or your private notes. Amounts are hidden automatically if your rates or policy change.`.replace("They", customer === "" ? "They" : "They");
export const updateConfirmText = (customer: string): string => `Replace what ${customer} sees with this version? ${UPDATE_CONFIRM_TAIL(customer)}`;
export const SHARED_OK = (customer: string): string => `Shared with ${customer}. They can read it now.`;
export const UPDATED_OK = (customer: string): string => `Updated. ${customer} now reads this version.`;
export const OLD_NOT_STOPPED = "The new example is shared, but the old one could not be stopped. Stop sharing it from the examples list.";
export const LIVE_NOW_TITLE = "Shared with this customer now";
export const liveNowBody = (customer: string, sharedOn: string, validThrough: string): string => `${customer} can read an earlier copy of this example, shared ${formatIsoDate(sharedOn)} and shown until ${formatIsoDate(validThrough)}. Sharing again replaces it.`;
export const ARCHIVED_NOTICE = "This example is archived, so it cannot be shared. Price it again to share it.";
export const PRIOR_SHARES_TITLE = "Earlier copies";
export const priorShareLine = (sharedOn: string, stoppedOn: string | null): string => `Shared ${formatIsoDate(sharedOn)}${stoppedOn ? `, stopped ${formatIsoDate(stoppedOn)}` : ""}.`;

// ---------------------------------------------------------------------------
// Risk: the list and the form
// ---------------------------------------------------------------------------
export const RISK_INTRO = "Estimate what adjustments could add in a month, from how many packages you ship, how often they are corrected, and what each correction adds. An estimate from the numbers you supply, kept private to your team.";
export const RISK_EMPTY_TITLE = "No estimates yet";
export const RISK_EMPTY_BODY = "Work out what adjustments could add in a month, then save the estimate to find it again.";
export const NEW_ESTIMATE = "New estimate";
export const SAVED_ESTIMATES_TITLE = "Saved estimates";
export const OPEN_ESTIMATE = "Open estimate";
export const ARCHIVE_ESTIMATE = "Archive estimate";
export const ARCHIVE_ESTIMATE_CONFIRM = "Archive this estimate? It leaves your list.";
export const ESTIMATE_ACCOUNT_WIDE = "All customers";
export const estimateListLine = (basis: string | null, counted: string | null): string => `${basis ?? "Basis not recorded"}. ${counted === null ? "Not computed." : `${counted} a month counted here.`}`;
export const LOAD_ESTIMATES_FAILED = "the estimates";

export const RISK_FORM_TITLE = "Work out an estimate";
export const RISK_SCOPE_TITLE = "Customer";
export const RISK_SCOPE_LABEL = "Customer";
export const RISK_SCOPE_ALL = "All customers together";
export const RISK_SCOPE_BUTTON = "Use this customer";
export const RISK_SCOPE_HINT = "Decisions on who pays, history and finished runs are taken for this customer. Choose all customers together to estimate your whole account.";
export const TYPE_LEGEND_LABEL = "Kind of adjustment";
export const TYPE_PLACEHOLDER = "Choose a kind of adjustment…";
export const TYPE_NEEDED = "Choose a kind of adjustment.";
export const TYPE_HINT = "It decides which of your decisions on who pays apply.";

export const VOLUME_LEGEND = "How many packages do you ship?";
export const VOLUME_ENTERED = "I enter the packages a month";
export const VOLUME_RUN = "From a finished run of this customer's file";
export const VOLUME_LABEL = "Packages a month";
export const VOLUME_HINT = "A carrier package is one label. Up to 5,000,000.";
export const VOLUME_NEEDED = "Enter the packages a month as a number.";
export const VOLUME_TOO_MANY = "The monthly volume is limited to 5,000,000 packages.";
export const RUN_LABEL = "Finished run";
export const RUN_PLACEHOLDER = "Choose a run…";
export const RUN_NEEDED = "Choose a run.";
export const RUN_NEEDS_CUSTOMER = "Choose a customer to use one of their finished runs.";
export const RUN_NONE = "This customer has no finished run with a monthly package count yet.";
export const RUN_HINT = "Uses the run's packages a month. Never the modelled orders.";
export const RUN_PROFILE_BLOCK = "That run priced packages on weights worked out from product weights, so it is not a forecast on actual weights. Choose declared weights, or enter the volume yourself.";
export const RUN_PROFILE_UNKNOWN = "That run does not say whether its weights came from product weights, so it cannot be used as a forecast on actual weights. Choose declared weights, or enter the volume yourself.";
export const runOption = (name: string | null, packages: string, finishedOn: string | null): string => `${name ?? "Run"}: ${formatDecimalText(packages)} packages a month${finishedOn ? `, finished ${formatIsoDate(finishedOn)}` : ""}`;

export const INCIDENCE_LEGEND = "How often are packages corrected?";
export const INCIDENCE_HISTORY = "From my imported history";
export const INCIDENCE_ENTERED = "A percentage I enter";
export const INCIDENCE_HISTORY_HELP = "Needs the packages you shipped in the same periods. Without them the estimate says it cannot work out how often.";
export const INCIDENCE_LABEL = "Packages corrected, as a percent of packages shipped";
export const INCIDENCE_HINT = "From 0 to 100, for example 2 for 2 in every 100 packages.";
export const INCIDENCE_NEEDED = "Enter a percentage from 0 to 100.";
export const NO_HISTORY_TITLE = "No history to draw on";
export const NO_HISTORY_BODY = "Your history is empty, so how often and what an adjustment adds cannot come from it. Enter them, or import history first.";
export const HISTORY_FILTERS_TITLE = "Which history to count";
export const HISTORY_FILTERS_HELP = "Applies to every figure you take from history.";
export const HISTORY_TYPE_LABEL = "Records to count";
export const HISTORY_TYPE_SAME = "Only this kind of adjustment";
export const HISTORY_TYPE_ALL = "Every kind of adjustment";
export const HISTORY_CARRIER = "Carrier";
export const HISTORY_SERVICE = "Service";
export const HISTORY_CAUSE = "Cause";
export const HISTORY_FROM = "Ship dates from";
export const HISTORY_TO = "Ship dates to";
export const HISTORY_WINDOW_NEEDED = "Enter both dates of the window, or neither.";
export const HISTORY_WINDOW_ORDER = "The window ends before it starts.";
export const HISTORY_ANY_CARRIER = "Any carrier";
export const HISTORY_ANY_SERVICE = "Any service";
export const HISTORY_ANY_CAUSE = "Any cause";

export const SEVERITY_TITLE = "What does one correction add?";
export const SEVERITY_HELP = "For each part, choose where the amount comes from. Nothing is chosen for you.";
export const SEVERITY_SOURCE_LEGEND = (component: string): string => `${component}: where does the amount come from?`;
export const SEVERITY_HISTORY = "The average from my history";
export const SEVERITY_ENTERED = "An amount I enter";
export const SEVERITY_EXAMPLE = "One example shipment";
export const SEVERITY_EXAMPLE_HELP = "Uses the amount of one saved example. It is one package, so the estimate gives it no confidence rating.";
export const SEVERITY_NEEDED = "Choose where this amount comes from.";
export const SEVERITY_AMOUNT_LABEL = (component: string): string => `${component}: amount for one correction`;
export const SEVERITY_AMOUNT_HINT = "Leave it empty if you do not know it: the estimate then says it cannot compute that part. An empty amount is never counted as $0.00.";
export const SEVERITY_AMOUNT_BAD = "Enter dollars and cents, zero or more (up to 4 decimals).";
export const EXAMPLE_LABEL = (component: string): string => `${component}: saved example`;
export const EXAMPLE_PLACEHOLDER = "Choose a saved example…";
export const EXAMPLE_NEEDED = "Choose a saved example.";
export const EXAMPLE_NONE = "You have no saved example of this kind of adjustment for this customer. Build one first.";
export const exampleOption = (name: string): string => `${name} (one example shipment)`;

export const CREDITS_LEGEND = "How are credits treated?";
export const CREDITS_EXCLUDE = "Leave credits out";
export const CREDITS_MEMO = "Show them in a separate memo, from my history";
export const CREDITS_HELP = "A credit is a correction that lowers the charge. Credits never reduce this estimate either way.";
export const CREDITS_NEEDED = "Choose how credits are treated.";
export const CREDITS_MEMO_NEEDS_HISTORY = "A credits memo needs how often to come from your history.";

export const BASIS_LEGEND = "Which weights is your shipping forecast built on?";
export const BASIS_DECLARED = "The weights sent when labels were printed (declared weights)";
export const BASIS_DECLARED_HELP = "A weight corrected later is not in that forecast, so this estimate adds the shipping charge difference.";
export const BASIS_ACTUAL = "The real, measured weights (actual weights)";
export const BASIS_ACTUAL_HELP = "Shipping charge differences are already in that forecast, so this estimate leaves them out and counts separate adjustment fees only.";
export const BASIS_ERROR = "Choose one. It decides whether postage differences are counted here or are already in your forecast.";
export const ESTIMATE_BUTTON = "Work out the estimate";
export const ESTIMATE_PENDING = "Working it out…";
export const FORM_NEEDS_ATTENTION = "Some choices are still missing. Fix the marked fields and work it out again.";

// ---------------------------------------------------------------------------
// Risk: the result
// ---------------------------------------------------------------------------
export const RESULT_LABEL = "An estimate from the numbers you entered. Not a forecast, not an invoice, and private to your team.";
export const NOT_PART_OF_ANY_TOTAL = "It is not part of any total.";
export const NOT_PART_OF_FORECAST = "This estimate is not part of any total. Do not add it to a shipping or all-in figure.";

/** The headline: "So far" while something is not decided, "at least" when a part could not be computed. Never "cost". */
export function riskHeadline(args: { amount: string | null; soFar: boolean; atLeast: boolean }): string {
  if (args.amount === null) return "Possible adjustments: not computed (estimate, private to your team)";
  const lead = args.soFar ? "Possible adjustments so far" : "Possible adjustments";
  const figure = args.atLeast ? `at least ${args.amount} a month` : `${args.amount} a month`;
  return `${lead}: ${figure} (estimate, private to your team)`;
}
export const NOT_COMPUTED_TITLE = "Not computed";
export const COMPUTED_REASON: Record<string, string> = {
  severity_unknown: "You did not say what one correction adds, and your history has no amount for it. It is not counted as $0.00.",
  incidence_unknown: "How often packages are corrected is not known. Add how many packages you shipped in the same period, or enter a percentage.",
};
export const ADD_BASELINE_LINK = "Add packages shipped";
export const BASELINES_HREF = "/app/adjustments/history/baselines";
export const SO_FAR_TODO = (amount: string): string => `${amount} a month is not decided yet. Decide who pays to complete this figure.`;
export const AT_LEAST_NOTE = "At least: a part of the estimate could not be computed, so the real figure is higher or the same, never lower.";
export const COMPONENTS_TITLE = "By part";
export const IN_FORECAST_TITLE = "Already in your shipping forecast";
export const IN_FORECAST_BODY = "Counted in your shipping forecast, so not counted again here.";
export const SEVERITY_PER_CORRECTION = "One correction adds";
export const MONTHLY_AMOUNT = "A month";
export const COUNTED_STATE = { computed: "Counted here", in_forecast: IN_FORECAST_TITLE, not_computed: NOT_COMPUTED_TITLE } as const;

export const BUCKETS_RESULT_TITLE = "Who pays";
export const casebycaseLine = (amount: string, customer: string | null): string =>
  `Decided case by case: ${amount} a month. If you approve every one, ${customer ?? "the customer"} pays and you give up nothing. If you decline every one, it becomes revenue you did not bill.`;
export const casebycaseRange = (amount: string): string => `Between $0.00 and ${amount} a month ends up not billed, depending on what you decide. No share of approvals is assumed.`;
export const NOT_DECIDED_LINK = "Decide who pays";

export const PER_1000 = "Per 1,000 packages";
export const PER_PACKAGE = "Per package shipped";
export const AFFECTED_LABEL = "Packages corrected a month";
export const ANNUAL_LABEL = "A year, if every month looked like this";
export const SMALL_FIGURES_NOTE = "Per-package figures are shown to four decimals so they multiply back to the monthly figure.";
export const RANGE_TITLE = "Range from how often it happened";
export const RANGE_WILSON = "The range is a 95% Wilson interval on how often adjustments happened in your history. It reflects incidence uncertainty only.";
export const rangeLine = (lowPct: string, highPct: string): string => `How often: ${lowPct}% to ${highPct}% of packages.`;
export const rangeAffected = (low: string, high: string): string => `Packages corrected a month: ${low} to ${high}.`;
export const rangeAmount = (low: string | null, high: string | null): string => (low === null || high === null ? "Amount a month: not computed." : `Counted here, a month: ${low} to ${high}.`);

export const CONFIDENCE_TITLE = "How much to trust each number";
export const CONFIDENCE_PARTS = { incidence: "How often", postage_difference: "Shipping charge difference", separate_fee: "Separate adjustment fee", overall: "Overall" } as const;
export function confidenceWords(c: ConfidenceLevel | "entered" | "example"): string {
  if (c === "entered") return "Entered by you, no rating";
  if (c === "example") return "One example shipment, no rating";
  return `${CONFIDENCE_LABELS[c]} confidence`;
}

/** The sentence under the figures that says which part is counted here and which is already in the forecast. */
export const BASIS_RESULT_SENTENCE = {
  declared_weights: "Counted here: postage differences and separate adjustment fees. Your shipping forecast uses declared weights, so it does not include them. Do not add this estimate to that forecast as if it were certain.",
  actual_weights: "Counted here: separate adjustment fees only. Your shipping forecast already uses actual weights, so postage differences are already in it and are not counted again.",
} as const;

export const T1_TITLE = "Postage that is in your forecast but not billed";
export function t1Body(notBilled: string, caseByCase: string): string {
  const parts = [notBilled && `${notBilled} a month that your decisions say is not billed to the customer`, caseByCase && `${caseByCase} a month that you decide case by case`].filter(Boolean);
  return `Your shipping forecast already includes postage: ${parts.join(" and ")}. It is shown here for your information and is not counted again.`;
}

export const CREDITS_MEMO_TITLE = "Credits, as a memo";
export const creditsMemoLine = (amount: string): string => `Credits in your history would come to ${amount} a month. Credits never reduce the estimate above.`;
export const netMemoLine = (amount: string): string => `If every credit were returned to the customer, the amount counted here would be ${amount} a month. A memo only.`;

export const SOURCES_TITLE = "Where the numbers came from";
export const volumeSource = (source: "entered" | "run", packages: string, runName: string | null): string => (source === "run" ? `Volume: ${formatDecimalText(packages)} packages a month, from the finished run ${runName ? `"${runName}"` : "you chose"}.` : `Volume: ${formatDecimalText(packages)} packages a month, as you entered it.`);
export const incidenceSourceHistory = (k: number, N: number, pct: string): string => `How often: ${formatCount(k)} of ${formatCount(N)} packages shipped (${pct}%), from your history.`;
export const incidenceSourceNoBaseline = "How often: not known. Your history has no packages-shipped figure for this period.";
export const incidenceSourceEntered = (pct: string): string => `How often: ${pct}%, as you entered it.`;
export const severitySource = (component: string, source: "history" | "entered" | "example", amount: string | null, n: number | null): string => {
  if (amount === null) return `${component}: not known${source === "history" ? ", no amounts in your history" : ""}.`;
  if (source === "history") return `${component}: ${amount} for one correction, the average of ${formatCount(n ?? 0)} ${n === 1 ? "record" : "records"} in your history.`;
  if (source === "example") return `${component}: ${amount} for one correction, from one example shipment.`;
  return `${component}: ${amount} for one correction, as you entered it.`;
};
export const handlingSource = (component: string, handling: Handling): string => `${component}: ${HANDLING_WORDS(handling)}, under your decisions as they stand today.`;
export const HISTORY_COUNTED = (charges: number, credits: number, noAmount: number, counted: number): string =>
  `History counted: ${formatCount(charges)} corrections that raised the charge and ${formatCount(noAmount)} with no amount recorded, so ${formatCount(counted)} packages. ${formatCount(credits)} credits are left out.`;

export const SAVE_ESTIMATE_TITLE = "Save this estimate";
export const SAVE_ESTIMATE_BUTTON = "Save estimate";
export const SAVE_ESTIMATE_PENDING = "Saving…";
export const ESTIMATE_SAVED = "Estimate saved.";
export const ESTIMATE_NAME_HINT = "A name for your own list, for example the customer and the month.";
export const SAVED_ESTIMATE_NOTE = "Saved with the numbers it was worked out from. Later changes to your history or decisions do not change it.";
export const BACK_TO_ESTIMATES = "All estimates";
export const BACK_TO_EXAMPLES = "All examples";

/** Plain sentences for the refusals of the forecast (the screen never shows a code). */
export const RISK_REFUSAL_TEXT: Record<string, string> = {
  inputs_invalid: "The estimate needs its inputs: monthly volume, how often, what a correction adds, the weights basis and who pays.",
  volume_invalid: "The monthly volume must be a number.",
  volume_negative: "The monthly volume cannot be negative.",
  volume_too_large: "The monthly volume is limited to 5,000,000 packages.",
  basis_required: BASIS_ERROR,
  incidence_invalid: "Choose where how often comes from: your history or a percentage you enter.",
  k_negative: "The number of corrected packages cannot be negative.",
  k_exceeds_n: "More packages were corrected than were shipped. Check the packages shipped for this period.",
  p_invalid: INCIDENCE_NEEDED,
  p_out_of_range: "The percentage must be between 0 and 100.",
  severity_invalid: "Each amount needs a source: your history, an amount you enter, or one example shipment.",
  severity_negative: "An amount cannot be negative: credits are never part of an estimate.",
  handling_invalid: "Each part needs a decision on who pays, or 'not decided'.",
  credits_invalid: "The credits could not be used as given.",
  overflow: "An amount is too large to work out exactly. Check the volume and the amounts.",
};

export { formatE4 };
