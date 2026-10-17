"use client";

import { useId } from "react";
import { Badge } from "@/components/ui/badge";
import { Field, Select } from "@/components/ui/field";
import type { AdjustmentCause, AdjustmentDetection, AdjustmentMapping, DuplicateHandling, MoneyField } from "@/lib/adjustments/types";
import { CAUSE_LABELS, CAUSE_OPTIONS, DUPLICATE_LEGEND, DUPLICATE_OPTIONS, DUPLICATE_RULE_NOTE, MONEY_FIELD_HINT, MONEY_FIELD_LABELS, formatCount } from "@/lib/adjustments/staff-copy";
import {
  FIELD_GROUPS,
  TYPE_OPTIONS,
  amountChoiceFor,
  carrierOptions,
  chooseAmountColumn,
  sampleValue,
  serviceLabel,
  setColumn,
  setMapEntry,
  valueRows,
  type CatalogService,
  type ValueMapName,
} from "./import-model";

/**
 * The controls of "How we read your file". Controlled: the wizard owns the mapping and passes `onChange`. Everything here is for the
 * 3PL's team. Money columns carry the rule about what an amount must be as the first line under each field; amount columns that passed the
 * guard but do not say which amount they are are listed for a choice; every other amount-like column is listed under "Columns we will
 * ignore". Nothing is guessed silently: a date format the file cannot settle, and a weight unit it does not state, must be chosen.
 */
export interface MappingEditorProps {
  mapping: AdjustmentMapping;
  onChange: (next: AdjustmentMapping) => void;
  detection: AdjustmentDetection;
  headers: string[];
  /** Sample rows of the MAPPED columns only (the import keeps nothing from a column that is ignored), keyed by header. */
  sampleRows?: Record<string, string>[];
  brands: { id: string; name: string }[];
  catalog: CatalogService[];
  /** The date format is ambiguous and not chosen yet. */
  dateUnchosen: boolean;
  unitUnchosen: boolean;
  onChooseDate: () => void;
  onChooseUnit: () => void;
  disabled?: boolean;
}

const MAX_ROWS_PER_MAP = 100;

export function MappingEditor(p: MappingEditorProps) {
  const id = useId();
  const { mapping, onChange, detection, headers } = p;
  const columnOptions = headers.map((h, i) => ({ value: String(i), label: h || `Column ${i + 1}` }));
  const needingIndexes = new Set(detection.amountColumnsNeedingChoice.map((c) => c.index));

  return (
    <div className="space-y-8">
      {detection.notes.length ? (
        <ul className="space-y-1 text-sm text-muted">
          {detection.notes.map((n) => (
            <li key={n} className="[overflow-wrap:anywhere]">
              {n}
            </li>
          ))}
        </ul>
      ) : null}

      {FIELD_GROUPS.map((g) => (
        <fieldset key={g.id} className="space-y-3" disabled={p.disabled}>
          <legend className="text-sm font-semibold">{g.legend}</legend>
          {g.description ? <p className="text-sm text-muted">{g.description}</p> : null}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {g.fields.map((f) => {
              const index = mapping.columns[f.field];
              const sample = sampleValue(p.sampleRows, index === null ? undefined : headers[index]);
              return (
                <Field
                  key={f.field}
                  id={`${id}-${f.field}`}
                  label={f.label}
                  hint={
                    f.hint || sample ? (
                      <>
                        {f.hint ? <span className="block">{f.hint}</span> : null}
                        {sample ? <span className="block [overflow-wrap:anywhere]">{`e.g. "${sample}"`}</span> : null}
                      </>
                    ) : undefined
                  }
                >
                  {(aria) => (
                    <Select {...aria} value={index === null ? "" : String(index)} onChange={(e) => onChange(setColumn(mapping, f.field, e.target.value === "" ? null : Number(e.target.value)))}>
                      <option value="">Not in the file</option>
                      {columnOptions.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              );
            })}
          </div>
        </fieldset>
      ))}

      {detection.amountColumnsNeedingChoice.length ? (
        <fieldset className="space-y-3" disabled={p.disabled}>
          <legend className="text-sm font-semibold">Amount columns that need your choice</legend>
          <p className="text-sm text-muted">These columns look like what your customer was charged, but they do not say which amount they are. {MONEY_FIELD_HINT}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            {detection.amountColumnsNeedingChoice.map((c) => (
              <Field key={c.index} id={`${id}-amount-${c.index}`} label={`What does “${c.header}” hold?`}>
                {(aria) => (
                  <Select {...aria} value={amountChoiceFor(mapping, c.index)} onChange={(e) => onChange(chooseAmountColumn(mapping, c.index, (e.target.value || null) as MoneyField | null))}>
                    <option value="">Leave it out</option>
                    {(["originalCharge", "correctedCharge", "adjustmentFee"] as const).map((f) => (
                      <option key={f} value={f}>
                        {MONEY_FIELD_LABELS[f]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ))}
          </div>
        </fieldset>
      ) : null}

      <section aria-labelledby={`${id}-ignored`} className="space-y-2">
        <h3 id={`${id}-ignored`} className="text-sm font-semibold">
          Columns we will ignore
        </h3>
        {detection.ignoredColumns.filter((c) => !needingIndexes.has(c.index) && !Object.values(mapping.columns).includes(c.index)).length ? (
          <>
            <p className="text-sm text-muted">These columns are not read. An amount-like column is left out unless it says it holds what your customer was charged. Map one above only if you know it does.</p>
            <ul className="flex flex-wrap gap-2 text-sm">
              {detection.ignoredColumns
                .filter((c) => !needingIndexes.has(c.index) && !Object.values(mapping.columns).includes(c.index))
                .map((c) => (
                  <li key={c.index} className="inline-flex items-center gap-1.5 rounded-control bg-surface px-2.5 py-1 [overflow-wrap:anywhere]">
                    {c.header || `Column ${c.index + 1}`}
                    {c.moneyLike ? <Badge tone="warning">Looks like an amount</Badge> : null}
                  </li>
                ))}
            </ul>
          </>
        ) : (
          <p className="text-sm text-muted">Every column is read.</p>
        )}
      </section>

      <fieldset className="space-y-3" disabled={p.disabled}>
        <legend className="text-sm font-semibold">Formats</legend>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            id={`${id}-date`}
            label="Dates"
            hint={detection.dateFormatAmbiguous ? "The dates could be month-first or day-first; the file cannot tell. Please choose." : undefined}
            error={p.dateUnchosen ? "Please choose how to read the dates." : undefined}
          >
            {(aria) => (
              <Select
                {...aria}
                value={p.dateUnchosen ? "" : mapping.dateFormat}
                onChange={(e) => {
                  if (!e.target.value) return;
                  p.onChooseDate();
                  onChange({ ...mapping, dateFormat: e.target.value as AdjustmentMapping["dateFormat"] });
                }}
              >
                {p.dateUnchosen ? <option value="">Choose…</option> : null}
                <option value="iso">Year-month-day (2026-03-04)</option>
                <option value="mdy">Month/day/year (3/4/2026)</option>
                <option value="dmy">Day/month/year (4/3/2026)</option>
              </Select>
            )}
          </Field>
          <Field
            id={`${id}-wunit`}
            label="Weight unit when the file does not say"
            hint={detection.weightUnitMustBeChosen ? "Neither the header nor the cells name a unit. Please choose." : "Pounds unless the header or cells say otherwise."}
            error={p.unitUnchosen ? "Please choose the unit the weights are in." : undefined}
          >
            {(aria) => (
              <Select
                {...aria}
                value={p.unitUnchosen ? "" : mapping.weightUnit}
                onChange={(e) => {
                  if (!e.target.value) return;
                  p.onChooseUnit();
                  onChange({ ...mapping, weightUnit: e.target.value as AdjustmentMapping["weightUnit"] });
                }}
              >
                {p.unitUnchosen ? <option value="">Choose…</option> : null}
                <option value="lb">Pounds (lb)</option>
                <option value="oz">Ounces (oz)</option>
                <option value="g">Grams (converted to lb)</option>
                <option value="kg">Kilograms (converted to lb)</option>
              </Select>
            )}
          </Field>
          <Field id={`${id}-dunit`} label="Size unit when the file does not say">
            {(aria) => (
              <Select {...aria} value={mapping.dimensionUnit} onChange={(e) => onChange({ ...mapping, dimensionUnit: e.target.value as AdjustmentMapping["dimensionUnit"] })}>
                <option value="in">Inches (in)</option>
                <option value="cm">Centimeters (converted to in)</option>
              </Select>
            )}
          </Field>
        </div>
      </fieldset>

      <fieldset className="space-y-3" disabled={p.disabled}>
        <legend className="text-sm font-semibold">When the file does not say</legend>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field id={`${id}-dtype`} label="Adjustment type for every row" hint={mapping.columns.adjustmentType === null ? "The file has no type column, so choose one type for the whole file." : "Used for rows with no type."}>
            {(aria) => (
              <Select {...aria} value={mapping.defaults.adjustmentType ?? ""} onChange={(e) => onChange({ ...mapping, defaults: { ...mapping.defaults, adjustmentType: (e.target.value || null) as AdjustmentMapping["defaults"]["adjustmentType"] } })}>
                <option value="">{mapping.columns.adjustmentType === null ? "Choose…" : "None"}</option>
                {TYPE_OPTIONS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field id={`${id}-dcause`} label="Cause" hint="Used for rows with no cause, or one that is not matched.">
            {(aria) => (
              <Select {...aria} value={mapping.defaults.cause} onChange={(e) => onChange({ ...mapping, defaults: { ...mapping.defaults, cause: e.target.value as AdjustmentCause } })}>
                {CAUSE_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {CAUSE_LABELS[c]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field id={`${id}-dbrand`} label="Customer for rows with no customer">
            {(aria) => (
              <Select {...aria} value={mapping.defaults.brandId ?? ""} onChange={(e) => onChange({ ...mapping, defaults: { ...mapping.defaults, brandId: e.target.value || null } })}>
                <option value="">Leave unassigned</option>
                {p.brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </fieldset>

      <ValueMaps idPrefix={id} mapping={mapping} onChange={onChange} detection={detection} brands={p.brands} catalog={p.catalog} disabled={p.disabled} />

      <DuplicateChoice value={mapping.duplicateHandling} onChange={(v) => onChange({ ...mapping, duplicateHandling: v })} disabled={p.disabled} />
    </div>
  );
}

function ValueMaps({ idPrefix, mapping, onChange, detection, brands, catalog, disabled }: { idPrefix: string; mapping: AdjustmentMapping; onChange: (m: AdjustmentMapping) => void; detection: AdjustmentDetection; brands: { id: string; name: string }[]; catalog: CatalogService[]; disabled?: boolean }) {
  const carriers = carrierOptions(catalog);
  const d = detection.distinct;
  const sections: {
    key: string;
    legend: string;
    description?: string;
    name: ValueMapName;
    values: typeof d.types;
    fallback: string | null;
    options: { value: string; label: string }[];
    emptyLabel: string;
    allowEmpty: boolean;
  }[] = [
    { key: "types", legend: "Adjustment types in the file", description: "Rows whose type is not matched are refused until it is.", name: "typeMap", values: d.types, fallback: null, options: TYPE_OPTIONS.map((t) => ({ value: t.value, label: t.label })), emptyLabel: "Not matched", allowEmpty: true },
    { key: "causes", legend: "Reasons and causes in the file", description: "Each reason is matched to one of the causes. A row with no reason is stored under the cause chosen above.", name: "causeMap", values: d.causes, fallback: mapping.defaults.cause, options: CAUSE_OPTIONS.map((c) => ({ value: c, label: CAUSE_LABELS[c] })), emptyLabel: "", allowEmpty: false },
    { key: "carriers", legend: "Carriers in the file", name: "carrierMap", values: d.carriers, fallback: null, options: carriers.map((c) => ({ value: c.code, label: c.name })), emptyLabel: "Not matched", allowEmpty: true },
    { key: "services", legend: "Services in the file", description: "A service that is not matched stays unknown for those rows; the rows are still counted.", name: "serviceMap", values: d.services, fallback: null, options: catalog.map((s) => ({ value: s.id, label: serviceLabel(s) })), emptyLabel: "Not matched", allowEmpty: true },
    { key: "customers", legend: "Customers in the file", description: "A customer that is not matched stays in your history but counts for no customer.", name: "brandMap", values: d.customers, fallback: null, options: brands.map((b) => ({ value: b.id, label: b.name })), emptyLabel: "Leave unassigned", allowEmpty: true },
  ];
  return (
    <>
      {sections
        .filter((s) => s.values.length > 0)
        .map((s) => {
          const rows = valueRows<string>(s.values, mapping[s.name] as Record<string, string | null>, s.fallback).slice(0, MAX_ROWS_PER_MAP);
          return (
            <fieldset key={s.key} className="space-y-3" disabled={disabled}>
              <legend className="text-sm font-semibold">{s.legend}</legend>
              {s.description ? <p className="text-sm text-muted">{s.description}</p> : null}
              <div className="grid gap-4 sm:grid-cols-2">
                {rows.map((r) => (
                  <Field
                    key={r.normalized}
                    id={`${idPrefix}-${s.key}-${r.normalized.replace(/[^a-z0-9]+/g, "-")}`}
                    label={`“${r.text}” (${formatCount(r.rows)} ${r.rows === 1 ? "row" : "rows"})`}
                    hint={r.matchedAutomatically ? "Matched automatically." : undefined}
                  >
                    {(aria) => (
                      <Select {...aria} value={r.value ?? ""} onChange={(e) => onChange(setMapEntry(mapping, s.name, r.normalized, e.target.value === "" ? null : e.target.value))}>
                        {/* A cause always has a value (the stored mapping cannot hold "no cause"); the other maps may be left unmatched. */}
                        {s.allowEmpty ? <option value="">{s.emptyLabel}</option> : null}
                        {s.options.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                ))}
              </div>
              {s.values.length > MAX_ROWS_PER_MAP ? <p className="text-sm text-muted">{`Showing the ${MAX_ROWS_PER_MAP} most common of ${formatCount(s.values.length)}. The others are matched automatically or left unmatched.`}</p> : null}
            </fieldset>
          );
        })}
    </>
  );
}

function DuplicateChoice({ value, onChange, disabled }: { value: DuplicateHandling; onChange: (v: DuplicateHandling) => void; disabled?: boolean }) {
  const name = useId();
  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <legend className="text-sm font-semibold">{DUPLICATE_LEGEND}</legend>
      <p className="text-sm text-muted">{DUPLICATE_RULE_NOTE}</p>
      <div className="space-y-2">
        {DUPLICATE_OPTIONS.map((o) => (
          <label key={o.value} className="flex min-h-11 items-start gap-3 rounded-control border border-line px-3 py-2.5 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} className="mt-0.5 size-5 accent-accent" />
            <span>
              <span className="block font-medium">{o.label}</span>
              <span className="block text-muted">{o.help}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
