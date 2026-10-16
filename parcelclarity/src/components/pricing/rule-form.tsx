"use client";

import { useId, useState, useTransition, type ReactNode } from "react";
import { addSurchargeRuleVersion, createSurchargeRule, retireRuleVersion, uploadZipList } from "@/app/actions/surcharges";
import { ActionForm, SubmitButton, useFormState } from "@/components/forms/action-form";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { isAdjustmentFeeCategory } from "@/engine/types";
import type { CalculationBase, CalculationMethod, ChargeClass, PackageType, RuleCondition, SignatureOption, SurchargeCategory, VerificationStatus } from "@/engine/types";
import type { ServiceCatalogEntry } from "@/lib/import/rate-card-mapping";
import { formatDate, formatDateTime } from "@/lib/format/date";

/**
 * Client-side pieces of surcharge rule administration:
 *   - RuleForm: creates a rule (first draft version) or adds a draft version to an existing rule.
 *     Every field is controlled so a failed submit never clears what was typed (React resets
 *     uncontrolled fields after a form action completes, and the surcharge actions echo no values).
 *   - RetireVersionForm: retires a published version as of a chosen day.
 *   - ZipListUploadForm: uploads and publishes a ZIP code list.
 *   - Small presentational components (labels, charge and condition summaries) that the server
 *     pages render so the wording of a rule is defined in exactly one place.
 */

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const CATEGORY_LABELS: Record<SurchargeCategory, string> = {
  fuel: "Fuel",
  residential: "Residential delivery",
  das: "Delivery area (DAS)",
  das_extended: "Extended delivery area",
  remote_area: "Remote area",
  additional_handling: "Additional handling",
  oversize: "Oversize / large package",
  peak: "Peak / demand",
  address_correction: "Address correction",
  signature: "Signature",
  declared_value: "Declared value",
  saturday_delivery: "Saturday delivery",
  reweight: "Reweight adjustment",
  remeasure: "Remeasure adjustment",
  shipping_charge_correction: "Shipping charge correction",
  other: "Other",
};
const CATEGORY_OPTIONS = (Object.keys(CATEGORY_LABELS) as SurchargeCategory[]).map((value) => ({ value, label: CATEGORY_LABELS[value] }));

const CHARGE_CLASS_LABELS: Record<ChargeClass, string> = { definite: "Definite charge", estimated: "Estimate", conditional: "Conditional adjustment" };
const CHARGE_CLASS_HINTS: Record<ChargeClass, string> = {
  definite: "Follows from the shipment inputs and the published terms. Counted in the definite total.",
  estimated: "Rests on an assumption or on data that may be missing at quote time. Shown and counted as an estimate.",
  conditional: "A post-shipment adjustment that may or may not occur (reweight, address correction). Shown as exposure, never counted.",
};
const CHARGE_CLASS_OPTIONS = (Object.keys(CHARGE_CLASS_LABELS) as ChargeClass[]).map((value) => ({ value, label: CHARGE_CLASS_LABELS[value] }));
/** A reweigh, remeasure or shipping charge correction is something the carrier may apply after shipping: the only class it can have. */
const ADJUSTMENT_FEE_CLASS_OPTIONS = CHARGE_CLASS_OPTIONS.filter((o) => o.value === "conditional");
const ADJUSTMENT_FEE_CLASS_HINT = "Always a conditional adjustment for this category: it is charged only if the carrier applies it after shipping, so it is shown as possible exposure and never counted in a total.";

/** Rule keys come out of the name and reach customers (they are readable through the API), so what goes in the name must be fit for them to read. */
const RULE_KEY_HINT = "Rule keys can be read by your customers through the API, so do not put customer names or margins in them.";

const METHOD_LABELS: Record<CalculationMethod, string> = { flat: "Flat amount", percent: "Percentage", per_unit: "Per unit of declared value" };
const METHOD_OPTIONS = (Object.keys(METHOD_LABELS) as CalculationMethod[]).map((value) => ({ value, label: METHOD_LABELS[value] }));

/** One label and one tone per verification status, wherever a rule version is shown (rule pages, calculator results). */
export const VERIFICATION: Record<VerificationStatus, { label: string; tone: "accent" | "success" | "warning" }> = {
  approved_3pl_config: { label: "Approved 3PL configuration", tone: "accent" },
  verified: { label: "Verified published source", tone: "success" },
  unverified: { label: "Unverified", tone: "warning" },
};

const SIGNATURE_LABELS: Record<SignatureOption, string> = { none: "No signature", indirect: "Indirect signature", direct: "Direct signature", adult: "Adult signature" };
const SIGNATURE_OPTIONS = Object.keys(SIGNATURE_LABELS) as SignatureOption[];
const PACKAGE_TYPE_LABELS: Record<PackageType, string> = { parcel: "Parcel", carrier_flat_rate: "Carrier flat-rate packaging", envelope: "Envelope", tube: "Tube", pallet: "Pallet" };
const PACKAGE_TYPE_OPTIONS = Object.keys(PACKAGE_TYPE_LABELS) as PackageType[];

type ConditionType = RuleCondition["type"];
const CONDITION_TYPES: { type: ConditionType; label: string }[] = [
  { type: "residential", label: "Delivery address is residential or commercial" },
  { type: "weight_gt", label: "Weight is over…" },
  { type: "weight_lte", label: "Weight is at most…" },
  { type: "longest_side_gt", label: "Longest side is over…" },
  { type: "second_longest_side_gt", label: "Second-longest side is over…" },
  { type: "length_plus_girth_gt", label: "Length plus girth is over…" },
  { type: "cubic_in_gt", label: "Volume is over… (cubic inches)" },
  { type: "zone_in", label: "Destination zone is one of…" },
  { type: "destination_zip_in_list", label: "Destination ZIP is in a ZIP list" },
  { type: "destination_zip_prefix_in", label: "Destination ZIP starts with…" },
  { type: "declared_value_gt", label: "Declared value is over…" },
  { type: "signature_in", label: "Signature option is one of…" },
  { type: "saturday_delivery", label: "Saturday delivery requested or not" },
  { type: "package_type_in", label: "Package type is one of…" },
  { type: "flag_present", label: "Package carries a handling flag" },
  { type: "ship_date_between", label: "Ship date is between two dates" },
  { type: "package_count_gt", label: "Shipment has more than N packages" },
  { type: "rule_applied", label: "Another rule applied to the package" },
  { type: "any_of", label: "Any of the following holds (OR group)" },
];

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const money = (value: string | null | undefined): string => {
  if (value === null || value === undefined || value.trim() === "") return "…";
  const n = Number(value);
  return Number.isFinite(n) ? usd.format(n) : value;
};
/** "16.5000" → "16.5", "12.000" → "12". */
const tidy = (value: string | null | undefined): string => {
  if (value === null || value === undefined) return "";
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
};
const percentText = (value: string | null) => (value === null || value.trim() === "" ? "…%" : `${tidy(value)}%`);
const listOr = (items: string[]): string => {
  if (items.length === 0) return "…";
  if (items.length === 1) return items[0] ?? "…";
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
};
const splitList = (text: string) => text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

// ---------------------------------------------------------------------------
// Plain-English rendering (shared by the builder preview and the read-only pages)
// ---------------------------------------------------------------------------

export function describeCondition(c: RuleCondition): string {
  switch (c.type) {
    case "residential":
      return c.value ? "Delivery address is residential" : "Delivery address is commercial";
    case "weight_gt":
      return `${c.basis === "billable" ? "Billable" : "Actual"} weight is over ${c.valueLb || "…"} lb`;
    case "weight_lte":
      return `${c.basis === "billable" ? "Billable" : "Actual"} weight is ${c.valueLb || "…"} lb or less`;
    case "longest_side_gt":
      return `Longest side is over ${c.inches || "…"} in`;
    case "second_longest_side_gt":
      return `Second-longest side is over ${c.inches || "…"} in`;
    case "length_plus_girth_gt":
      return `Length plus girth is over ${c.inches || "…"} in`;
    case "cubic_in_gt":
      return `Volume is over ${c.value || "…"} cubic in`;
    case "zone_in":
      return `Destination zone is ${listOr(c.zones)}`;
    case "destination_zip_in_list":
      return `Destination ZIP is in the list "${c.listKey || "…"}"`;
    case "destination_zip_prefix_in":
      return `Destination ZIP starts with ${listOr(c.prefixes)}`;
    case "declared_value_gt":
      return `Declared value is over ${money(c.amount)}`;
    case "signature_in":
      return `Signature option is ${listOr(c.values.map((v) => SIGNATURE_LABELS[v].toLowerCase()))}`;
    case "saturday_delivery":
      return c.value ? "Saturday delivery is requested" : "Saturday delivery is not requested";
    case "package_type_in":
      return `Package type is ${listOr(c.types.map((t) => PACKAGE_TYPE_LABELS[t].toLowerCase()))}`;
    case "flag_present":
      return `Package carries the "${c.flag || "…"}" flag`;
    case "ship_date_between":
      return `Ship date is between ${c.from || "…"} and ${c.to || "…"}`;
    case "package_count_gt":
      return `Shipment has more than ${Number.isFinite(c.value) ? c.value : "…"} packages`;
    case "rule_applied":
      return `The rule "${c.ruleKey || "…"}" also applied`;
    case "any_of":
      return c.conditions.length ? `Any of: ${c.conditions.map(describeCondition).join("; or ")}` : "Any of: (no inner conditions yet)";
  }
}

/** The figures of one rule version, as the summaries need them (decimal strings as stored). */
export interface ChargeTerms {
  method: CalculationMethod;
  amount: string | null;
  percent: string | null;
  perUnitSize: string | null;
  perUnitFreeAllowance: string | null;
  perUnitMinimumCharge: string | null;
  /** null when the stored base could not be read. */
  base: CalculationBase | null;
  perPackage: boolean;
}

function describeBase(base: CalculationBase | null): string {
  if (!base) return "the base rate (base setting could not be read)";
  if (base.kind === "base_rate") return "the base rate";
  if (base.kind === "base_plus_all_surcharges") return "the base rate plus every other surcharge";
  return `the base rate plus ${listOr(base.categories.map((c) => CATEGORY_LABELS[c].toLowerCase()))}`;
}

export function describeCharge(t: ChargeTerms): string {
  const scope = t.perPackage ? "per package" : "per shipment";
  if (t.method === "percent") return `${percentText(t.percent)} of ${describeBase(t.base)}, ${scope}`;
  if (t.method === "per_unit") {
    const free = t.perUnitFreeAllowance && Number(t.perUnitFreeAllowance) > 0 ? ` above ${money(t.perUnitFreeAllowance)}` : "";
    const min = t.perUnitMinimumCharge ? `, at least ${money(t.perUnitMinimumCharge)}` : "";
    return `${money(t.amount)} per ${money(t.perUnitSize)} of declared value${free}${min}, ${scope}`;
  }
  return `${money(t.amount)} flat, ${scope}`;
}

export function CategoryLabel({ category }: { category: string }) {
  return <>{(CATEGORY_LABELS as Record<string, string>)[category] ?? category}</>;
}

export function ChargeSummary({ terms }: { terms: ChargeTerms }) {
  return <span className="tabular">{describeCharge(terms)}</span>;
}

export function RuleStatusBadge({ status }: { status: string }) {
  const tone = status === "published" ? "success" : status === "retired" ? "warning" : "neutral";
  return <Badge tone={tone}>{status}</Badge>;
}

export function VerificationBadge({ status }: { status: string }) {
  const v = (VERIFICATION as Record<string, { label: string; tone: "accent" | "success" | "warning" }>)[status];
  return <Badge tone={v?.tone ?? "warning"}>{v?.label ?? status}</Badge>;
}

export function ConditionsSummary({ conditions }: { conditions: RuleCondition[] | null }) {
  if (conditions === null) return <p className="text-sm font-medium text-danger">The stored conditions could not be read; the engine will not apply this version.</p>;
  if (!conditions.length) return <p className="text-sm">Always applies (no conditions).</p>;
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm">
      {conditions.map((c, i) => (
        <li key={i}>{describeCondition(c)}</li>
      ))}
    </ul>
  );
}

/** Everything a read-only view of one version shows, built by the page from the database row. */
export interface RuleVersionView {
  versionNumber: number;
  status: string;
  chargeClass: ChargeClass;
  terms: ChargeTerms;
  /** null = every service of the carrier. */
  serviceNames: string[] | null;
  carrierName: string;
  billableWeightFloorLb: string | null;
  conditions: RuleCondition[] | null;
  exclusivityGroup: string | null;
  exclusivityPriority: number;
  excludesRuleKeys: string[];
  effectiveDate: string;
  expirationDate: string | null;
  sourceReference: string;
  sourceUrl: string | null;
  verificationStatus: string;
  publishedAt: string | null;
  retiredAt: string | null;
  createdAt: string;
}

export function formatEffectiveRange(effective: string, expiration: string | null): string {
  return expiration ? `${formatDate(effective)} – ${formatDate(expiration)}` : `From ${formatDate(effective)}, no end date`;
}

export function VersionTerms({ version: v }: { version: RuleVersionView }) {
  const items: [string, ReactNode][] = [
    ["Charge", <ChargeSummary key="charge" terms={v.terms} />],
    ["Method", METHOD_LABELS[v.terms.method]],
    ["Charge class", `${CHARGE_CLASS_LABELS[v.chargeClass]}: ${CHARGE_CLASS_HINTS[v.chargeClass].split(".")[0]?.toLowerCase() ?? ""}`],
    ["Services", v.serviceNames === null ? `All ${v.carrierName} services` : v.serviceNames.join(", ") || "None on the catalog"],
    ["Effective", formatEffectiveRange(v.effectiveDate, v.expirationDate)],
    ["Charged", v.terms.perPackage ? "Once per package" : "Once per shipment"],
    ["Billable weight floor", v.billableWeightFloorLb ? `${tidy(v.billableWeightFloorLb)} lb when this rule applies` : "None"],
    ["Exclusivity", v.exclusivityGroup ? `Group ${v.exclusivityGroup}, priority ${v.exclusivityPriority}` : "None"],
    ["Suppresses rules", v.excludesRuleKeys.length ? v.excludesRuleKeys.join(", ") : "None"],
    [
      "Source",
      <span key="source">
        {v.sourceReference}
        {v.sourceUrl ? (
          <>
            {" "}
            <a href={v.sourceUrl} target="_blank" rel="noreferrer" className="break-all text-accent-text hover:underline">
              Open source
            </a>
          </>
        ) : null}
      </span>,
    ],
    ["History", [`Created ${formatDateTime(v.createdAt)}`, v.publishedAt ? `published ${formatDateTime(v.publishedAt)}` : null, v.retiredAt ? `retired ${formatDateTime(v.retiredAt)}` : null].filter(Boolean).join(" · ")],
  ];
  return (
    <div className="space-y-4">
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {items.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-muted">{label}</dt>
            <dd className="font-medium break-words">{value}</dd>
          </div>
        ))}
      </dl>
      <div>
        <p className="text-sm text-muted">Applies when</p>
        <div className="mt-1">
          <ConditionsSummary conditions={v.conditions} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controlled field helpers (Field/Input/Select from the design system, errors from ActionForm)
// ---------------------------------------------------------------------------

interface ControlBase {
  id: string;
  label: string;
  hint?: ReactNode;
  /** Submitted field name. Omit for inputs whose value travels in a JSON hidden field. */
  name?: string;
  /** ActionForm error key when it differs from `name`. */
  errorKey?: string;
}

function TextInput({
  id,
  label,
  hint,
  name,
  errorKey,
  value,
  onChange,
  type = "text",
  inputMode,
  placeholder,
  required,
  list,
  min,
  max,
  autoCapitalize,
}: ControlBase & {
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "url" | "date" | "number";
  inputMode?: "decimal" | "numeric" | "text";
  placeholder?: string;
  required?: boolean;
  list?: string;
  min?: string;
  max?: string;
  autoCapitalize?: "none" | "sentences";
}) {
  const state = useFormState();
  const key = errorKey ?? name;
  return (
    <Field id={id} label={label} error={key ? state.errors?.[key] : undefined} hint={hint}>
      {(aria) => (
        <Input
          {...aria}
          name={name}
          type={type}
          inputMode={inputMode}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          required={required}
          list={list}
          min={min}
          max={max}
          autoComplete="off"
          autoCapitalize={autoCapitalize}
          spellCheck={false}
        />
      )}
    </Field>
  );
}

function SelectInput<T extends string>({
  id,
  label,
  hint,
  name,
  errorKey,
  value,
  onChange,
  options,
  disabled,
}: ControlBase & { value: T; onChange: (value: T) => void; options: { value: T; label: string }[]; disabled?: boolean }) {
  const state = useFormState();
  const key = errorKey ?? name;
  return (
    <Field id={id} label={label} error={key ? state.errors?.[key] : undefined} hint={hint}>
      {(aria) => (
        <Select {...aria} name={name} value={value} onChange={(e) => onChange(e.target.value as T)} disabled={disabled}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

function CheckBox({ id, label, hint, name, value, checked, onChange }: { id: string; label: string; hint?: ReactNode; name?: string; value?: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex min-h-11 items-start gap-3 py-2 text-sm">
      <input id={id} type="checkbox" name={name} value={value} checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-5 shrink-0 accent-accent" />
      <span>
        <span className="font-medium">{label}</span>
        {hint ? <span className="block text-muted">{hint}</span> : null}
      </span>
    </label>
  );
}

function FormError({ name, id }: { name: string; id?: string }) {
  const state = useFormState();
  const error = state.errors?.[name];
  return error ? (
    <p id={id} role="alert" className="text-sm font-medium text-danger">
      {error}
    </p>
  ) : null;
}

/** Fieldset whose group-level error (conditions, services) is announced with the group, like a Field's error with its input. */
function ErrorFieldset({ name, id, className, children }: { name: string; id: string; className: string; children: ReactNode }) {
  const state = useFormState();
  const errorId = `${id}-error`;
  return (
    <fieldset className={className} aria-describedby={state.errors?.[name] ? errorId : undefined}>
      {children}
      <FormError name={name} id={errorId} />
    </fieldset>
  );
}

const toggle = <T,>(list: T[], item: T, on: boolean): T[] => (on ? (list.includes(item) ? list : [...list, item]) : list.filter((x) => x !== item));

// ---------------------------------------------------------------------------
// Condition builder: a loose draft record per row (text inputs stay text while editing)
// ---------------------------------------------------------------------------

interface ConditionDraft {
  id: number;
  type: ConditionType;
  text: string;
  text2: string;
  basis: "actual" | "billable";
  bool: boolean;
  signatures: SignatureOption[];
  packageTypes: PackageType[];
  children: ConditionDraft[];
}

const emptyDraft = (id: number, type: ConditionType = "residential"): ConditionDraft => ({ id, type, text: "", text2: "", basis: "billable", bool: true, signatures: [], packageTypes: [], children: [] });

function fromCondition(c: RuleCondition, nextId: () => number): ConditionDraft {
  const base = emptyDraft(nextId(), c.type);
  switch (c.type) {
    case "residential":
    case "saturday_delivery":
      return { ...base, bool: c.value };
    case "weight_gt":
    case "weight_lte":
      return { ...base, text: tidy(c.valueLb), basis: c.basis };
    case "longest_side_gt":
    case "second_longest_side_gt":
    case "length_plus_girth_gt":
      return { ...base, text: tidy(c.inches) };
    case "cubic_in_gt":
      return { ...base, text: tidy(c.value) };
    case "zone_in":
      return { ...base, text: c.zones.join(", ") };
    case "destination_zip_in_list":
      return { ...base, text: c.listKey };
    case "destination_zip_prefix_in":
      return { ...base, text: c.prefixes.join(", ") };
    case "declared_value_gt":
      return { ...base, text: tidy(c.amount) };
    case "signature_in":
      return { ...base, signatures: c.values };
    case "package_type_in":
      return { ...base, packageTypes: c.types };
    case "flag_present":
      return { ...base, text: c.flag };
    case "ship_date_between":
      return { ...base, text: c.from, text2: c.to };
    case "package_count_gt":
      return { ...base, text: String(c.value) };
    case "rule_applied":
      return { ...base, text: c.ruleKey };
    case "any_of":
      return { ...base, children: c.conditions.map((inner) => fromCondition(inner, nextId)) };
  }
}

function toCondition(d: ConditionDraft): RuleCondition {
  const text = d.text.trim();
  switch (d.type) {
    case "residential":
      return { type: "residential", value: d.bool };
    case "weight_gt":
      return { type: "weight_gt", valueLb: text, basis: d.basis };
    case "weight_lte":
      return { type: "weight_lte", valueLb: text, basis: d.basis };
    case "longest_side_gt":
      return { type: "longest_side_gt", inches: text };
    case "second_longest_side_gt":
      return { type: "second_longest_side_gt", inches: text };
    case "length_plus_girth_gt":
      return { type: "length_plus_girth_gt", inches: text };
    case "cubic_in_gt":
      return { type: "cubic_in_gt", value: text };
    case "zone_in":
      return { type: "zone_in", zones: splitList(d.text).map((z) => z.toUpperCase()) };
    case "destination_zip_in_list":
      return { type: "destination_zip_in_list", listKey: text };
    case "destination_zip_prefix_in":
      return { type: "destination_zip_prefix_in", prefixes: splitList(d.text) };
    case "declared_value_gt":
      return { type: "declared_value_gt", amount: text };
    case "signature_in":
      return { type: "signature_in", values: d.signatures };
    case "saturday_delivery":
      return { type: "saturday_delivery", value: d.bool };
    case "package_type_in":
      return { type: "package_type_in", types: d.packageTypes };
    case "flag_present":
      return { type: "flag_present", flag: text };
    case "ship_date_between":
      return { type: "ship_date_between", from: d.text, to: d.text2 };
    case "package_count_gt":
      return { type: "package_count_gt", value: Number.parseInt(text, 10) };
    case "rule_applied":
      return { type: "rule_applied", ruleKey: text };
    case "any_of":
      return { type: "any_of", conditions: d.children.map(toCondition) };
  }
}

const DECIMAL = /^\d+(\.\d+)?$/;
const KEY = /^[a-z][a-z0-9_.]{1,80}$/;

/** Obvious gaps shown inline while editing. The server action remains the authority. */
function draftProblem(d: ConditionDraft): string | null {
  const text = d.text.trim();
  switch (d.type) {
    case "weight_gt":
    case "weight_lte":
    case "longest_side_gt":
    case "second_longest_side_gt":
    case "length_plus_girth_gt":
    case "cubic_in_gt":
    case "declared_value_gt":
      return DECIMAL.test(text) ? null : "Enter a number.";
    case "package_count_gt":
      return /^\d+$/.test(text) ? null : "Enter a whole number.";
    case "zone_in":
      return splitList(d.text).length ? null : "Enter at least one zone.";
    case "destination_zip_in_list":
      return /^[a-z][a-z0-9_.]{1,60}$/.test(text) ? null : "Enter the list key (lowercase letters, digits, dots and underscores).";
    case "destination_zip_prefix_in": {
      const prefixes = splitList(d.text);
      return prefixes.length && prefixes.every((p) => /^\d{3,5}$/.test(p)) ? null : "Enter 3 to 5 digit ZIP prefixes.";
    }
    case "signature_in":
      return d.signatures.length ? null : "Pick at least one option.";
    case "package_type_in":
      return d.packageTypes.length ? null : "Pick at least one package type.";
    case "flag_present":
      return text ? null : "Enter the flag, for example hazmat.";
    case "ship_date_between":
      return d.text && d.text2 && d.text <= d.text2 ? null : "Enter a start and an end date.";
    case "rule_applied":
      return KEY.test(text) ? null : "Enter the other rule's key, for example ups.additional_handling.";
    case "any_of":
      if (!d.children.length) return "Add at least one inner condition.";
      return d.children.map(draftProblem).find(Boolean) ?? null;
    default:
      return null;
  }
}

interface ConditionRowProps {
  draft: ConditionDraft;
  /** Position in its list, for DOM ids and the accessible name of the remove button. */
  index: number;
  /** Prefix for DOM ids (derived from the row position, so server and client render the same ids). */
  idPrefix: string;
  nested: boolean;
  zipListId: string;
  onChange: (draft: ConditionDraft) => void;
  onRemove: () => void;
  onAddChild?: () => void;
}

function ConditionRow({ draft, index, idPrefix, nested, zipListId, onChange, onRemove, onAddChild }: ConditionRowProps) {
  const set = (patch: Partial<ConditionDraft>) => onChange({ ...draft, ...patch });
  const id = (suffix: string) => `${idPrefix}-${suffix}`;
  const types = nested ? CONDITION_TYPES.filter((t) => t.type !== "any_of") : CONDITION_TYPES;
  const problem = draftProblem(draft);
  const decimal = (label: string, placeholder: string) => <TextInput id={id("value")} label={label} value={draft.text} onChange={(text) => set({ text })} inputMode="decimal" placeholder={placeholder} />;
  const basis = (
    <SelectInput<"actual" | "billable">
      id={id("basis")}
      label="Measured as"
      value={draft.basis}
      onChange={(b) => set({ basis: b })}
      options={[
        { value: "billable", label: "Billable weight (after DIM and rounding)" },
        { value: "actual", label: "Actual scale weight" },
      ]}
    />
  );

  let inputs: ReactNode = null;
  switch (draft.type) {
    case "residential":
      inputs = (
        <SelectInput<"true" | "false">
          id={id("value")}
          label="Address type"
          value={draft.bool ? "true" : "false"}
          onChange={(b) => set({ bool: b === "true" })}
          options={[
            { value: "true", label: "Residential" },
            { value: "false", label: "Commercial" },
          ]}
        />
      );
      break;
    case "saturday_delivery":
      inputs = (
        <SelectInput<"true" | "false">
          id={id("value")}
          label="Saturday delivery"
          value={draft.bool ? "true" : "false"}
          onChange={(b) => set({ bool: b === "true" })}
          options={[
            { value: "true", label: "Requested" },
            { value: "false", label: "Not requested" },
          ]}
        />
      );
      break;
    case "weight_gt":
    case "weight_lte":
      inputs = (
        <>
          {decimal("Weight (lb)", "e.g. 50")}
          {basis}
        </>
      );
      break;
    case "longest_side_gt":
    case "second_longest_side_gt":
    case "length_plus_girth_gt":
      inputs = decimal("Inches", "e.g. 48");
      break;
    case "cubic_in_gt":
      inputs = decimal("Cubic inches", "e.g. 1728");
      break;
    case "declared_value_gt":
      inputs = decimal("Declared value (USD)", "e.g. 100");
      break;
    case "zone_in":
      inputs = <TextInput id={id("value")} label="Zones" value={draft.text} onChange={(text) => set({ text })} placeholder="e.g. 5, 6, 7, 8" hint="Comma-separated, as they appear on the rate card." autoCapitalize="none" />;
      break;
    case "destination_zip_in_list":
      inputs = <TextInput id={id("value")} label="ZIP list key" value={draft.text} onChange={(text) => set({ text })} placeholder="e.g. ups.das_2026" list={zipListId} hint="The key of a ZIP list uploaded below or published by ParcelClarity." autoCapitalize="none" />;
      break;
    case "destination_zip_prefix_in":
      inputs = <TextInput id={id("value")} label="ZIP prefixes" value={draft.text} onChange={(text) => set({ text })} inputMode="numeric" placeholder="e.g. 005, 006, 00901" hint="Comma-separated 3, 4 or 5 digit prefixes." />;
      break;
    case "flag_present":
      inputs = <TextInput id={id("value")} label="Flag" value={draft.text} onChange={(text) => set({ text })} placeholder="e.g. hazmat" hint="Free-form handling flag set on the package by the calculator or an order import." autoCapitalize="none" />;
      break;
    case "rule_applied":
      inputs = <TextInput id={id("value")} label="Rule key" value={draft.text} onChange={(text) => set({ text })} placeholder="e.g. ups.additional_handling" hint="Applies only when this other rule applied to the package, after exclusivity and customer exceptions." autoCapitalize="none" />;
      break;
    case "ship_date_between":
      inputs = (
        <>
          <TextInput id={id("from")} label="From" type="date" value={draft.text} onChange={(text) => set({ text })} />
          <TextInput id={id("to")} label="To" type="date" value={draft.text2} onChange={(text2) => set({ text2 })} min={draft.text || undefined} />
        </>
      );
      break;
    case "package_count_gt":
      inputs = <TextInput id={id("value")} label="Packages" value={draft.text} onChange={(text) => set({ text })} inputMode="numeric" placeholder="e.g. 1" hint="Holds when the shipment has more packages than this." />;
      break;
    case "signature_in":
      inputs = (
        <fieldset className="sm:col-span-2">
          <legend className="text-sm font-medium">Signature options</legend>
          <div className="grid sm:grid-cols-2">
            {SIGNATURE_OPTIONS.map((s) => (
              <CheckBox key={s} id={id(`sig-${s}`)} label={SIGNATURE_LABELS[s]} checked={draft.signatures.includes(s)} onChange={(on) => set({ signatures: toggle(draft.signatures, s, on) })} />
            ))}
          </div>
        </fieldset>
      );
      break;
    case "package_type_in":
      inputs = (
        <fieldset className="sm:col-span-2">
          <legend className="text-sm font-medium">Package types</legend>
          <div className="grid sm:grid-cols-2">
            {PACKAGE_TYPE_OPTIONS.map((t) => (
              <CheckBox key={t} id={id(`pt-${t}`)} label={PACKAGE_TYPE_LABELS[t]} checked={draft.packageTypes.includes(t)} onChange={(on) => set({ packageTypes: toggle(draft.packageTypes, t, on) })} />
            ))}
          </div>
        </fieldset>
      );
      break;
    case "any_of":
      inputs = (
        <div className="sm:col-span-2">
          <ConditionList
            drafts={draft.children}
            idPrefix={id("inner")}
            nested
            zipListId={zipListId}
            onChangeRow={(index, child) => set({ children: draft.children.map((c, i) => (i === index ? child : c)) })}
            onRemoveRow={(index) => set({ children: draft.children.filter((_, i) => i !== index) })}
            onAdd={onAddChild ?? (() => undefined)}
          />
        </div>
      );
      break;
  }

  return (
    <li className="space-y-3 rounded-control border border-line bg-surface p-3 sm:p-4">
      <SelectInput<ConditionType> id={id("type")} label={nested ? "Inner condition" : "Condition"} value={draft.type} onChange={(type) => set({ type })} options={types.map((t) => ({ value: t.type, label: t.label }))} />
      {inputs ? <div className="grid gap-3 sm:grid-cols-2">{inputs}</div> : null}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted">
          {describeCondition(toCondition(draft))}
          {problem ? <span className="block font-medium text-warning">{problem}</span> : null}
        </p>
        <Button variant="ghost" onClick={onRemove} className="self-start sm:self-auto" aria-label={`Remove ${nested ? "inner condition" : "condition"} ${index + 1}`}>
          Remove
        </Button>
      </div>
    </li>
  );
}

const MAX_CONDITIONS = 10;

function ConditionList({
  drafts,
  idPrefix,
  nested,
  zipListId,
  onChangeRow,
  onRemoveRow,
  onAdd,
  onAddChild,
}: {
  drafts: ConditionDraft[];
  idPrefix: string;
  nested: boolean;
  zipListId: string;
  onChangeRow: (index: number, draft: ConditionDraft) => void;
  onRemoveRow: (index: number) => void;
  onAdd: () => void;
  onAddChild?: (index: number) => void;
}) {
  return (
    <div className={nested ? "space-y-3 rounded-control border border-line-strong border-dashed p-3" : "space-y-3"}>
      {nested ? <p className="text-sm text-muted">Holds when any one of these inner conditions holds.</p> : null}
      {drafts.length ? (
        <ul className="space-y-3">
          {drafts.map((d, i) => (
            <ConditionRow key={d.id} draft={d} index={i} idPrefix={`${idPrefix}-${i}`} nested={nested} zipListId={zipListId} onChange={(next) => onChangeRow(i, next)} onRemove={() => onRemoveRow(i)} onAddChild={onAddChild ? () => onAddChild(i) : undefined} />
          ))}
        </ul>
      ) : null}
      <Button variant="secondary" onClick={onAdd} disabled={drafts.length >= MAX_CONDITIONS}>
        {nested ? "Add inner condition" : "Add condition"}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rule form
// ---------------------------------------------------------------------------

export interface CarrierOption {
  code: string;
  name: string;
}
export interface BrandOption {
  id: string;
  name: string;
}
export interface KnownGroup {
  group: string;
  description: string;
}

/** Values a new version starts from (the rule's latest version), all plain and serialisable. */
export interface RuleFormInitial {
  name: string;
  carrierCode: string;
  category: SurchargeCategory;
  chargeClass: ChargeClass;
  method: CalculationMethod;
  amount: string | null;
  percent: string | null;
  perUnitSize: string | null;
  perUnitFreeAllowance: string | null;
  perUnitMinimumCharge: string | null;
  billableWeightFloorLb: string | null;
  base: CalculationBase;
  conditions: RuleCondition[];
  appliesToServiceIds: string[];
  exclusivityGroup: string | null;
  exclusivityPriority: number;
  excludesRuleKeys: string[];
  perPackage: boolean;
  effectiveDate: string;
  expirationDate: string | null;
  sourceReference: string;
  sourceUrl: string | null;
}

export interface RuleFormProps {
  mode: "create" | "version";
  /** Required in version mode. */
  ruleId?: string;
  catalog: ServiceCatalogEntry[];
  carriers: CarrierOption[];
  /** Create mode only: the tenant's active customers for "applies to one customer only". */
  brands?: BrandOption[];
  /** Known mutually exclusive groups per carrier code, offered as suggestions. */
  knownGroups: Record<string, KnownGroup[]>;
  /** Keys of ZIP lists visible to the tenant, offered as suggestions in conditions. */
  zipListKeys?: string[];
  initial?: RuleFormInitial;
  /** Today's date (UTC, YYYY-MM-DD) from the server, so the default effective date renders identically on both sides. */
  today: string;
  /** Version mode: the version the initial values come from, for the explanatory note. */
  basedOnVersion?: { number: number; status: string };
}

interface Values {
  name: string;
  carrierCode: string;
  category: SurchargeCategory;
  chargeClass: ChargeClass;
  method: CalculationMethod;
  amount: string;
  percent: string;
  perUnitSize: string;
  perUnitFreeAllowance: string;
  perUnitMinimumCharge: string;
  billableWeightFloorLb: string;
  brandId: string;
  baseKind: CalculationBase["kind"];
  baseCategories: SurchargeCategory[];
  appliesToServiceIds: string[];
  exclusivityGroup: string;
  exclusivityPriority: string;
  excludesRuleKeys: string;
  perPackage: boolean;
  effectiveDate: string;
  expirationDate: string;
  sourceReference: string;
  sourceUrl: string;
}

function initialValues(initial: RuleFormInitial | undefined, carriers: CarrierOption[], today: string): Values {
  if (!initial) {
    return {
      name: "",
      carrierCode: carriers[0]?.code ?? "",
      category: "residential",
      chargeClass: "definite",
      method: "flat",
      amount: "",
      percent: "",
      perUnitSize: "",
      perUnitFreeAllowance: "",
      perUnitMinimumCharge: "",
      billableWeightFloorLb: "",
      brandId: "",
      baseKind: "base_rate",
      baseCategories: [],
      appliesToServiceIds: [],
      exclusivityGroup: "",
      exclusivityPriority: "0",
      excludesRuleKeys: "",
      perPackage: true,
      effectiveDate: today,
      expirationDate: "",
      sourceReference: "",
      sourceUrl: "",
    };
  }
  return {
    name: initial.name,
    carrierCode: initial.carrierCode,
    category: initial.category,
    // An earlier version of a reweigh, remeasure or correction rule may carry another class; a new version is always conditional.
    chargeClass: isAdjustmentFeeCategory(initial.category) ? "conditional" : initial.chargeClass,
    method: initial.method,
    amount: tidy(initial.amount),
    percent: tidy(initial.percent),
    perUnitSize: tidy(initial.perUnitSize),
    perUnitFreeAllowance: tidy(initial.perUnitFreeAllowance),
    perUnitMinimumCharge: tidy(initial.perUnitMinimumCharge),
    billableWeightFloorLb: tidy(initial.billableWeightFloorLb),
    brandId: "",
    baseKind: initial.base.kind,
    baseCategories: initial.base.kind === "base_plus_categories" ? initial.base.categories : [],
    appliesToServiceIds: initial.appliesToServiceIds,
    exclusivityGroup: initial.exclusivityGroup ?? "",
    exclusivityPriority: String(initial.exclusivityPriority),
    excludesRuleKeys: initial.excludesRuleKeys.join(", "),
    perPackage: initial.perPackage,
    effectiveDate: initial.effectiveDate,
    expirationDate: initial.expirationDate ?? "",
    sourceReference: initial.sourceReference,
    sourceUrl: initial.sourceUrl ?? "",
  };
}

/** Mirrors the server's key derivation so the administrator sees the key before creating the rule. */
function previewKey(carrierCode: string, name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50) || "rule";
  return `${carrierCode}.${/^[a-z]/.test(slug) ? slug : `r_${slug}`}`;
}

function buildBase(v: Values): CalculationBase {
  if (v.method !== "percent" || v.baseKind === "base_rate") return { kind: "base_rate" };
  if (v.baseKind === "base_plus_all_surcharges") return { kind: "base_plus_all_surcharges" };
  return { kind: "base_plus_categories", categories: v.baseCategories };
}

export function RuleForm({ mode, ruleId, catalog, carriers, brands = [], knownGroups, zipListKeys = [], initial, today, basedOnVersion }: RuleFormProps) {
  const uid = useId();
  const [v, setV] = useState<Values>(() => initialValues(initial, carriers, today));
  const [cond, setCond] = useState<{ drafts: ConditionDraft[]; nextId: number }>(() => {
    let n = 0;
    const drafts = (initial?.conditions ?? []).map((c) => fromCondition(c, () => ++n));
    return { drafts, nextId: n + 1 };
  });
  const set = <K extends keyof Values>(key: K, value: Values[K]) => setV((prev) => ({ ...prev, [key]: value }));

  const services = catalog.filter((s) => s.carrierCode === v.carrierCode);
  const groups = knownGroups[v.carrierCode] ?? [];
  const carrierName = carriers.find((c) => c.code === v.carrierCode)?.name ?? v.carrierCode;
  const base = buildBase(v);
  const conditions = cond.drafts.map(toCondition);
  const zipListId = `${uid}-ziplists`;
  const groupsListId = `${uid}-groups`;
  const id = (name: string) => `${uid}-${name}`;

  const changeCarrier = (code: string) => setV((prev) => ({ ...prev, carrierCode: code, appliesToServiceIds: [] }));
  const changeCategory = (category: SurchargeCategory) => setV((prev) => ({ ...prev, category, chargeClass: isAdjustmentFeeCategory(category) ? "conditional" : prev.chargeClass }));
  const adjustmentFee = isAdjustmentFeeCategory(v.category);
  const addTop = () => setCond((s) => ({ drafts: [...s.drafts, emptyDraft(s.nextId)], nextId: s.nextId + 1 }));
  const addChild = (index: number) =>
    setCond((s) => ({ drafts: s.drafts.map((d, i) => (i === index ? { ...d, children: [...d.children, emptyDraft(s.nextId)] } : d)), nextId: s.nextId + 1 }));
  const changeRow = (index: number, draft: ConditionDraft) => setCond((s) => ({ ...s, drafts: s.drafts.map((d, i) => (i === index ? draft : d)) }));
  const removeRow = (index: number) => setCond((s) => ({ ...s, drafts: s.drafts.filter((_, i) => i !== index) }));

  const create = mode === "create";
  const legend = "text-base font-semibold";

  return (
    <ActionForm action={create ? createSurchargeRule : addSurchargeRuleVersion} className="space-y-8">
      {!create && ruleId ? <input type="hidden" name="ruleId" value={ruleId} /> : null}
      {!create ? <input type="hidden" name="carrierCode" value={v.carrierCode} /> : null}
      <input type="hidden" name="base" value={JSON.stringify(base)} />
      <input type="hidden" name="conditions" value={JSON.stringify(conditions)} />
      <input type="hidden" name="perPackage" value={v.perPackage ? "on" : "off"} />
      <datalist id={groupsListId}>
        {groups.map((g) => (
          <option key={g.group} value={g.group} label={g.description} />
        ))}
      </datalist>
      <datalist id={zipListId}>
        {zipListKeys.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>

      {!create && basedOnVersion ? (
        <Alert>
          Starts from version {basedOnVersion.number} ({basedOnVersion.status}). Published versions never change: this saves a new draft that you publish separately, for dates no published version covers.
        </Alert>
      ) : null}

      <fieldset className="space-y-4">
        <legend className={legend}>Rule</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput id={id("name")} name="name" label="Name" value={v.name} onChange={(name) => set("name", name)} required placeholder="e.g. Residential surcharge" hint={create ? <>Key: <span className="tabular">{previewKey(v.carrierCode, v.name)}</span>. Keys are permanent and referenced by other rules and service terms. {RULE_KEY_HINT}</> : "Renames the rule for every version. The key it was created with does not change."} />
          <SelectInput id={id("carrierCode")} name="carrierCode" label="Carrier" value={v.carrierCode} onChange={changeCarrier} options={carriers.map((c) => ({ value: c.code, label: c.name }))} disabled={!create} hint={create ? undefined : "The carrier is fixed once a rule exists."} />
          <SelectInput<SurchargeCategory> id={id("category")} name="category" label="Category" value={v.category} onChange={changeCategory} options={CATEGORY_OPTIONS} disabled={!create} hint={create ? "Decides the evaluation order and what a fuel percentage can be applied to." : "The category is fixed once a rule exists."} />
          <SelectInput<ChargeClass> id={id("chargeClass")} name="chargeClass" label="Charge class" value={v.chargeClass} onChange={(chargeClass) => set("chargeClass", chargeClass)} options={adjustmentFee ? ADJUSTMENT_FEE_CLASS_OPTIONS : CHARGE_CLASS_OPTIONS} hint={adjustmentFee ? ADJUSTMENT_FEE_CLASS_HINT : CHARGE_CLASS_HINTS[v.chargeClass]} />
          {create ? (
            <SelectInput id={id("brandId")} name="brandId" label="Applies to one customer only" value={v.brandId} onChange={(brandId) => set("brandId", brandId)} options={[{ value: "", label: "Every customer" }, ...brands.map((b) => ({ value: b.id, label: b.name }))]} hint="Choose a customer only for a bespoke accessorial that exists in their agreement alone." />
          ) : null}
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className={legend}>Amount</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectInput<CalculationMethod> id={id("method")} name="method" label="How it is calculated" value={v.method} onChange={(method) => set("method", method)} options={METHOD_OPTIONS} />
          {v.method === "flat" ? <TextInput id={id("amount")} name="amount" label="Amount (USD)" value={v.amount} onChange={(amount) => set("amount", amount)} inputMode="decimal" placeholder="e.g. 5.95" required /> : null}
          {v.method === "percent" ? <TextInput id={id("percent")} name="percent" label="Percentage" value={v.percent} onChange={(percent) => set("percent", percent)} inputMode="decimal" placeholder="e.g. 16.5" hint="Enter 16.5 for 16.5%." required /> : null}
          {v.method === "per_unit" ? (
            <>
              <TextInput id={id("amount")} name="amount" label="Amount per unit (USD)" value={v.amount} onChange={(amount) => set("amount", amount)} inputMode="decimal" placeholder="e.g. 1.25" required />
              <TextInput id={id("perUnitSize")} name="perUnitSize" label="Unit size (USD of declared value)" value={v.perUnitSize} onChange={(perUnitSize) => set("perUnitSize", perUnitSize)} inputMode="decimal" placeholder="e.g. 100" hint="The amount is charged for each started unit of declared value." required />
              <TextInput id={id("perUnitFreeAllowance")} name="perUnitFreeAllowance" label="Free allowance (USD)" value={v.perUnitFreeAllowance} onChange={(x) => set("perUnitFreeAllowance", x)} inputMode="decimal" placeholder="0" hint="Declared value up to this amount is not charged." />
              <TextInput id={id("perUnitMinimumCharge")} name="perUnitMinimumCharge" label="Minimum charge (USD)" value={v.perUnitMinimumCharge} onChange={(x) => set("perUnitMinimumCharge", x)} inputMode="decimal" placeholder="None" />
            </>
          ) : null}
        </div>

        {v.method === "percent" ? (
          <div className="space-y-3 rounded-control border border-line p-4">
            <SelectInput<CalculationBase["kind"]>
              id={id("baseKind")}
              errorKey="base"
              label="Applied to"
              value={v.baseKind}
              onChange={(baseKind) => set("baseKind", baseKind)}
              options={[
                { value: "base_rate", label: "The base rate only" },
                { value: "base_plus_all_surcharges", label: "The base rate plus every other surcharge" },
                { value: "base_plus_categories", label: "The base rate plus selected surcharge categories" },
              ]}
              hint="Carriers typically apply fuel to the base rate plus most accessorials; your customer agreement decides."
            />
            {v.baseKind === "base_plus_categories" ? (
              <fieldset>
                <legend className="text-sm font-medium">Surcharge categories included in the base</legend>
                <div className="grid sm:grid-cols-2 lg:grid-cols-3">
                  {CATEGORY_OPTIONS.filter((c) => c.value !== "fuel").map((c) => (
                    <CheckBox key={c.value} id={id(`base-${c.value}`)} label={c.label} checked={v.baseCategories.includes(c.value)} onChange={(on) => set("baseCategories", toggle(v.baseCategories, c.value, on))} />
                  ))}
                </div>
                {!v.baseCategories.length ? <p className="text-sm font-medium text-warning">Pick at least one category.</p> : null}
              </fieldset>
            ) : null}
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <CheckBox id={id("perPackage")} label="Charge once per package" checked={v.perPackage} onChange={(perPackage) => set("perPackage", perPackage)} hint="Unchecked: evaluated and charged once per shipment." />
          <TextInput id={id("billableWeightFloorLb")} name="billableWeightFloorLb" label="Billable weight floor (lb)" value={v.billableWeightFloorLb} onChange={(x) => set("billableWeightFloorLb", x)} inputMode="decimal" placeholder="None" hint="When this rule applies, bill the package at no less than this weight (lb), e.g. large-package minimums." />
        </div>
      </fieldset>

      <ErrorFieldset name="conditions" id={id("conditions")} className="space-y-3">
        <legend className={legend}>When it applies</legend>
        <p className="text-sm text-muted">Every condition must hold. With no conditions the rule applies to every shipment on the services below.</p>
        <ConditionList drafts={cond.drafts} idPrefix={id("cond")} nested={false} zipListId={zipListId} onChangeRow={changeRow} onRemoveRow={removeRow} onAdd={addTop} onAddChild={addChild} />
      </ErrorFieldset>

      <ErrorFieldset name="appliesToServiceIds" id={id("appliesToServiceIds")} className="space-y-3">
        <legend className={legend}>Services</legend>
        <p className="text-sm text-muted">{v.appliesToServiceIds.length ? `Only the ${v.appliesToServiceIds.length} selected ${carrierName} ${v.appliesToServiceIds.length === 1 ? "service" : "services"}.` : `Every ${carrierName} service. Tick services to narrow the rule.`}</p>
        {services.length ? (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3">
            {services.map((s) => (
              <CheckBox key={s.id} id={id(`svc-${s.id}`)} name="appliesToServiceIds" value={s.id} label={s.name} checked={v.appliesToServiceIds.includes(s.id)} onChange={(on) => set("appliesToServiceIds", toggle(v.appliesToServiceIds, s.id, on))} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">No active services are listed for this carrier.</p>
        )}
      </ErrorFieldset>

      <fieldset className="space-y-4">
        <legend className={legend}>Interaction with other rules</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput
            id={id("exclusivityGroup")}
            name="exclusivityGroup"
            label="Exclusivity group (optional)"
            value={v.exclusivityGroup}
            onChange={(x) => set("exclusivityGroup", x)}
            list={groupsListId}
            placeholder="e.g. ups.das"
            autoCapitalize="none"
            hint={
              <>
                Rules in the same group never apply together: the highest priority, then the highest amount, wins.
                {groups.length ? (
                  <ul className="mt-1 list-disc pl-5">
                    {groups.map((g) => (
                      <li key={g.group}>
                        <span className="tabular">{g.group}</span>: {g.description}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            }
          />
          <TextInput id={id("exclusivityPriority")} name="exclusivityPriority" label="Priority within the group" value={v.exclusivityPriority} onChange={(x) => set("exclusivityPriority", x)} type="number" inputMode="numeric" min="0" max="100" hint="0 to 100; higher wins." />
          <TextInput id={id("excludesRuleKeys")} name="excludesRuleKeys" label="Suppresses these rules (optional)" value={v.excludesRuleKeys} onChange={(x) => set("excludesRuleKeys", x)} placeholder="e.g. ups.additional_handling" autoCapitalize="none" hint="Comma-separated rule keys that are not charged when this rule applies (bundled surcharges)." />
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className={legend}>Effective dates</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput id={id("effectiveDate")} name="effectiveDate" label="Effective from" type="date" value={v.effectiveDate} onChange={(x) => set("effectiveDate", x)} required hint={create ? "Calculations dated from this day use the rule once it is published." : "A version can only be published for dates no published version of this rule covers; retire the current one as of the day before."} />
          <TextInput id={id("expirationDate")} name="expirationDate" label="Expires on (optional)" type="date" value={v.expirationDate} onChange={(x) => set("expirationDate", x)} min={v.effectiveDate || undefined} hint="Last day the rule applies. Leave empty for no end date." />
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className={legend}>Source</legend>
        <p className="text-sm text-muted">ParcelClarity never invents an amount. Name the customer agreement, or the carrier bulletin and its date, that states this figure; every version keeps its source and verification status.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput id={id("sourceReference")} name="sourceReference" label="Source reference" value={v.sourceReference} onChange={(x) => set("sourceReference", x)} required placeholder="e.g. Acme master agreement §4.2, 2026-01-15" autoCapitalize="sentences" />
          <TextInput id={id("sourceUrl")} name="sourceUrl" label="Source link (optional)" type="url" value={v.sourceUrl} onChange={(x) => set("sourceUrl", x)} placeholder="https://" autoCapitalize="none" />
        </div>
      </fieldset>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <SubmitButton pendingLabel="Saving…">{create ? "Create rule" : "Add draft version"}</SubmitButton>
        <p className="text-sm text-muted">{create ? "Saved as a draft. Publish it from the rule page when you have checked it." : "Saved as a draft; published versions are unaffected until you publish this one."}</p>
      </div>
    </ActionForm>
  );
}

// ---------------------------------------------------------------------------
// Retire a published version
// ---------------------------------------------------------------------------

export function RetireVersionForm({ versionId, effectiveDate, today }: { versionId: string; effectiveDate: string; today: string }) {
  const uid = useId();
  const [date, setDate] = useState(today < effectiveDate ? effectiveDate : today);
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="sm:w-60">
        <Field id={`${uid}-last`} label="Last effective day" error={error ?? undefined} hint="Calculations dated up to and including this day keep using this version.">
          {(aria) => <Input {...aria} type="date" value={date} min={effectiveDate} onChange={(e) => setDate(e.target.value)} disabled={pending} />}
        </Field>
      </div>
      {!armed ? (
        <Button variant="secondary" onClick={() => setArmed(true)}>
          Retire this version
        </Button>
      ) : (
        <span className="inline-flex flex-wrap items-center gap-2" role="group" aria-label="Confirm: retire this version">
          <Button
            variant="danger"
            loading={pending}
            onClick={() =>
              start(async () => {
                setError(null);
                const result = await retireRuleVersion(versionId, date);
                if (!result.ok) setError(result.message ?? "Something went wrong.");
                else setArmed(false);
              })
            }
          >
            Retire as of {date ? formatDate(date) : "…"}
          </Button>
          <Button variant="secondary" disabled={pending} onClick={() => { setArmed(false); setError(null); }}>
            Cancel
          </Button>
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ZIP list upload
// ---------------------------------------------------------------------------

function FileInput({ id, name, label, hint, accept }: { id: string; name: string; label: string; hint?: ReactNode; accept: string }) {
  const state = useFormState();
  return (
    <Field id={id} label={label} error={state.errors?.[name]} hint={hint}>
      {(aria) => <Input {...aria} type="file" name={name} accept={accept} required className="cursor-pointer py-2 file:mr-3 file:rounded-control file:border-0 file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-fg" />}
    </Field>
  );
}

export function ZipListUploadForm({ carriers, today }: { carriers: CarrierOption[]; today: string }) {
  const uid = useId();
  const [v, setV] = useState({ key: "", name: "", carrierCode: "", sourceReference: "", effectiveDate: today, expirationDate: "" });
  const set = <K extends keyof typeof v>(key: K, value: (typeof v)[K]) => setV((prev) => ({ ...prev, [key]: value }));
  const id = (name: string) => `${uid}-${name}`;
  return (
    <ActionForm action={uploadZipList} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <TextInput id={id("key")} name="key" label="List key" value={v.key} onChange={(x) => set("key", x)} required placeholder="e.g. ups.das_2026" autoCapitalize="none" hint="Lowercase letters, digits, dots and underscores. Uploading the same key again creates the next version." />
        <TextInput id={id("name")} name="name" label="Name" value={v.name} onChange={(x) => set("name", x)} required placeholder="e.g. UPS Delivery Area Surcharge ZIPs 2026" />
        <SelectInput id={id("carrierCode")} name="carrierCode" label="Carrier (optional)" value={v.carrierCode} onChange={(x) => set("carrierCode", x)} options={[{ value: "", label: "Any carrier" }, ...carriers.map((c) => ({ value: c.code, label: c.name }))]} />
        <TextInput id={id("sourceReference")} name="sourceReference" label="Source reference" value={v.sourceReference} onChange={(x) => set("sourceReference", x)} required placeholder="e.g. UPS DAS ZIP bulletin, 2026-01-01" autoCapitalize="sentences" hint="The carrier bulletin or agreement the list comes from, with its date." />
        <TextInput id={id("effectiveDate")} name="effectiveDate" label="Effective from" type="date" value={v.effectiveDate} onChange={(x) => set("effectiveDate", x)} required />
        <TextInput id={id("expirationDate")} name="expirationDate" label="Expires on (optional)" type="date" value={v.expirationDate} onChange={(x) => set("expirationDate", x)} min={v.effectiveDate || undefined} />
        <div className="sm:col-span-2">
          <FileInput id={id("file")} name="file" label="ZIP codes file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hint="A .csv or .xlsx file up to 5 MB with one 5-digit ZIP code or 3 to 5 digit prefix per row in the first column. Duplicates are removed." />
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <SubmitButton pendingLabel="Uploading…">Upload and publish</SubmitButton>
        <p className="text-sm text-muted">The list is published immediately for its dates and recorded as your approved configuration.</p>
      </div>
    </ActionForm>
  );
}
