"use client";

import type { ReactNode } from "react";
import { updateServiceTerms } from "@/app/actions/rate-cards";
import { ActionForm, SubmitButton, useFormState } from "@/components/forms/action-form";
import { formatUsd } from "@/components/pricing/version-rows-table";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/field";
import type { DimensionRounding, WeightRounding } from "@/engine/types";

/**
 * Per-service terms of a rate-card version (DIM rules, minimum charge, bundled surcharges).
 * Editable while the version is a draft; afterwards the same card shows the locked values.
 *
 * Everything in this file runs on the client because the fields read the ActionForm state
 * (inline errors). Pages pass plain, serialisable records built from the database rows.
 */

export interface ServiceTermsRecord {
  serviceId: string;
  serviceName: string;
  carrierCode: string;
  carrierName: string;
  dimDivisor: string | null;
  dimThresholdCubicIn: string | null;
  dimensionRounding: DimensionRounding;
  weightRounding: WeightRounding;
  minBillableLb: string | null;
  dimExempt: boolean;
  minCharge: string | null;
  includedSurchargeKeys: string[];
  excludedSurchargeKeys: string[];
  /** Which uploaded zone chart this service uses ("default" when the card has one chart per carrier). */
  zoneChartKey: string;
  /** Priced without zones (rows carry zone "ALL"). */
  zoneIndependent: boolean;
  /** "Carrier published + X%": scales every charged surcharge. Customer-visible (it is a term of the customer's rate card). */
  surchargeMarkupPercent: string | null;
}

/** What the import found for the service: used only as context in the card header. */
export interface ServiceCoverage {
  rowCount: number;
  zones: string[];
  originPrefixes: string[];
  maxWeight: { value: string; unit: "lb" | "oz" } | null;
}

const DIMENSION_ROUNDING_LABELS: Record<DimensionRounding, string> = {
  none: "No rounding",
  nearest_whole: "Nearest whole inch",
  up_whole: "Up to the next whole inch",
};
const WEIGHT_ROUNDING_LABELS: Record<WeightRounding, string> = {
  none: "No rounding",
  up_whole_lb: "Up to the next whole pound",
  up_whole_oz: "Up to the next whole ounce",
  postal: "Whole ounces under 1 lb, whole pounds above (postal)",
};
const DIMENSION_ROUNDING_OPTIONS = (Object.keys(DIMENSION_ROUNDING_LABELS) as DimensionRounding[]).map((value) => ({ value, label: DIMENSION_ROUNDING_LABELS[value] }));
const WEIGHT_ROUNDING_OPTIONS = (Object.keys(WEIGHT_ROUNDING_LABELS) as WeightRounding[]).map((value) => ({ value, label: WEIGHT_ROUNDING_LABELS[value] }));

// ---------------------------------------------------------------------------
// Form fields that TextField/SelectField do not cover: date inputs, decimal inputs with a
// mobile keypad, selects with a stored default, checkboxes. Each reads the ActionForm state
// so server-side validation errors appear inline, and takes an explicit id so several forms
// with the same field names can share a page without duplicate ids.
// ---------------------------------------------------------------------------

interface BaseFieldProps {
  name: string;
  label: string;
  hint?: ReactNode;
  /** Defaults to `name`. Pass a unique value when the same field name appears in several forms. */
  id?: string;
}

export function DateField({ name, label, hint, id, defaultValue, required }: BaseFieldProps & { defaultValue?: string; required?: boolean }) {
  const state = useFormState();
  return (
    <Field id={id ?? name} label={label} error={state.errors?.[name]} hint={hint}>
      {(aria) => <Input {...aria} name={name} type="date" required={required} defaultValue={state.values?.[name] ?? defaultValue} />}
    </Field>
  );
}

export function DecimalField({ name, label, hint, id, defaultValue, placeholder }: BaseFieldProps & { defaultValue?: string | null; placeholder?: string }) {
  const state = useFormState();
  return (
    <Field id={id ?? name} label={label} error={state.errors?.[name]} hint={hint}>
      {(aria) => <Input {...aria} name={name} type="text" inputMode="decimal" autoComplete="off" placeholder={placeholder} defaultValue={state.values?.[name] ?? defaultValue ?? ""} />}
    </Field>
  );
}

function PlainTextField({ name, label, hint, id, defaultValue, placeholder }: BaseFieldProps & { defaultValue?: string; placeholder?: string }) {
  const state = useFormState();
  return (
    <Field id={id ?? name} label={label} error={state.errors?.[name]} hint={hint}>
      {(aria) => <Input {...aria} name={name} type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder={placeholder} defaultValue={state.values?.[name] ?? defaultValue ?? ""} />}
    </Field>
  );
}

function ChoiceField<T extends string>({ name, label, hint, id, defaultValue, options }: BaseFieldProps & { defaultValue: T; options: { value: T; label: string }[] }) {
  const state = useFormState();
  return (
    <Field id={id ?? name} label={label} error={state.errors?.[name]} hint={hint}>
      {(aria) => (
        <Select {...aria} name={name} defaultValue={state.values?.[name] ?? defaultValue}>
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

function CheckboxField({ name, label, hint, id, defaultChecked }: BaseFieldProps & { defaultChecked: boolean }) {
  const state = useFormState();
  const controlId = id ?? name;
  const error = state.errors?.[name];
  const describedBy = [hint ? `${controlId}-hint` : null, error ? `${controlId}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={controlId} className="flex min-h-11 items-center gap-3 text-sm font-medium">
        <input id={controlId} name={name} type="checkbox" defaultChecked={defaultChecked} aria-invalid={error ? true : undefined} aria-describedby={describedBy} className="size-5 shrink-0 accent-accent" />
        {label}
      </label>
      {hint ? (
        <p id={`${controlId}-hint`} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${controlId}-error`} role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Service terms card
// ---------------------------------------------------------------------------

export interface ServiceTermsFormProps {
  versionId: string;
  terms: ServiceTermsRecord;
  coverage?: ServiceCoverage | null;
  /** True only for drafts viewed by someone with ratecard.manage. */
  editable: boolean;
  /** The carrier profile's notes on its structural defaults (verify-against-service-guide wording). */
  carrierNotes: string[];
  /** Surcharge rule keys known for this carrier, offered as a hint for the included/waived fields. */
  knownRuleKeys: string[];
}

export function ServiceTermsForm({ versionId, terms, coverage, editable, carrierNotes, knownRuleKeys }: ServiceTermsFormProps) {
  const p = `terms-${terms.serviceId}`;
  const context = [
    terms.carrierName,
    coverage ? `${coverage.rowCount.toLocaleString("en-US")} rows` : null,
    coverage?.zones.length ? `zones ${coverage.zones.join(", ")}` : null,
    coverage?.maxWeight ? `up to ${coverage.maxWeight.value} ${coverage.maxWeight.unit}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const keysHint = knownRuleKeys.length
    ? `Comma-separated rule keys. Known ${terms.carrierName} keys: ${knownRuleKeys.slice(0, 8).join(", ")}${knownRuleKeys.length > 8 ? ", …" : ""}.`
    : "Comma-separated rule keys, for example ups.residential.";

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>{terms.serviceName}</CardTitle>
          <CardDescription>{context}</CardDescription>
        </div>
        {terms.dimDivisor === null ? <Badge tone="warning">No DIM divisor</Badge> : <Badge tone="accent">DIM divisor {terms.dimDivisor}</Badge>}
      </div>

      {terms.dimDivisor === null && !terms.dimExempt ? (
        <Alert tone="warning" className="mt-4">
          Without a DIM divisor the calculator prices this service on actual weight and marks every result as an estimate.
          {editable ? " Enter the divisor from the customer agreement below." : ""}
        </Alert>
      ) : null}

      {editable ? (
        <ActionForm action={updateServiceTerms} className="mt-5 space-y-6">
          <input type="hidden" name="versionId" value={versionId} />
          <input type="hidden" name="serviceId" value={terms.serviceId} />

          <fieldset className="space-y-4">
            <legend className="text-sm font-semibold">Dimensional and billable weight</legend>
            <div className="rounded-control bg-surface px-4 py-3 text-sm text-muted">
              <p>
                Rounding, threshold and minimum-weight values were pre-filled from {terms.carrierName}&apos;s structural defaults. They are starting points, not verified
                carrier terms: check them against the carrier&apos;s current service guide and your customer agreement before activating.
              </p>
              {carrierNotes.map((note) => (
                <p key={note} className="mt-1">
                  {note}
                </p>
              ))}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <DecimalField id={`${p}-dimDivisor`} name="dimDivisor" label="DIM divisor" defaultValue={terms.dimDivisor} placeholder="e.g. 139" hint="From the customer agreement. Leave empty if the rate card does not state one." />
              <DecimalField id={`${p}-dimThresholdCubicIn`} name="dimThresholdCubicIn" label="DIM threshold (cubic inches)" defaultValue={terms.dimThresholdCubicIn} placeholder="Always" hint="Dimensional weight applies only above this volume. Empty means it always applies." />
              <ChoiceField id={`${p}-dimensionRounding`} name="dimensionRounding" label="Dimension rounding" defaultValue={terms.dimensionRounding} options={DIMENSION_ROUNDING_OPTIONS} />
              <ChoiceField id={`${p}-weightRounding`} name="weightRounding" label="Billable weight rounding" defaultValue={terms.weightRounding} options={WEIGHT_ROUNDING_OPTIONS} />
              <DecimalField id={`${p}-minBillableLb`} name="minBillableLb" label="Minimum billable weight (lb)" defaultValue={terms.minBillableLb} placeholder="None" hint="Billable weight never drops below this. Empty means no floor." />
              <CheckboxField id={`${p}-dimExempt`} name="dimExempt" label="Exempt from dimensional weight" defaultChecked={terms.dimExempt} hint="For carrier flat-rate packaging and similar services." />
            </div>
          </fieldset>

          <fieldset className="space-y-4">
            <legend className="text-sm font-semibold">Minimum charge and bundled surcharges</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <DecimalField id={`${p}-minCharge`} name="minCharge" label="Minimum charge (USD)" defaultValue={terms.minCharge} placeholder="None" hint="Lowest base charge for this service regardless of bracket." />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <PlainTextField id={`${p}-includedSurchargeKeys`} name="includedSurchargeKeys" label="Included surcharges" defaultValue={terms.includedSurchargeKeys.join(", ")} placeholder="None" hint={`Bundled into the base price: listed on quotes but not charged. ${keysHint}`} />
              <PlainTextField id={`${p}-excludedSurchargeKeys`} name="excludedSurchargeKeys" label="Waived surcharges" defaultValue={terms.excludedSurchargeKeys.join(", ")} placeholder="None" hint="Never listed or charged for this service under the customer agreement." />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <DecimalField id={`${p}-surchargeMarkupPercent`} name="surchargeMarkupPercent" label="Surcharge markup (%)" defaultValue={terms.surchargeMarkupPercent} placeholder="None" hint="“Carrier published + X%” from the customer agreement; scales every charged surcharge. Customers see this percentage in their quote explanations." />
            </div>
          </fieldset>

          <fieldset className="space-y-4">
            <legend className="text-sm font-semibold">Zones</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <PlainTextField id={`${p}-zoneChartKey`} name="zoneChartKey" label="Zone chart key" defaultValue={terms.zoneChartKey} placeholder="default" hint="Matches the chart_key column of the uploaded zone chart. Leave as “default” unless the carrier has a service-specific chart." />
              <CheckboxField id={`${p}-zoneIndependent`} name="zoneIndependent" label="Priced without zones" defaultChecked={terms.zoneIndependent} hint="For services whose rate rows carry zone ALL; no zone chart is consulted." />
            </div>
          </fieldset>

          <SubmitButton pendingLabel="Saving…">Save terms</SubmitButton>
        </ActionForm>
      ) : (
        <TermsSummary terms={terms} />
      )}
    </Card>
  );
}

function TermsSummary({ terms }: { terms: ServiceTermsRecord }) {
  const items: [string, string][] = [
    ["DIM divisor", terms.dimDivisor ?? "Not stated"],
    ["DIM threshold", terms.dimThresholdCubicIn ? `${terms.dimThresholdCubicIn} cu in` : "Always applies"],
    ["Dimension rounding", DIMENSION_ROUNDING_LABELS[terms.dimensionRounding]],
    ["Billable weight rounding", WEIGHT_ROUNDING_LABELS[terms.weightRounding]],
    ["Minimum billable weight", terms.minBillableLb ? `${terms.minBillableLb} lb` : "None"],
    ["Exempt from DIM", terms.dimExempt ? "Yes" : "No"],
    ["Minimum charge", terms.minCharge ? formatUsd(terms.minCharge) : "None"],
    ["Included surcharges", terms.includedSurchargeKeys.join(", ") || "None"],
    ["Waived surcharges", terms.excludedSurchargeKeys.join(", ") || "None"],
    ["Surcharge markup", terms.surchargeMarkupPercent ? `${terms.surchargeMarkupPercent}%` : "None"],
    ["Zone chart", terms.zoneIndependent ? "Not used (priced without zones)" : terms.zoneChartKey],
  ];
  return (
    <dl className="mt-5 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
      {items.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-muted">{label}</dt>
          <dd className="tabular font-medium break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
