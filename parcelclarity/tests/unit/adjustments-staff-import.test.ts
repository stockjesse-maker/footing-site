import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AdjustmentDetection, AdjustmentMapping, AdjustmentValidationReport } from "@/lib/adjustments/types";
import { sentenceFor } from "@/lib/adjustments/validate";
import { ADJUSTMENT_TEMPLATE_HEADERS } from "@/lib/adjustments/header-guard";
import { ATTESTATION_TEXT, IMPORT_LIMITS, MONEY_FIELD_HINT, MONEY_FIELD_LABELS, PRIVATE_NOTICE, REFUSAL_TITLE } from "@/lib/adjustments/staff-copy";
import { BRANDS, CATALOG, IMPORT_ID, accessibleNames, bannedIn, findElements, html, idProblems, importFixture, nodeText, textOf, unnamedControls } from "./adjustments-staff-support";

const h = vi.hoisted(() => ({ saveImportMapping: vi.fn(), validateImport: vi.fn(), commitImport: vi.fn(), discardImport: vi.fn(), withdrawImport: vi.fn(), uploadAdjustmentFile: vi.fn(), refresh: vi.fn(), push: vi.fn() }));
vi.mock("@/app/actions/adjustments", () => ({
  saveImportMapping: h.saveImportMapping,
  validateImport: h.validateImport,
  commitImport: h.commitImport,
  discardImport: h.discardImport,
  withdrawImport: h.withdrawImport,
  uploadAdjustmentFile: h.uploadAdjustmentFile,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push, refresh: h.refresh }) }));

const model = await import("@/components/adjustments/staff/import-model");
const { MappingEditor } = await import("@/components/adjustments/staff/mapping-step");
const { ValidationReportView } = await import("@/components/adjustments/staff/validation-report");
const { ImportWizardView } = await import("@/components/adjustments/staff/import-wizard");
const { UploadFormView, HistoryUploadForm } = await import("@/components/adjustments/staff/upload-form");
const { ImportCommittedView, ImportEndedView } = await import("@/components/adjustments/staff/import-summary");
const { HistoryList, importSizeLine } = await import("@/components/adjustments/staff/history-list");
const { ImportSteps } = await import("@/components/adjustments/staff/import-steps");
const { initialState } = await import("@/lib/actions");

const noop = () => undefined;
const sample = await importFixture("history-sample.csv");
const broken = await importFixture("history-errors.csv");
type WizardProps = Parameters<typeof ImportWizardView>[0];

// ---------------------------------------------------------------------------
// Wizard step logic
// ---------------------------------------------------------------------------
describe("which step an import is on", () => {
  it("maps each status to a step; a finished or ended import is on none of the first three", () => {
    expect(model.stepNumber("uploaded")).toBe(2);
    expect(model.stepNumber("mapped")).toBe(3);
    expect(model.stepNumber("validated")).toBe(4);
    expect(model.stepNumber("committing")).toBe(4);
    expect(model.stepNumber("committed")).toBe(5);
    expect(model.stepNumber("discarded")).toBe(0);
    expect(model.stepNumber("withdrawn")).toBe(0);
  });

  it("the mapping is editable until the import is committed, discarded or withdrawn; importing is offered only for a checked file", () => {
    expect((["uploaded", "mapped", "validated", "committing", "committed", "discarded", "withdrawn"] as const).filter(model.isEditable)).toEqual(["uploaded", "mapped", "validated"]);
    expect((["uploaded", "mapped", "validated", "committing", "committed"] as const).filter(model.canImport)).toEqual(["validated", "committing"]);
  });

  it("offers the import only when the report is current and clean", () => {
    const ok = { ok: true, committable: true };
    expect(model.importOffered("validated", ok, false)).toBe(true);
    expect(model.importOffered("committing", ok, false)).toBe(true);
    expect(model.importOffered("validated", ok, true)).toBe(false); // the mapping changed since
    expect(model.importOffered("mapped", ok, false)).toBe(false);
    expect(model.importOffered("validated", { ok: true, committable: false }, false)).toBe(false);
    expect(model.importOffered("validated", { ok: false, committable: false }, false)).toBe(false);
    expect(model.importOffered("validated", null, false)).toBe(false);
  });

  it("the check is gated by the statement, by every choice that must be made, and by nothing running", () => {
    expect(model.canCheck({ attested: false, missing: [], pending: false })).toBe(false);
    expect(model.canCheck({ attested: true, missing: ["Choose how to read the dates."], pending: false })).toBe(false);
    expect(model.canCheck({ attested: true, missing: [], pending: true })).toBe(false);
    expect(model.canCheck({ attested: true, missing: [], pending: false })).toBe(true);
  });

  it("lists what still has to be chosen, in plain sentences", () => {
    const empty = { ...sample.mapping, columns: { ...sample.mapping.columns, shipDate: null, carrier: null, service: null, adjustmentType: null }, defaults: { ...sample.mapping.defaults, adjustmentType: null } };
    const missing = model.missingChoices(empty, sample.headers, { dateUnchosen: true, unitUnchosen: true });
    expect(missing).toEqual([
      "Choose the ship date column; every row needs one.",
      "Choose a carrier or a service column; every row needs a carrier.",
      "Choose the adjustment type column, or one type for the whole file.",
      "Choose how to read the dates.",
      "Choose the unit the weights are in.",
    ]);
    expect(model.missingChoices(sample.mapping, sample.headers, { dateUnchosen: false, unitUnchosen: false })).toEqual([]);
  });

  it("refuses one column read as two fields, naming the column", () => {
    const twice = model.setColumn(sample.mapping, "correctedCharge", sample.mapping.columns.originalCharge);
    const missing = model.missingChoices(twice, sample.headers, { dateUnchosen: false, unitUnchosen: false });
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain('The column "customer_charge_original" is chosen for');
    expect(missing[0]).toContain("One column cannot be read as two different fields.");
  });

  it("an amount column is read as one amount at a time", () => {
    const m0 = model.setColumn(model.setColumn(model.setColumn(sample.mapping, "originalCharge", null), "correctedCharge", null), "adjustmentFee", null);
    const m1 = model.chooseAmountColumn(m0, 19, "originalCharge");
    expect(model.amountChoiceFor(m1, 19)).toBe("originalCharge");
    const m2 = model.chooseAmountColumn(m1, 19, "adjustmentFee");
    expect(m2.columns.originalCharge).toBeNull();
    expect(model.amountChoiceFor(m2, 19)).toBe("adjustmentFee");
    expect(model.amountChoiceFor(model.chooseAmountColumn(m2, 19, null), 19)).toBe("");
  });

  it("compares mappings whatever order their keys are in (the stored copy comes back from jsonb reordered)", () => {
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(sample.mapping).reverse()))) as AdjustmentMapping;
    expect(model.stable(reordered)).toBe(model.stable(sample.mapping));
    expect(model.mappingChanged(reordered, sample.mapping)).toBe(false);
    expect(model.mappingChanged(model.setColumn(sample.mapping, "cause", null), sample.mapping)).toBe(true);
    expect(model.mappingChanged(sample.mapping, null)).toBe(true);
  });

  it("a value map shows the chosen entry, else what was suggested, else the fallback; an entry of null is a choice (leave unassigned)", () => {
    const values = [
      { text: "Alpha Apparel", normalized: "alpha apparel", rows: 14, suggested: BRANDS[0]!.id },
      { text: "Acme Co", normalized: "acme co", rows: 3, suggested: null },
      { text: "Beta Beverages", normalized: "beta beverages", rows: 20, suggested: BRANDS[1]!.id },
    ];
    const rows = model.valueRows<string>(values, { "beta beverages": null, "acme co": BRANDS[0]!.id });
    expect(rows.map((r) => [r.text, r.value, r.matchedAutomatically])).toEqual([
      ["Alpha Apparel", BRANDS[0]!.id, true],
      ["Acme Co", BRANDS[0]!.id, false],
      ["Beta Beverages", null, false],
    ]);
    expect(model.valueRows<string>(values.slice(1, 2), {}, "other")[0]!.value).toBe("other");
    const next = model.setMapEntry(sample.mapping, "brandMap", "acme co", null);
    expect(next.brandMap["acme co"]).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(next.brandMap, "acme co")).toBe(true);
  });

  it("takes sample values only from a column that is mapped, the first non-blank one, cut to 40 characters", () => {
    expect(model.sampleValue([{ a: "", b: "x" }, { a: "second" }], "a")).toBe("second");
    expect(model.sampleValue([{ a: "y".repeat(80) }], "a")).toHaveLength(40);
    expect(model.sampleValue(undefined, "a")).toBeNull();
    expect(model.sampleValue([{ a: "1" }], undefined)).toBeNull();
  });

  it("builds carrier options once each, by name", () => {
    expect(model.carrierOptions(CATALOG)).toEqual([
      { code: "ups", name: "UPS" },
      { code: "usps", name: "USPS" },
    ]);
  });
});

describe("the stored report, read back", () => {
  it("reads a stored report exactly, and a report with rows to fix too", () => {
    for (const x of [sample, broken]) {
      const back = model.parseStoredReport(JSON.parse(JSON.stringify(x.report)));
      expect(back).not.toBeNull();
      expect(back!.counts).toEqual(x.report.counts);
      expect(back!.codes).toEqual(x.report.codes);
      expect(back!.committable).toBe(x.report.committable);
      expect(back!.shipDateRange).toEqual(x.report.shipDateRange);
    }
  });

  it("reads nothing from what is not a report: a discarded import keeps only counts and byCode, so it shows no report", () => {
    expect(model.parseStoredReport(null)).toBeNull();
    expect(model.parseStoredReport("x")).toBeNull();
    expect(model.parseStoredReport([])).toBeNull();
    expect(model.parseStoredReport({ counts: sample.report.counts, byCode: sample.report.byCode })).toBeNull();
    expect(model.parseStoredReport({ ...sample.report, counts: { ...sample.report.counts, rows: -1 } })).toBeNull();
    expect(model.parseStoredReport({ ...sample.report, codes: [{ code: "no_amounts", message: 3, rows: 1, severity: "information" }] })).toBeNull();
    expect(model.parseStoredReport({ ...sample.report, codes: [{ code: "no_amounts", message: "x", rows: 1, severity: "fatal" }] })).toBeNull();
  });

  it("splits errors from information, and summarises what the import will commit", () => {
    const { errors, information } = model.splitCodes(broken.report);
    expect(errors.length).toBeGreaterThan(0);
    expect(information).toEqual([]);
    expect(model.splitCodes(sample.report).errors).toEqual([]);
    expect(model.commitSummary(sample.report)).toEqual({ rows: 40, from: "2026-08-03", to: "2026-09-11", skipped: 0 });
  });
});

// ---------------------------------------------------------------------------
// The validation report: one plain sentence per code, with its count
// ---------------------------------------------------------------------------
describe("the validation report", () => {
  const render = (report: AdjustmentValidationReport, over: { dirty?: boolean } = {}) => html(createElement(ValidationReportView, { report, headingId: "report-h", dirty: over.dirty, brandNames: Object.fromEntries(BRANDS.map((b) => [b.id, b.name])) }));

  it("states that it is private, the counts of the file, the ship dates and the limits", () => {
    const out = render(sample.report);
    const t = textOf(out);
    expect(t).toContain(PRIVATE_NOTICE);
    expect(t).toContain("Rows in the file 40");
    expect(t).toContain("Rows that can be imported 40");
    expect(t).toContain("Ship dates Aug 3, 2026 to Sep 11, 2026");
    expect(t).toContain(`Limits: ${IMPORT_LIMITS}.`);
    expect(out).toContain('id="report-h"');
    expect(out).toContain('tabindex="-1"');
  });

  it("a clean file says nothing blocks the import and nothing is imported yet; its information is not an error", () => {
    const t = textOf(render(sample.report));
    expect(t).toContain("No problems block this import. Nothing is imported until you confirm it below.");
    expect(t).toContain("For your information");
    expect(t).not.toContain("Fix before importing");
    expect(t).toContain("3 rows have no amounts");
    expect(t).toContain("4 rows are credits");
  });

  it("a file with problems lists every error code once, with its count, before anything else, and says how many rows need fixing", () => {
    const out = render(broken.report);
    const t = textOf(out);
    expect(t).toContain("10 rows need fixing before this file can be imported.");
    for (const c of broken.report.codes) {
      expect(out, c.code).toContain(`data-testid="report-code-${c.code}"`);
      expect(t, c.code).toContain(c.message);
      expect(c.message, c.code).toMatch(new RegExp(`^${c.rows} rows? `));
    }
    expect(t.indexOf("Fix before importing")).toBeGreaterThan(-1);
    expect(t).toContain("Data rows:");
    expect(t).toContain("Row numbers count the rows under the column names that are not blank (blank lines are not counted).");
  });

  it("every code has a sentence that starts with its count and never carries a cell value", () => {
    const codes = Object.keys(sample.report.byCode) as (keyof typeof sample.report.byCode)[];
    expect(codes.length).toBeGreaterThanOrEqual(26);
    for (const code of codes) {
      for (const count of [1, 2, 1234]) {
        const sentence = sentenceFor(code, count);
        expect(sentence.length, code).toBeGreaterThan(20);
        // Counted in rows (with a thousands separator), or "Data row(s) ..." for the one code that names its rows.
        expect(sentence, `${code} ${count}`).toMatch(/^(\d[\d,]* rows?|1 row|Data rows? )/);
      }
    }
  });

  it("the wording the library chose for each code does not call the 3PL's amounts a cost, a loss, a margin or a profit (one known exception is reported to its owner)", () => {
    const codes = Object.keys(sample.report.byCode) as (keyof typeof sample.report.byCode)[];
    const offenders = codes.filter((c) => bannedIn(sentenceFor(c, 2)).length > 0);
    // `no_amounts` still reads "how much they cost" (src/lib/adjustments/validate.ts, owned by the import library): it is listed in the report to the actions owner.
    expect(offenders.every((c) => c === "no_amounts")).toBe(true);
  });

  it("a stale report says it describes the last saved choices", () => {
    expect(textOf(render(sample.report, { dirty: true }))).toContain("You changed how the file is read. Check the file again to update this report; it describes the last saved choices.");
    expect(textOf(render(sample.report))).not.toContain("You changed how the file is read");
  });

  it("customers named in the file show where each goes, including the ones left unassigned", () => {
    const report: AdjustmentValidationReport = { ...sample.report, customers: [{ text: "Alpha Apparel", rows: 14, brandId: BRANDS[0]!.id }, { text: "Acme Co", rows: 3, brandId: null }], unassignedRows: 2 };
    const t = textOf(render(report));
    expect(t).toContain("Alpha Apparel (14 rows) Matched to Alpha Apparel");
    expect(t).toContain("Acme Co (3 rows) Not matched: stays unassigned");
    expect(t).toContain("2 rows name no customer and stay unassigned.");
  });

  it("a mapping that cannot be applied shows why and nothing else", () => {
    const report: AdjustmentValidationReport = { ...sample.report, ok: false, committable: false, mappingIssues: [{ code: "sheet_missing", message: "The sheet in this mapping is not in the file." }] };
    const out = render(report);
    expect(textOf(out)).toContain("The mapping cannot be applied to this file");
    expect(textOf(out)).toContain("The sheet in this mapping is not in the file.");
    expect(textOf(out)).not.toContain("Rows in the file");
    expect(out).toContain('role="alert"');
  });

  it("is a region labelled by its heading", () => {
    expect(render(sample.report)).toContain('role="region" aria-labelledby="report-h"');
  });
});

// ---------------------------------------------------------------------------
// The mapping step
// ---------------------------------------------------------------------------
describe("the mapping editor", () => {
  const props = (over: Partial<Parameters<typeof MappingEditor>[0]> = {}) => ({
    mapping: sample.mapping,
    onChange: noop,
    detection: sample.detection,
    headers: sample.headers,
    sampleRows: sample.sampleRows,
    brands: BRANDS.map((b) => ({ id: b.id, name: b.name })),
    catalog: CATALOG,
    dateUnchosen: false,
    unitUnchosen: false,
    onChooseDate: noop,
    onChooseUnit: noop,
    ...over,
  });
  const render = (over: Partial<Parameters<typeof MappingEditor>[0]> = {}) => html(createElement(MappingEditor, props(over)));

  it("names the three money fields exactly and puts the money rule on the first line under each", () => {
    const out = render();
    for (const label of Object.values(MONEY_FIELD_LABELS)) expect(textOf(out)).toContain(label);
    // Each money field's hint block starts with the rule, then a sample value.
    const hints = [...out.matchAll(/<p id="[^"]*-(?:originalCharge|correctedCharge|adjustmentFee)-hint"[^>]*>(.*?)<\/p>/g)].map((m) => textOf(m[1]!));
    expect(hints).toHaveLength(3);
    for (const hint of hints) expect(hint.startsWith(MONEY_FIELD_HINT)).toBe(true);
  });

  it("shows two or fewer sample values as hints under mapped columns, from the mapped columns only", () => {
    const t = textOf(render());
    expect(t).toContain('e.g. "2026-08-03"');
    expect(t).toContain('e.g. "13.35"');
    expect(t).toContain('e.g. "1Z9A000001"');
  });

  it("a column with no sample value shows no example", () => {
    expect(textOf(render({ sampleRows: [] }))).not.toContain("e.g.");
  });

  it("lists the columns it will ignore, with a badge for the ones that look like an amount, and amount columns that need a choice", () => {
    const detection: AdjustmentDetection = {
      ...sample.detection,
      ignoredColumns: [
        { index: 30, header: "Surcharge Total", moneyLike: true },
        { index: 31, header: "Warehouse", moneyLike: false },
      ],
      amountColumnsNeedingChoice: [{ index: 32, header: "Customer Amount" }],
    };
    const out = render({ detection, headers: [...sample.headers, ...Array(7).fill(""), "Customer Amount"].slice(0, 33) });
    const t = textOf(out);
    expect(t).toContain("Columns we will ignore");
    expect(t).toContain("Surcharge Total Looks like an amount");
    expect(t).toContain("Warehouse");
    expect(t).toContain("Amount columns that need your choice");
    expect(t).toContain("What does “Customer Amount” hold?");
    for (const label of Object.values(MONEY_FIELD_LABELS)) expect(out).toContain(`>${label}</option>`);
    expect(out).toContain(">Leave it out</option>");
  });

  it("says every column is read when none is ignored", () => {
    expect(textOf(render())).toContain("Every column is read.");
  });

  it("offers the duplicate handling choice with refuse selected by default and a plain explanation of each", () => {
    const out = render();
    const t = textOf(out);
    expect(t).toContain("If the same package appears more than once in the file");
    for (const label of ["Stop and tell me", "Combine the rows", "Keep the first row"]) expect(t).toContain(label);
    const radios = out.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(3);
    expect(radios.filter((r) => r.includes('checked=""'))).toHaveLength(1);
    expect(radios.find((r) => r.includes('value="refuse"'))).toContain('checked=""');
  });

  it("matches customers, services and carriers in the file, with 'Leave unassigned' for a customer and 'Matched automatically' where it was", () => {
    const out = render();
    const t = textOf(out);
    expect(t).toContain("Customers in the file");
    expect(t).toContain("“Alpha Apparel” (14 rows)");
    expect(t).toContain("Matched automatically.");
    expect(out).toContain(">Leave unassigned</option>");
    expect(t).toContain("Services in the file");
    expect(t).toContain("Reasons and causes in the file");
    expect(t).toContain("Adjustment types in the file");
  });

  it("a reason always maps to one of the six causes: its select has no empty option (the stored mapping cannot hold 'no cause'), while customers, services and types may be left unmatched", () => {
    const out = render();
    const section = (legend: string) => {
      const start = out.indexOf(`<legend class="text-sm font-semibold">${legend}</legend>`);
      expect(start, legend).toBeGreaterThan(-1);
      return out.slice(start, out.indexOf("</fieldset>", start));
    };
    expect(section("Reasons and causes in the file")).not.toContain('<option value="">');
    expect((section("Reasons and causes in the file").match(/<option value="/g) ?? []).length % 6).toBe(0);
    expect(section("Customers in the file")).toContain('<option value="">Leave unassigned</option>');
    expect(section("Services in the file")).toContain('<option value="">Not matched</option>');
    expect(section("Adjustment types in the file")).toContain('<option value="">Not matched</option>');
  });

  it("an ambiguous date and an unstated weight unit must be chosen: the select starts empty and says so", () => {
    const out = render({ dateUnchosen: true, unitUnchosen: true });
    expect(out).toContain(">Choose…</option>");
    expect(textOf(out)).toContain("Please choose how to read the dates.");
    expect(textOf(out)).toContain("Please choose the unit the weights are in.");
    expect(out).toContain('aria-invalid="true"');
    const chosen = render();
    expect(textOf(chosen)).not.toContain("Please choose how to read the dates.");
  });

  it("every control has a label, and a disabled editor disables its fieldsets", () => {
    const out = render({ disabled: true });
    expect((out.match(/<fieldset[^>]*disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(6);
    const selects = (out.match(/<select/g) ?? []).length;
    const labelled = (out.match(/<label[^>]*for="/g) ?? []).length;
    expect(labelled).toBeGreaterThanOrEqual(selects);
  });

  it("never calls the 3PL's own amounts a cost, a loss, a margin or a profit", () => {
    expect(bannedIn(textOf(render()))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------
describe("the upload form", () => {
  const view = (state: Parameters<typeof UploadFormView>[0]["state"]) => html(createElement(UploadFormView, { state, formAction: noop, attempt: 1 }));

  it("idle: the money rule is the first line under the file, then the limits and the template link", () => {
    const out = view(initialState);
    const hint = textOf(/<p id="adjustment-history-file-hint"[^>]*>(.*?)<\/p>/.exec(out)![1]!);
    expect(hint).toBe(`${MONEY_FIELD_HINT} Limits: ${IMPORT_LIMITS}.`);
    expect(out).toContain('href="/api/templates/adjustments.csv"');
    expect(textOf(out)).toContain("Download the template (CSV)");
    expect(textOf(out)).toContain("Nothing is imported until you approve how the file is read.");
    expect(out).toContain('type="file"');
    expect(out).toContain('accept=".csv,.xlsx,');
    expect(textOf(out)).toContain("Upload file");
    expect(out).not.toContain('role="alert"');
  });

  it("a refusal shows the action's message word for word under its title, and nothing else", () => {
    const message = 'The column "Carrier Rate" looks like what a carrier bills you. ParcelClarity only accepts what your customer was, or would be, charged. Nothing from this file was saved. Remove that column, or export the customer charge instead, then upload again.';
    const out = view({ ok: false, refused: true, message });
    expect(out).toContain('role="alert"');
    expect(textOf(out)).toContain(REFUSAL_TITLE);
    expect(textOf(out)).toContain(message);
    expect(textOf(out)).toContain("Carrier Rate");
  });

  it("an ordinary failure shows its message without the refusal title; a field error is attached to the file", () => {
    const plain = view({ ok: false, message: "You already have five imports in progress. Finish or discard one first." });
    expect(textOf(plain)).toContain("You already have five imports in progress.");
    expect(textOf(plain)).not.toContain(REFUSAL_TITLE);
    const field = view({ ok: false, errors: { file: "The file is larger than 5 MB. Split it by month and import each part." } });
    expect(field).toContain('aria-invalid="true"');
    expect(field).toContain('aria-describedby="adjustment-history-file-hint adjustment-history-file-error"');
    expect(textOf(field)).toContain("The file is larger than 5 MB.");
  });

  it("the file input is 44px tall at least and the upload card says what to upload", () => {
    const out = view(initialState);
    expect(out).toContain("min-h-11");
    expect(textOf(out)).toContain("A CSV or XLSX of what your customers were charged for past reweighs, remeasures and other corrections.");
  });

  it("the file input has a label and its hint and error are wired to it", () => {
    for (const out of [view(initialState), view({ ok: false, errors: { file: "x" } })]) {
      expect(idProblems(out)).toEqual([]);
      expect(unnamedControls(out)).toEqual([]);
    }
  });

  it("for a member who cannot manage: no form, no file input", () => {
    const out = html(createElement(HistoryUploadForm, { canManage: false }));
    expect(out).not.toContain("<form");
    expect(out).not.toContain('type="file"');
    expect(textOf(out)).toContain("Only administrators can upload history.");
    expect(html(createElement(HistoryUploadForm, { canManage: true }))).toContain('type="file"');
  });

  it("the template the link points to teaches the rule in its column names", () => {
    expect([...ADJUSTMENT_TEMPLATE_HEADERS]).toEqual(expect.arrayContaining(["customer_charge_original", "customer_charge_corrected", "customer_adjustment_fee"]));
  });
});

// ---------------------------------------------------------------------------
// The wizard, state by state
// ---------------------------------------------------------------------------
describe("the import wizard", () => {
  const data = (over: Partial<WizardProps["data"]> = {}): WizardProps["data"] => ({
    importId: IMPORT_ID,
    name: "august-history",
    status: "uploaded",
    canManage: true,
    detection: sample.detection,
    detectionProblem: null,
    sampleRows: sample.sampleRows,
    brands: BRANDS.map((b) => ({ id: b.id, name: b.name })),
    catalog: CATALOG,
    rowCount: 40,
    ...over,
  });
  const state = (over: Partial<WizardProps["state"]> = {}): WizardProps["state"] => ({ mapping: sample.mapping, attested: false, phase: "idle", error: null, report: null, stale: false, dateUnchosen: false, unitUnchosen: false, committed: null, ...over });
  const handlers: WizardProps["handlers"] = { onMapping: noop, onAttest: noop, onCheck: noop, onImport: async () => ({ ok: true }), onChooseDate: noop, onChooseUnit: noop };
  const render = (d = data(), s = state()) => html(createElement(ImportWizardView, { data: d, state: s, handlers, ids: { prefix: "w" } }));
  const button = (out: string, name: string) => new RegExp(`<button[^>]*>(?:<[^>]+>)*${name}</button>`).exec(out)?.[0] ?? null;

  it("a new upload starts on Map columns: the mapping, the statement, a disabled check, and Discard; no report, no import", () => {
    const out = render();
    const t = textOf(out);
    expect(t).toContain("How we read your file");
    expect(t).toContain("40 rows in the file.");
    expect(t).toContain("Nothing is imported until you approve how the file is read.");
    expect(t).toContain("A package that an earlier file already added (same customer, carrier, package reference and kind of adjustment) is skipped, even when its amounts differ. Repeats inside this one file follow the choice you make below.");
    expect(t).toContain(ATTESTATION_TEXT);
    expect(out).toContain('aria-current="step"');
    expect(t).not.toContain("What we found");
    expect(t).not.toContain("Import rows");
    expect(t).toContain("Discard import");
  });

  it("the check is disabled until the statement is ticked, and says why", () => {
    const off = render();
    expect(button(off, "Check the file")).toMatch(/disabled=""/);
    expect(textOf(off)).toContain("Tick the box above to check the file.");
    expect(off).toMatch(/<input[^>]*type="checkbox"[^>]*aria-required="true"/);
    expect(off).not.toMatch(/<input[^>]*type="checkbox"[^>]*checked=""/);
    const on = render(data(), state({ attested: true }));
    expect(button(on, "Check the file")).not.toMatch(/disabled=""/);
    expect(on).toMatch(/<input[^>]*type="checkbox"[^>]*checked=""/);
    expect(textOf(on)).not.toContain("Tick the box above");
  });

  it("the statement is exactly the prescribed sentence and is the checkbox's label", () => {
    const out = render();
    expect(out).toMatch(/<label for="w-attest"[^>]*>.*<span>These charge columns hold what my customer was or would be charged\. They do not hold what the carrier billed me\.<\/span><\/label>/);
  });

  it("a choice still to be made keeps the check disabled even when the statement is ticked, and lists it", () => {
    const out = render(data(), state({ attested: true, dateUnchosen: true }));
    expect(button(out, "Check the file")).toMatch(/disabled=""/);
    expect(textOf(out)).toContain("Before you can check the file:");
    expect(textOf(out)).toContain("Choose how to read the dates.");
    expect(textOf(out)).not.toContain("Tick the box above");
  });

  it("while checking: the label says so, the button is busy, and the mapping cannot be edited", () => {
    const out = render(data(), state({ attested: true, phase: "checking" }));
    expect(button(out, "Checking…")).toMatch(/aria-busy="true"/);
    expect(out).toMatch(/<fieldset[^>]*disabled=""/);
  });

  it("a failed step shows its message as an alert that takes focus", () => {
    const out = render(data(), state({ error: { message: 'The column "Carrier Rate" cannot be used for a charge. It looks like carrier cost data.', attempt: 1 } }));
    expect(out).toContain('role="alert"');
    expect(out).toContain('tabindex="-1"');
    expect(textOf(out)).toContain("cannot be used for a charge");
  });

  it("a report with rows to fix is shown, and no way to import is offered", () => {
    const out = render(data({ status: "mapped" }), state({ report: broken.report, attested: true }));
    expect(textOf(out)).toContain("What we found");
    expect(textOf(out)).toContain("10 rows need fixing");
    expect(textOf(out)).not.toContain("Import rows");
    expect(out).toContain('aria-current="step"');
  });

  it("a clean report offers the import with the row count, the ship dates, and that Withdraw exists", () => {
    const out = render(data({ status: "validated" }), state({ report: sample.report, attested: true }));
    const t = textOf(out);
    expect(t).toContain("What we found");
    expect(t).toContain("40 rows will be added to your history, shipped Aug 3, 2026 to Sep 11, 2026.");
    expect(button(out, "Import rows")).not.toBeNull();
  });

  it("the confirmation (the second step of Import rows) names the row count, the date range and that Withdraw exists", () => {
    const tree = ImportWizardView({ data: data({ status: "validated" }), state: state({ report: sample.report, attested: true }), handlers, ids: { prefix: "w" } });
    const confirms = findElements(tree, (el) => (el.props as { label?: string }).label === "Import rows");
    expect(confirms).toHaveLength(1);
    const props = confirms[0]!.props as { label: string; confirmLabel: string; variant: string; children: unknown };
    expect(props.confirmLabel).toBe("Import 40 rows");
    expect(nodeText(props.children as never)).toBe("Import 40 rows shipped Aug 3, 2026 to Sep 11, 2026? You can take them back with Withdraw import.");
    // The button that starts the step and the one that confirms it name the same action.
    expect(props.confirmLabel.startsWith("Import")).toBe(true);
    expect(props.label.startsWith("Import")).toBe(true);
  });

  it("a report older than the mapping on screen is flagged, and the import is not offered until it is checked again", () => {
    const out = render(data({ status: "validated" }), state({ report: sample.report, stale: true, attested: false }));
    const t = textOf(out);
    expect(t).toContain("You changed how the file is read.");
    expect(t).not.toContain("will be added to your history");
    expect(button(out, "Import rows")).toBeNull();
  });

  it("an import that did not finish says so, and offers to start over; nothing from the earlier attempt is kept", () => {
    const out = render(data({ status: "committing", detection: null, detectionProblem: "The uploaded file is no longer kept." }), state({ mapping: null, report: sample.report }));
    const t = textOf(out);
    expect(t).toContain("An earlier import of this file did not finish");
    expect(t).toContain("Importing again starts over");
    expect(t).not.toContain("How we read your file");
    expect(button(out, "Import rows")).not.toBeNull();
  });

  it("an unreadable file says why and offers Discard, not the mapping", () => {
    const out = render(data({ detection: null, detectionProblem: "The uploaded file is no longer available. Upload it again." }), state({ mapping: null }));
    expect(out).toContain('role="alert"');
    expect(textOf(out)).toContain("This file cannot be read now");
    expect(textOf(out)).toContain("The uploaded file is no longer available. Upload it again.");
    expect(textOf(out)).toContain("Discard import");
    expect(textOf(out)).not.toContain("Check the file");
  });

  it("while importing: the row count, the batch size, and to keep the page open, announced politely", () => {
    const out = render(data({ status: "validated" }), state({ report: sample.report, phase: "importing" }));
    expect(out).toMatch(/<p role="status" aria-live="polite"[^>]*>Importing 40 rows, in batches of up to 2,000\. Keep this page open until it finishes\.<\/p>/);
  });

  it("when the import has finished in this session: the committed view with Withdraw, not the wizard", () => {
    const out = render(data({ status: "validated" }), state({ committed: { importId: IMPORT_ID, name: "august-history", committedCount: 40, skippedCount: 0, committedAt: "2026-10-17", shipDateFrom: "2026-08-03", shipDateTo: "2026-09-11", message: "Imported 40 rows." } }));
    const t = textOf(out);
    expect(t).toContain("Imported 40 rows.");
    expect(t).toContain("40 rows added to your history on Oct 17, 2026.");
    expect(t).toContain("Withdraw import");
    expect(t).not.toContain("Check the file");
  });

  it("read-only: the notice, the report if there is one, and no control", () => {
    const out = render(data({ canManage: false, status: "validated" }), state({ report: sample.report }));
    expect(textOf(out)).toContain("You can view adjustments, but only administrators can manage them.");
    expect(textOf(out)).toContain("What we found");
    for (const control of ["Check the file", "Import rows", "Discard import", "<select", 'type="checkbox"']) expect(out).not.toContain(control);
  });

  it("has the four steps, marks only the current one, and never colours alone: the current step is also announced", () => {
    const out = html(createElement(ImportSteps, { current: 3 }));
    expect(textOf(out)).toBe("1 Upload (done) 2 Map columns (done) 3 Check 4 Import");
    expect((out.match(/aria-current="step"/g) ?? []).length).toBe(1);
  });

  it("is well formed for assistive technology in every state: unique ids, every reference resolves, every control has a name", () => {
    const states = [
      render(),
      render(data(), state({ attested: true, report: sample.report })),
      render(data({ status: "validated" }), state({ report: sample.report, attested: true })),
      render(data({ status: "mapped" }), state({ report: broken.report, error: { message: "x", attempt: 1 } })),
      render(data(), state({ dateUnchosen: true, unitUnchosen: true })),
    ];
    for (const out of states) {
      expect(idProblems(out)).toEqual([]);
      expect(unnamedControls(out)).toEqual([]);
    }
  });

  it("uses no h1 and never calls the 3PL's own amounts a cost, a loss, a margin or a profit", () => {
    for (const out of [render(), render(data({ status: "validated" }), state({ report: sample.report, attested: true })), render(data({ status: "mapped" }), state({ report: broken.report }))]) {
      expect(out).not.toMatch(/<h1/);
      expect(bannedIn(textOf(out).replace(/how much they cost/g, ""))).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Committed, ended and the list
// ---------------------------------------------------------------------------
describe("a committed or ended import", () => {
  it("committed: what was added, the dates, what was skipped, that the file is deleted, where to see it, and Withdraw for an administrator", () => {
    const summary = { importId: IMPORT_ID, name: "august", committedCount: 1240, skippedCount: 12, committedAt: "2026-10-16T09:00:00Z", shipDateFrom: "2026-08-01", shipDateTo: "2026-08-31" };
    const out = html(createElement(ImportCommittedView, { summary, canManage: true }));
    const t = textOf(out);
    expect(t).toContain("1,240 rows added to your history on Oct 16, 2026. Shipped Aug 1, 2026 to Aug 31, 2026. 12 rows skipped as already imported. The uploaded file was deleted when the import finished.");
    expect(t).toContain("Add packages shipped");
    expect(out).toContain('href="/app/adjustments/history/statistics"');
    expect(out).toContain('href="/app/adjustments/history/baselines"');
    expect(t).toContain("Withdraw import");
    expect(t).toContain("Withdrawing an import deletes the 1,240 records it added. You can import the file again afterwards.");
    const readOnly = html(createElement(ImportCommittedView, { summary, canManage: false }));
    expect(readOnly).not.toContain("Withdraw import");
  });

  it("discarded and withdrawn: a plain notice, and a way back; no records and no file", () => {
    const discarded = textOf(html(createElement(ImportEndedView, { status: "discarded" })));
    const withdrawn = textOf(html(createElement(ImportEndedView, { status: "withdrawn" })));
    expect(discarded).toContain("This import was discarded");
    expect(discarded).toContain("The file and everything read from it were deleted.");
    expect(withdrawn).toContain("This import was withdrawn");
    expect(withdrawn).toContain("Its records were deleted.");
    expect(html(createElement(ImportEndedView, { status: "withdrawn" }))).toContain('href="/app/adjustments/history"');
  });
});

describe("the list of imports", () => {
  const base = { id: "i1", name: "august-history", rowCount: 40, committedCount: 0, skippedCount: 0, createdAt: "2026-10-01T10:00:00Z", committedAt: null, shipDateFrom: null, shipDateTo: null };

  it("empty: the empty state asks for the next action", () => {
    const t = textOf(html(createElement(HistoryList, { imports: [] })));
    expect(t).toContain("No history yet");
    expect(t).toContain("Upload what your customers were charged for past reweighs and remeasures. Only your team can see it.");
  });

  it("one row per import, each a single link whose name says what it opens and where it stands, with the status as words and a badge", () => {
    const out = html(
      createElement(HistoryList, {
        imports: [
          { ...base, id: "i1", status: "committed" as const, committedCount: 1240, skippedCount: 12, shipDateFrom: "2026-08-01", shipDateTo: "2026-08-31" },
          { ...base, id: "i2", name: "september", status: "uploaded" as const, rowCount: 1 },
          { ...base, id: "i3", name: "old", status: "withdrawn" as const },
        ],
      }),
    );
    const t = textOf(out);
    expect(out).toContain('href="/app/adjustments/history/i1"');
    expect(accessibleNames(out).filter((n) => n !== "Imports")).toEqual(["august-history, Imported", "september, Map the columns", "old, Withdrawn"]);
    expect(out).toContain('aria-label="Imports"');
    expect(t).toContain("1,240 rows imported, 12 skipped as already imported");
    expect(t).toContain("Shipped Aug 1, 2026 to Aug 31, 2026.");
    expect(t).toContain("1 row in the file");
    expect(t).toContain("40 rows in the file; nothing is kept");
    // A phone stacks each row; from 640px it is one line.
    expect(out).toContain("flex-col");
    expect(out).toContain("sm:flex-row");
  });

  it("describes an import's size in words for each state", () => {
    expect(importSizeLine({ status: "committed", rowCount: 5, committedCount: 1, skippedCount: 0 })).toBe("1 row imported");
    expect(importSizeLine({ status: "validated", rowCount: 5, committedCount: 0, skippedCount: 0 })).toBe("5 rows in the file");
    expect(importSizeLine({ status: "discarded", rowCount: 5, committedCount: 0, skippedCount: 0 })).toBe("5 rows in the file; nothing is kept");
  });
});
