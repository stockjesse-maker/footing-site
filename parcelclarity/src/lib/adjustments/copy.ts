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

/** The sentence that follows a refusal: nothing is kept. */
export const NOTHING_SAVED = "Nothing from this file was saved.";

/** A file whose column names cannot be found in its first rows is refused (a header that cannot be found is a header that cannot be checked). */
export const NO_HEADER_ROW_MESSAGE =
  `We could not find the column names in this file. Put the column names in row 1 (the first row of the sheet), with at least a ship date column and a carrier, service or adjustment type column named like the template (ship_date, carrier, service, adjustment_type), then upload again. ${NOTHING_SAVED}`;

/** UTF-16 ("Unicode Text") files and files with binary bytes cannot be read as text: the guard would see letters separated by NUL bytes, not column names. */
export const ENCODING_MESSAGE =
  `This file is not saved as plain CSV text (it looks like a UTF-16 "Unicode Text" file, or it holds binary data). In your spreadsheet choose Save As, then "CSV UTF-8 (Comma delimited)", and upload again. ${NOTHING_SAVED}`;

/** What the 3PL reads about row numbers in every report. */
export const ROW_NUMBERING_NOTE = "Row numbers count the rows under the column names that are not blank (blank lines are not counted).";

/** What the 3PL reads about a package that was already imported by an earlier file. */
export const DUPLICATE_RULE_NOTE =
  "A package that an earlier file already added (same customer, carrier, package reference and kind of adjustment) is skipped, even when its amounts differ. Repeats inside this one file follow the choice you make below.";

/** The cap on one cell of a history file (characters) and the cap on a column name. Longer text is never read: the file is refused. */
export const MAX_CELL_CHARS = 10_000;
export const MAX_COLUMN_NAME_CHARS = 200;
