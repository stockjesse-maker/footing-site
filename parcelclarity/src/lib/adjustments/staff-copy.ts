/**
 * Staff-facing wording and small pure helpers of the 3PL adjustment screens (Milestone 5, design v2 section 7). NOT a "use server" module:
 * client components import it. Everything here is for the 3PL's own team; a customer never reads any of it, and none of it belongs on a
 * customer page.
 *
 * Wording rules kept in one place so the screens and their tests read a single source:
 *  - the money labels name whose money it is: "Original charge to your customer", "Corrected charge to your customer", "Separate adjustment fee
 *    charged to your customer". The 3PL's own amounts are never called a cost, a loss, a margin or a profit, and a carrier buy rate is never
 *    mentioned as something the product holds (the product holds none);
 *  - "absorbed" is shown as "Not billed to the customer (at your customer rates)": revenue the 3PL gives up, never a loss;
 *  - handling is always words plus a badge, never colour alone;
 *  - unknown is "not computed" or "Not decided", never zero.
 */
import { ATTESTATION_TEXT, DUPLICATE_RULE_NOTE, IMPORT_LIMITS, IMPORT_NOTICE, MONEY_FIELD_HINT, MONEY_FIELD_LABELS, REFUSAL_TITLE, ROW_NUMBERING_NOTE } from "./copy";
import type { AdjustmentCause, ConfidenceLevel, Handling, PolicyComponent, PolicyType } from "@/engine/adjustments/types";

export { ATTESTATION_TEXT, DUPLICATE_RULE_NOTE, IMPORT_LIMITS, IMPORT_NOTICE as PRIVATE_NOTICE, MONEY_FIELD_HINT, MONEY_FIELD_LABELS, REFUSAL_TITLE, ROW_NUMBERING_NOTE };

// ---------------------------------------------------------------------------
// Shell, tabs, access
// ---------------------------------------------------------------------------
export const ADJUSTMENTS_TITLE = "Adjustments";
export const ADJUSTMENTS_DESCRIPTION = "Decide who pays when a package's weight or size is corrected after it was labelled, learn from your history, and share examples with customers.";

export interface AdjustmentTab {
  href: string;
  label: string;
  /** Match only this exact path (the Overview). */
  exact?: boolean;
}

/** The five tabs, in order. Examples and Risk are built by another part of the module and may not exist yet. */
export const ADJUSTMENT_TABS: readonly AdjustmentTab[] = [
  { href: "/app/adjustments", label: "Overview", exact: true },
  { href: "/app/adjustments/policies", label: "Policies" },
  { href: "/app/adjustments/history", label: "History" },
  { href: "/app/adjustments/examples", label: "Examples" },
  { href: "/app/adjustments/risk", label: "Risk" },
];

export function isTabActive(pathname: string, tab: AdjustmentTab): boolean {
  return tab.exact ? pathname === tab.href : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
}

/** What an employee (or anyone without the permission to view) reads when they open an adjustments URL. */
export const RESTRICTED_TITLE = "Adjustments are for administrators";
export const RESTRICTED_BODY = "You can view customers and rate cards, but only administrators can view or manage adjustment decisions, history, examples and estimates.";
export const READ_ONLY_NOTICE = "You can view adjustments, but only administrators can manage them.";

// ---------------------------------------------------------------------------
// Policies: who pays
// ---------------------------------------------------------------------------
export const POLICY_TYPE_LABELS: Record<PolicyType, string> = {
  reweight: "Reweigh",
  remeasure: "Remeasure",
  combined: "Both together",
  correction: "Other correction fee",
};

export const POLICY_TYPE_HELP: Record<PolicyType, string> = {
  reweight: "A package's weight is corrected after labelling.",
  remeasure: "A package's size is corrected after labelling.",
  combined: "Weight and size are both corrected. It has its own decision: it does not follow Reweigh or Remeasure.",
  correction: "A fee for correcting a shipping charge that is not a reweigh or a remeasure. It has no shipping charge difference.",
};

export const POLICY_COMPONENT_LABELS: Record<PolicyComponent, string> = {
  postage_difference: "Shipping charge difference",
  separate_fee: "Separate adjustment fee",
};

export const POLICY_COMPONENT_HELP: Record<PolicyComponent, string> = {
  postage_difference: "What the corrected shipping charge adds to the original one, at your customer rates.",
  separate_fee: "A fee you add on top, from your reweigh, remeasure or correction fee rule.",
};

/** The three choices, in the order the select lists them. */
export const HANDLING_CHOICES = ["pass_through", "manual_approval", "absorbed"] as const;
export type HandlingChoice = (typeof HANDLING_CHOICES)[number];

export const HANDLING_LABELS: Record<HandlingChoice, string> = {
  pass_through: "Passed through under the customer agreement",
  manual_approval: "Decided case by case",
  absorbed: "Not billed to the customer (at your customer rates)",
};

/** The badge beside a saved decision: short, and always shown with the words, never colour alone. */
export const HANDLING_BADGES: Record<Handling, string> = {
  pass_through: "Passed through",
  manual_approval: "Case by case",
  absorbed: "Not billed",
  unconfigured: "Not decided",
};

export const HANDLING_HELP: Record<HandlingChoice, string> = {
  pass_through: "Choose this only if your agreement with this customer lets you charge it.",
  manual_approval: "You review each case and decide whether to charge it. Nothing is promised either way.",
  absorbed: "You do not charge the customer for this. It is revenue you give up, counted at your customer rates.",
};

export const UNDECIDED_TEXT = "Not decided";
export const UNDECIDED_HELP = "Choose who pays before you share an example that includes this.";
export const POLICIES_EMPTY = "No decisions yet. Choose who pays for each kind of adjustment. Until you do, nothing can be shared with a customer.";
export const POLICIES_INTRO = "Choose how each kind of correction is handled. A decision applies from today. Customers never see these decisions; they see only the examples you share.";
export const INHERIT_LABEL = "Use the all-customers decision";
export const NOT_APPLICABLE_FEE_ONLY = "Not applicable. A correction fee has no shipping charge difference.";
export const SAVE_DECISIONS = "Save decisions";
export const NO_CHANGES = "Nothing to save. Change a decision first.";

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
/** The fee-rule categories of a surcharge rule, in the words the policies use. */
export const FEE_CATEGORY_WORDS: Record<string, string> = {
  reweight: "reweigh",
  remeasure: "remeasure",
  shipping_charge_correction: "other correction fee",
};

export const CHECKLIST_TITLE = "Set up adjustments";
export const CHECKLIST_INTRO = "Four steps. Each shows whether it is done today; nothing here is stored as a to-do.";
export const NO_SEPARATE_FEE_HELP = "If you do not charge a separate fee for corrections, you can skip this step and decide who pays the shipping charge difference. This page cannot record that choice, so the step stays open until a rule exists.";

// ---------------------------------------------------------------------------
// History: imports
// ---------------------------------------------------------------------------
export type ImportStatusKey = "uploaded" | "mapped" | "validated" | "committing" | "committed" | "discarded" | "withdrawn";

export const IMPORT_STATUS_LABELS: Record<ImportStatusKey, string> = {
  uploaded: "Map the columns",
  mapped: "Needs fixes",
  validated: "Ready to import",
  committing: "Import not finished",
  committed: "Imported",
  discarded: "Discarded",
  withdrawn: "Withdrawn",
};

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";
export const IMPORT_STATUS_TONES: Record<ImportStatusKey, BadgeTone> = {
  uploaded: "neutral",
  mapped: "warning",
  validated: "accent",
  committing: "warning",
  committed: "success",
  discarded: "neutral",
  withdrawn: "neutral",
};

export const isImportOpen = (status: ImportStatusKey): boolean => status === "uploaded" || status === "mapped" || status === "validated" || status === "committing";

export const HISTORY_EMPTY_TITLE = "No history yet";
export const HISTORY_EMPTY_BODY = "Upload what your customers were charged for past reweighs and remeasures. Only your team can see it.";
export const HISTORY_TITLE = "Past adjustments";
export const HISTORY_INTRO = "Upload what your customers were charged for past reweighs, remeasures and other corrections. It shows how often adjustments happen and what they add.";
export const UPLOAD_TITLE = "Upload a history file";
export const UPLOAD_BUTTON = "Upload file";
export const UPLOAD_PENDING = "Reading the file…";
export const UPLOAD_FILE_LABEL = "History file";
export const UPLOAD_FILE_HINT_LIMITS = `Limits: ${IMPORT_LIMITS}.`;
export const UPLOAD_TEMPLATE_LINK = "Download the template (CSV)";
export const TEMPLATE_HREF = "/api/templates/adjustments.csv";
export const UPLOAD_NOTHING_IMPORTED = "Nothing is imported until you approve how the file is read.";
export const UPLOAD_READ_ONLY = "Only administrators can upload history.";

export const STEP_LABELS = ["Upload", "Map columns", "Check", "Import"] as const;

export const CAUSE_LABELS: Record<AdjustmentCause, string> = {
  wms_no_weight: "No weight was sent when the label was printed",
  scale_error: "Scale error",
  carrier_reweigh: "Carrier reweighed the package",
  carrier_remeasure: "Carrier remeasured the package",
  packaging_change: "Packaging changed",
  other: "Other, or not stated",
};

export const CAUSE_OPTIONS: readonly AdjustmentCause[] = ["wms_no_weight", "scale_error", "carrier_reweigh", "carrier_remeasure", "packaging_change", "other"];

export const DUPLICATE_OPTIONS: readonly { value: "refuse" | "sum" | "first"; label: string; help: string }[] = [
  { value: "refuse", label: "Stop and tell me", help: "Do not import until the repeated rows are fixed. The report lists how many there are. This is the safe choice." },
  { value: "sum", label: "Combine the rows", help: "Add the repeats into one record: the extra charge of each repeat is added to the corrected charge, and separate fees are added. If an amount is missing in one of the rows, that package's charges are unknown, not zero." },
  { value: "first", label: "Keep the first row", help: "Keep the first row for each package and ignore the repeats." },
];
export const DUPLICATE_LEGEND = "If the same package appears more than once in the file";

export const COMMIT_BUTTON = "Import rows";
export const DISCARD_BUTTON = "Discard import";
export const WITHDRAW_BUTTON = "Withdraw import";
export const CHECK_BUTTON = "Check the file";
export const CHECK_PENDING = "Checking…";
export const ATTEST_HINT = "Tick the box above to check the file.";
export const MAPPING_CHANGED = "You changed how the file is read. Check the file again to update this report; it describes the last saved choices.";

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------
export const STATS_TITLE = "How often adjustments happen";
export const STATS_INTRO = "Worked out from your imported history. How often needs the packages you shipped in the same period; what an adjustment adds does not.";
export const STATS_NO_BASELINE = "Add how many packages you shipped in this period to see how often adjustments happen";
export const STATS_NO_BASELINE_HINT = "The packages shipped must match the same customer, carrier and service as the filters above. Averages are shown without it.";
export const STATS_EMPTY_TITLE = "No history yet";
export const STATS_EMPTY_BODY = "Import a file of past adjustments to see how often they happen and what they add.";
export const STATS_EMPTY = `${STATS_EMPTY_TITLE}. ${STATS_EMPTY_BODY}`;
export const PER_RECORD_NOTE = "Counted per adjustment record, not per package, because some records have no package reference.";

export const RANGE_SENTENCE = "The range reflects incidence uncertainty only.";

export const NOTE_TEXT: Record<string, string> = {
  range_reflects_incidence_uncertainty_only: RANGE_SENTENCE,
  credits_never_enter_exposure: "Credits are shown beside the charges. They never reduce what a risk estimate counts.",
  counted_per_adjustment_record_not_per_package: PER_RECORD_NOTE,
  packages_are_the_unit: "Packages means carrier packages: one label is one package.",
};

/** Notes the view prints in their own place, so the generic list leaves them out. */
export const NOTES_PRINTED_ELSEWHERE: readonly string[] = ["range_reflects_incidence_uncertainty_only", "window_immature_adjustments_still_posting", "counted_per_adjustment_record_not_per_package"];

export const CONFIDENCE_LABELS: Record<ConfidenceLevel, string> = {
  none: "None",
  low: "Low",
  moderate: "Moderate",
  adequate: "Adequate",
};

export const DIRECTION_LABELS = {
  increase: "Charges",
  decrease: "Credits",
  zero: "No change",
  unknown: "No amounts recorded",
} as const;

export const DIRECTION_HELP = {
  increase: "The corrected charge is higher than the original charge.",
  decrease: "The corrected charge is lower than the original charge. This is a credit, not an adjustment charge.",
  zero: "The corrected charge equals the original charge.",
  unknown: "Rows with no amounts. They count toward how often adjustments happen, not toward what they add.",
} as const;

export const STATS_BUTTON = "Show statistics";
export const STATS_PENDING = "Working it out…";

// ---------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------
export const BASELINES_TITLE = "Packages shipped";
export const BASELINES_INTRO = "How many packages you shipped in a period. It is what turns a count of adjustments into how often they happen. The unit is the carrier package: one label is one package.";
export const BASELINES_EMPTY_TITLE = "No packages-shipped figures yet";
export const BASELINES_EMPTY_BODY = "Add how many packages you shipped in a period to see how often adjustments happen.";
export const BASELINES_EMPTY = `${BASELINES_EMPTY_TITLE}. ${BASELINES_EMPTY_BODY}`;
export const BASELINE_ADD_BUTTON = "Add packages shipped";
export const BASELINE_SAVE_BUTTON = "Save packages shipped";
export const BASELINE_DELETE_BUTTON = "Delete";
export const BASELINE_ALL_CUSTOMERS = "All customers together";
export const BASELINE_ALL_CARRIERS = "All carriers";
export const BASELINE_ALL_SERVICES = "All services";

// ---------------------------------------------------------------------------
// Money and number display
// ---------------------------------------------------------------------------
/** Dollars and cents for a whole number of ten-thousandths of a dollar: rounded once, HALF_UP, to the cent (the M4 convention). A credit reads "-$1.20 credit". */
export function formatE4(e4: number): string {
  const abs = Math.abs(e4);
  const cents = Math.floor((abs + 50) / 100);
  const dollars = Math.floor(cents / 100);
  const rest = String(cents % 100).padStart(2, "0");
  const sign = e4 < 0 && cents > 0 ? "-" : "";
  return `${sign}$${dollars.toLocaleString("en-US")}.${rest}`;
}

/** The same, and a negative amount says "credit" in words (never a colour alone). */
export function formatE4Words(e4: number): string {
  const text = formatE4(e4);
  return text.startsWith("-") ? `${text} credit` : text;
}

export const formatCount = (n: number): string => n.toLocaleString("en-US");

/** "2.0000%" from the engine's 4-decimal text. */
export const formatPct = (pct4dp: string): string => `${pct4dp}%`;

export const pluralize = (n: number, one: string, many: string = `${one}s`): string => `${formatCount(n)} ${n === 1 ? one : many}`;

/** "Oct 16, 2026" from an ISO date (UTC, no clock). */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
export function formatIsoDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${Number(m[3])}, ${m[1]}` : iso;
}

export const formatDateRange = (from: string | null, to: string | null): string | null => (from && to ? (from === to ? formatIsoDate(from) : `${formatIsoDate(from)} to ${formatIsoDate(to)}`) : null);

/** The estimate's basis, in the words the risk form uses. */
export const BASIS_LABELS: Record<string, string> = {
  declared_weights: "Declared weights",
  actual_weights: "Actual weights",
};

// ---------------------------------------------------------------------------
// Words that must never describe the 3PL's own amounts (the banned-wording tests scan the screens for them).
// ---------------------------------------------------------------------------
export const BANNED_OWN_AMOUNT_WORDS: readonly RegExp[] = [/\bcosts?\b/i, /\bloss(es)?\b/i, /\bmargins?\b/i, /\bprofits?\b/i, /\bbuy rates?\b/i];
