/**
 * Exact wording of the import steps (design v2 section 5 and the customer review's strings 8 and 9), kept next to the library that
 * produces the refusals and reports so the wizard and the tests read one source. All of it is for the 3PL's own team.
 */

/** Heading of the refusal shown when a header looks like carrier cost data. */
export const REFUSAL_TITLE = "This file looks like carrier cost data";

/** The sentence under every money field in the mapping step. */
export const MONEY_FIELD_HINT = "Enter what your customer is charged, never what the carrier bills you.";

/** The label of each money field in the mapping step. */
export const MONEY_FIELD_LABELS = {
  originalCharge: "Original charge to your customer",
  correctedCharge: "Corrected charge to your customer",
  adjustmentFee: "Separate adjustment fee charged to your customer",
} as const;

/** The required checkbox before Validate. Its acceptance is stored with the import and audited. No guard can prove a number is customer-facing; this is the 3PL's statement. */
export const ATTESTATION_TEXT = "These charge columns hold what my customer was or would be charged. They do not hold what the carrier billed me.";

/** Opens every history page and the validation report. */
export const IMPORT_NOTICE = "Only your team can see this. Customers never do.";

/** The limits sentence of the upload step. */
export const IMPORT_LIMITS = "5 MB, 20,000 rows; split by month";

/** Empty state of the History tab. */
export const HISTORY_EMPTY = "No history yet. Upload what your customers were charged for past reweighs and remeasures. Only your team can see it.";
