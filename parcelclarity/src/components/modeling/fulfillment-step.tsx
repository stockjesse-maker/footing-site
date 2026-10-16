"use client";

import type { Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import type { DriverQuestion } from "@/lib/fees/queries";
import { formatDate } from "@/lib/format/date";
import {
  averageToContentRows,
  describePeriodVolume,
  newContentRow,
  type AnswerChoice,
  type FulfillmentFormState,
  type RunSetupPeriod,
} from "@/lib/modeling/assumptions";
import { D } from "@/engine/money";

/**
 * Run setup, step 2: "Fulfillment costs". One screen of questions generated from the customer's fee
 * schedule: the monthly volume, one question per driver (a number, "not sure" or "we don't use this"),
 * the packaging to assume, the typical order when the file has no item counts, and a switch that skips
 * all of it. The state lives in the parent (`RunSetupForm`), which turns it into the one JSON field the
 * server action parses; this component only shows and edits it. Nothing here names a rule key, an id
 * or a version number, and nothing is ever presented as $0 unless the customer chose "We don't use this".
 */

export type FulfillmentAudience = "brand" | "staff";

export interface FulfillmentStepProps {
  id: string;
  audience: FulfillmentAudience;
  schedule: { name: string; effectiveDate: string; questions: DriverQuestion[]; packagingTypes: string[] };
  period: RunSetupPeriod | null;
  showPackaging: boolean;
  showContent: boolean;
  state: FulfillmentFormState;
  setState: Dispatch<SetStateAction<FulfillmentFormState>>;
  /** Errors to show, keyed as in `fulfillmentFieldErrors` ("drivers.<key>", "monthlyOrders", "orderContent.rows", …). */
  errors: Record<string, string>;
  headingRef: RefObject<HTMLHeadingElement | null>;
}

const MAX_CONTENT_ROWS = 12;

function Choice({ name, checked, onChange, invalid, describedBy, children }: { name: string; checked: boolean; onChange: () => void; invalid?: boolean; describedBy?: string; children: ReactNode }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
      <input type="radio" name={name} checked={checked} onChange={onChange} data-invalid={invalid ? "true" : undefined} aria-describedby={describedBy} className="size-4 shrink-0 accent-accent" />
      <span>{children}</span>
    </label>
  );
}

function ErrorText({ id, children }: { id: string; children?: string }) {
  return children ? (
    <p id={id} role="alert" className="text-sm font-medium text-danger">
      {children}
    </p>
  ) : null;
}

const numberProps = { type: "text", inputMode: "decimal", autoComplete: "off", spellCheck: false } as const;

function unitSuffix(q: DriverQuestion): string {
  if (q.kind === "returns_rate") return "% of orders";
  if (q.billingPeriod === "week") return `${q.unit} per week`;
  if (q.billingPeriod === "day") return `${q.unit} per day`;
  return q.unit;
}

export function FulfillmentStep(p: FulfillmentStepProps) {
  const { id, audience, schedule, period, showPackaging, showContent, state, setState, errors, headingRef } = p;
  const you = audience === "brand";
  const { sentence, notes, volume } = describePeriodVolume(period);
  const patch = (next: Partial<FulfillmentFormState>) => setState((s) => ({ ...s, ...next }));
  const volumeError = errors.monthlyOrders;
  const when = formatDate(schedule.effectiveDate);
  const intro = you
    ? `Your fee schedule ${schedule.name} (in effect from ${when}) charges for things your orders file does not say. Answer what you know; anything you leave out is shown as not included, never as $0.`
    : `The customer's fee schedule ${schedule.name} (in effect from ${when}) charges for things the orders file does not say. Answer what the customer knows; anything left out is shown as not included, never as $0.`;

  const rowsTotal = (() => {
    let total = new D(0);
    for (const r of state.contentRows) {
      const text = r.sharePct.trim();
      if (!/^[0-9]+(\.[0-9]+)?$/.test(text)) return null;
      total = total.plus(text);
    }
    return total;
  })();
  const average = state.contentMode === "average" ? averageToContentRows(state.averageUnits, state.averageLines) : null;

  return (
    <section aria-labelledby={`${id}-heading`} className="space-y-6">
      <div className="space-y-2">
        <h3 id={`${id}-heading`} ref={headingRef} tabIndex={-1} className="text-base font-semibold tracking-tight outline-none">
          Fulfillment costs
        </h3>
        <p className="text-sm text-muted">{intro}</p>
      </div>

      <div className="space-y-0.5">
        <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
          <input type="checkbox" checked={state.skip} onChange={(e) => patch({ skip: e.target.checked })} aria-describedby={`${id}-skip-help`} className="size-5 shrink-0 accent-accent" />
          Skip fulfillment costs (shipping only)
        </label>
        <p id={`${id}-skip-help`} className="pl-8 text-sm text-muted">
          The run prices shipping only: no order fees, monthly charges or all-in figures.
        </p>
      </div>

      <fieldset disabled={state.skip} className="min-w-0 space-y-6 border-0 p-0 disabled:opacity-60">
        <legend className="sr-only">Fulfillment cost questions</legend>

        {/* 1. Volume */}
        <fieldset className="min-w-0 space-y-2 border-0 p-0">
          <legend className="text-sm font-semibold">Monthly volume</legend>
          <p className="text-sm">{sentence}</p>
          {notes.map((n) => (
            <p key={n} className="text-sm text-muted">
              {n}
            </p>
          ))}
          {volume.ok ? (
            <>
              <Choice name={`${id}-volume`} checked={state.volumeMode === "file"} onChange={() => patch({ volumeMode: "file" })}>
                Use this volume
              </Choice>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Choice name={`${id}-volume`} checked={state.volumeMode === "stated"} onChange={() => patch({ volumeMode: "stated" })} invalid={!!volumeError} describedBy={volumeError ? `${id}-volume-err` : undefined}>
                  Use a different volume
                </Choice>
                <Input
                  {...numberProps}
                  aria-label="Orders a month"
                  aria-invalid={volumeError ? true : undefined}
                  aria-describedby={volumeError ? `${id}-volume-err` : undefined}
                  value={state.volume}
                  onChange={(e) => patch({ volume: e.target.value, volumeMode: "stated" })}
                  className="max-w-36"
                />
                <span className="text-sm text-muted">orders a month</span>
              </div>
            </>
          ) : (
            <Field id={`${id}-volume`} label="Orders a month (optional)" error={volumeError} hint="Leave empty to price per-order fees only; monthly charges per order are then shown as not computed.">
              {(aria) => <Input {...aria} {...numberProps} value={state.volume} onChange={(e) => patch({ volume: e.target.value, volumeMode: "stated" })} className="max-w-48" />}
            </Field>
          )}
          {volume.ok ? <ErrorText id={`${id}-volume-err`}>{volumeError}</ErrorText> : null}
        </fieldset>

        {/* 2. One question per driver */}
        {schedule.questions.map((q, index) => {
          const qid = `${id}-q${index}`;
          const key = q.answers === "orderShares" ? `orderShares.${q.key}` : `drivers.${q.key}`;
          const error = errors[key];
          const describedBy = [q.helpText ? `${qid}-help` : null, error ? `${qid}-err` : null].filter(Boolean).join(" ") || undefined;
          const choice: AnswerChoice | null = q.answers === "orderShares" ? (state.shares[q.key]?.choice ?? null) : (state.drivers[q.key]?.choice ?? null);
          const setChoice = (next: AnswerChoice) =>
            setState((s) =>
              q.answers === "orderShares"
                ? { ...s, shares: { ...s.shares, [q.key]: { sharePct: "", count: "", ...s.shares[q.key], choice: next } } }
                : { ...s, drivers: { ...s.drivers, [q.key]: { value: "", ...s.drivers[q.key], choice: next } } },
            );
          return (
            <fieldset key={q.key} aria-describedby={describedBy} className="min-w-0 space-y-2 rounded-card border border-line p-4">
              <legend className="px-1 text-sm font-semibold">{q.label}</legend>
              {q.helpText ? (
                <p id={`${qid}-help`} className="text-sm text-muted">
                  {q.helpText}
                </p>
              ) : null}
              <ul className="space-y-0.5 text-sm text-muted">
                {q.rules.map((r) => (
                  <li key={`${r.name}-${r.describe}`}>
                    <span className="font-medium text-fg">{r.name}</span>: {r.describe.endsWith(".") ? r.describe : `${r.describe}.`}
                  </li>
                ))}
              </ul>
              {q.longTerm?.mode === "replace" && q.longTerm.partOf ? (
                <p className="text-sm text-muted">
                  Held longer than {q.longTerm.thresholdDays} days. This is part of {q.longTerm.partOf.label.toLowerCase()} above, not in addition to it.
                </p>
              ) : null}

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Choice name={qid} checked={choice === "number"} onChange={() => setChoice("number")} invalid={!!error} describedBy={describedBy}>
                  Enter a number
                </Choice>
                {q.answers === "orderShares" ? (
                  <>
                    <Input
                      {...numberProps}
                      aria-label={`${q.label}: share of orders, in percent`}
                      aria-invalid={error ? true : undefined}
                      value={state.shares[q.key]?.sharePct ?? ""}
                      onChange={(e) => setState((s) => ({ ...s, shares: { ...s.shares, [q.key]: { count: "", ...s.shares[q.key], choice: "number", sharePct: e.target.value } } }))}
                      className="max-w-24"
                    />
                    <span className="text-sm text-muted">% of orders get</span>
                    <Input
                      {...numberProps}
                      inputMode="numeric"
                      aria-label={`${q.label}: ${q.unit} per order`}
                      aria-invalid={error ? true : undefined}
                      value={state.shares[q.key]?.count ?? ""}
                      onChange={(e) => setState((s) => ({ ...s, shares: { ...s.shares, [q.key]: { sharePct: "", ...s.shares[q.key], choice: "number", count: e.target.value } } }))}
                      className="max-w-20"
                    />
                    <span className="text-sm text-muted">{q.unit} each</span>
                  </>
                ) : (
                  <>
                    <Input
                      {...numberProps}
                      aria-label={`${q.label}: number of ${q.kind === "returns_rate" ? "percent of orders" : q.unit}`}
                      aria-invalid={error ? true : undefined}
                      value={state.drivers[q.key]?.value ?? ""}
                      onChange={(e) => setState((s) => ({ ...s, drivers: { ...s.drivers, [q.key]: { ...s.drivers[q.key], choice: "number", value: e.target.value } } }))}
                      className="max-w-36"
                    />
                    <span className="text-sm text-muted">{unitSuffix(q)}</span>
                  </>
                )}
              </div>
              <Choice name={qid} checked={choice === "unsure"} onChange={() => setChoice("unsure")}>
                Not sure, leave it out
              </Choice>
              <Choice name={qid} checked={choice === "none"} onChange={() => setChoice("none")}>
                We don&apos;t use this
              </Choice>
              <ErrorText id={`${qid}-err`}>{error}</ErrorText>
            </fieldset>
          );
        })}

        {/* 3. Packaging default */}
        {showPackaging && schedule.packagingTypes.length > 0 ? (
          <Field
            id={`${id}-packaging`}
            label="Packaging for packages the file does not name"
            error={errors.packagingDefault}
            hint={`${you ? "Some of your packages have" : "Some packages in the file have"} no packaging type. Choose the packaging they use so packaging fees can be priced; Not sure leaves packaging fees out.`}
          >
            {(aria) => (
              <Select {...aria} defaultValue={state.packagingDefault} onChange={(e) => patch({ packagingDefault: e.target.value })}>
                <option value="">Not sure</option>
                {[...new Set([...schedule.packagingTypes, ...(state.packagingDefault && !schedule.packagingTypes.includes(state.packagingDefault) ? [state.packagingDefault] : [])])].map((t) => (
                  <option key={t} value={t}>
                    {t.charAt(0).toUpperCase()}
                    {t.slice(1)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}

        {/* 4. Order content */}
        {showContent ? (
          <fieldset className="min-w-0 space-y-2 border-0 p-0">
            <legend className="text-sm font-semibold">What is in a typical order</legend>
            <p className="text-sm text-muted">
              {you ? "Your" : "The"} file does not say how many items are in each order, and some fees count items, order lines or products. Describe the orders by size, or leave it out and those fees are shown as not included.
            </p>
            <Choice name={`${id}-content`} checked={state.contentMode === "none"} onChange={() => patch({ contentMode: "none" })}>
              Not sure, leave it out
            </Choice>
            <Choice name={`${id}-content`} checked={state.contentMode !== "none"} onChange={() => patch({ contentMode: state.contentMode === "average" ? "average" : "rows" })}>
              Describe typical orders
            </Choice>

            {state.contentMode !== "none" ? (
              <div className="space-y-3 pl-0 sm:pl-7">
                <label className="flex min-h-11 items-center gap-3 text-sm">
                  <input type="checkbox" checked={state.contentMode === "average"} onChange={(e) => patch({ contentMode: e.target.checked ? "average" : "rows" })} className="size-5 shrink-0 accent-accent" />
                  Average instead
                </label>

                {state.contentMode === "rows" ? (
                  <>
                    {state.contentRows.map((row, i) => {
                      const set = (next: Partial<typeof row>) => setState((s) => ({ ...s, contentRows: s.contentRows.map((r, j) => (j === i ? { ...r, ...next } : r)) }));
                      const cells: { field: "units" | "lines" | "sharePct"; label: string }[] = [
                        { field: "units", label: "Items" },
                        { field: "lines", label: "Lines" },
                        { field: "sharePct", label: "% of orders" },
                      ];
                      return (
                        <div key={i} className="space-y-2 rounded-control border border-line p-3">
                          <div className="grid grid-cols-3 gap-2">
                            {cells.map((c) => {
                              const err = errors[`orderContent.rows.${i}.${c.field}`];
                              const inputId = `${id}-row${i}-${c.field}`;
                              return (
                                <div key={c.field} className="min-w-0 space-y-1">
                                  <label htmlFor={inputId} className="block text-sm font-medium">
                                    {c.label}
                                    <span className="sr-only"> in row {i + 1}</span>
                                  </label>
                                  <Input
                                    id={inputId}
                                    {...numberProps}
                                    inputMode={c.field === "sharePct" ? "decimal" : "numeric"}
                                    value={row[c.field]}
                                    onChange={(e) => set({ [c.field]: e.target.value })}
                                    aria-invalid={err ? true : undefined}
                                    aria-describedby={err ? `${inputId}-err` : undefined}
                                  />
                                  <ErrorText id={`${inputId}-err`}>{err}</ErrorText>
                                </div>
                              );
                            })}
                          </div>
                          {state.contentRows.length > 1 ? (
                            <Button variant="ghost" size="md" aria-label={`Remove row ${i + 1}`} onClick={() => setState((s) => ({ ...s, contentRows: s.contentRows.filter((_, j) => j !== i) }))}>
                              Remove row
                            </Button>
                          ) : null}
                        </div>
                      );
                    })}
                    <div className="flex flex-wrap items-center gap-3">
                      <Button variant="secondary" disabled={state.contentRows.length >= MAX_CONTENT_ROWS} onClick={() => setState((s) => ({ ...s, contentRows: [...s.contentRows, newContentRow()] }))}>
                        Add a row
                      </Button>
                      <p className="text-sm text-muted" aria-live="polite">
                        {rowsTotal ? (rowsTotal.eq(100) ? "Shares add up to 100.00%." : `Shares add up to ${rowsTotal.toFixed(2)}%; they must add up to exactly 100.00%.`) : "Shares must add up to exactly 100.00%."}
                      </p>
                    </div>
                    <ErrorText id={`${id}-rows-err`}>{errors["orderContent.rows"]}</ErrorText>
                  </>
                ) : (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <Field id={`${id}-avg-units`} label="Average items per order">
                        {(aria) => <Input {...aria} {...numberProps} value={state.averageUnits} onChange={(e) => patch({ averageUnits: e.target.value })} placeholder="e.g. 1.4" />}
                      </Field>
                      <Field id={`${id}-avg-lines`} label="Average order lines per order">
                        {(aria) => <Input {...aria} {...numberProps} value={state.averageLines} onChange={(e) => patch({ averageLines: e.target.value })} placeholder="e.g. 1.2" />}
                      </Field>
                    </div>
                    <ErrorText id={`${id}-avg-err`}>{errors["orderContent.average"]}</ErrorText>
                    {average?.ok ? (
                      <p className="text-sm text-muted" aria-live="polite">
                        That is {average.rows.map((r) => `${r.sharePct}% of orders with ${r.units} ${r.units === 1 ? "item" : "items"} on ${r.lines} ${r.lines === 1 ? "line" : "lines"}`).join("; ")}, which gives exactly these averages.
                      </p>
                    ) : null}
                  </div>
                )}
              </div>
            ) : null}
          </fieldset>
        ) : null}
      </fieldset>
    </section>
  );
}
