"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { loadHistoryStatistics } from "@/app/actions/adjustments";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/field";
import { GENERIC_FAILURE } from "@/lib/adjustments/action-schemas";
import type { HistoryRefused, HistoryStatistics } from "@/engine/adjustments/types";
import { CAUSE_LABELS, CAUSE_OPTIONS, STATS_BUTTON, STATS_INTRO, STATS_PENDING } from "@/lib/adjustments/staff-copy";
import { FocusAlert } from "./focus-alert";
import { TYPE_OPTIONS, carrierOptions, serviceLabel, type CatalogService } from "./import-model";
import { EMPTY_STATS_FORM, refusalAdvice, statsInput, type StatsForm, type StatsFormErrors } from "./stats-model";
import { StatisticsView } from "./stats-view";
import Link from "next/link";

export type StatsOutcome =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "ok"; stats: HistoryStatistics; scopeName: string; recordsRead: number }
  | { kind: "refused"; refusal: HistoryRefused }
  | { kind: "problem"; message: string; attempt: number };

export interface StatsWorkspaceViewProps {
  brands: { id: string; name: string }[];
  catalog: CatalogService[];
  form: StatsForm;
  errors: StatsFormErrors;
  outcome: StatsOutcome;
  onChange: (patch: Partial<StatsForm>) => void;
  onSubmit: () => void;
  prefix: string;
}

/** The filters and the result they give. Stateless: `StatsWorkspace` owns the state and calls the action. */
export function StatsWorkspaceView({ brands, catalog, form, errors, outcome, onChange, onSubmit, prefix }: StatsWorkspaceViewProps) {
  const carriers = carrierOptions(catalog);
  const services = catalog.filter((s) => s.carrierCode === form.carrierCode);
  const pending = outcome.kind === "pending";
  const resultId = `${prefix}-result`;
  return (
    <div className="space-y-8">
      <Card>
        <CardTitle>Filters</CardTitle>
        <CardDescription>{STATS_INTRO}</CardDescription>
        <form
          className="mt-4 space-y-5"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field id={`${prefix}-brand`} label="Customer">
              {(aria) => (
                <Select {...aria} value={form.brandId} onChange={(e) => onChange({ brandId: e.target.value })}>
                  <option value="">All customers together</option>
                  {brands.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field id={`${prefix}-carrier`} label="Carrier">
              {(aria) => (
                <Select {...aria} value={form.carrierCode} onChange={(e) => onChange({ carrierCode: e.target.value, serviceId: "" })}>
                  <option value="">Any carrier</option>
                  {carriers.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field id={`${prefix}-service`} label="Service" hint={form.carrierCode === "" ? "Choose a carrier first." : undefined}>
              {(aria) => (
                <Select {...aria} value={form.serviceId} disabled={form.carrierCode === ""} onChange={(e) => onChange({ serviceId: e.target.value })}>
                  <option value="">Any service</option>
                  {services.map((s) => (
                    <option key={s.id} value={s.id}>
                      {serviceLabel(s)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field id={`${prefix}-type`} label="Kind of adjustment">
              {(aria) => (
                <Select {...aria} value={form.adjustmentType} onChange={(e) => onChange({ adjustmentType: e.target.value })}>
                  <option value="">Any kind</option>
                  {TYPE_OPTIONS.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field id={`${prefix}-cause`} label="Cause">
              {(aria) => (
                <Select {...aria} value={form.cause} onChange={(e) => onChange({ cause: e.target.value })}>
                  <option value="">Any cause</option>
                  {CAUSE_OPTIONS.map((c) => (
                    <option key={c} value={c}>
                      {CAUSE_LABELS[c]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field id={`${prefix}-days`} label="Adjustments can still be added for (days)" hint="After a period ends. A period that ended more recently is flagged as possibly incomplete. Leave empty to switch the flag off." error={errors.maturityDays}>
              {(aria) => <Input {...aria} type="text" inputMode="numeric" autoComplete="off" value={form.maturityDays} onChange={(e) => onChange({ maturityDays: e.target.value })} />}
            </Field>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Ship dates</legend>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field id={`${prefix}-from`} label="From" error={errors.window}>
                {(aria) => <Input {...aria} type="date" value={form.from} onChange={(e) => onChange({ from: e.target.value })} />}
              </Field>
              <Field id={`${prefix}-to`} label="To">
                {(aria) => <Input {...aria} type="date" value={form.to} onChange={(e) => onChange({ to: e.target.value })} />}
              </Field>
            </div>
            <p className="text-sm text-muted">Leave both empty to use all the history. How often adjustments happen needs packages shipped for the same dates.</p>
          </fieldset>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={pending}>
              {pending ? STATS_PENDING : STATS_BUTTON}
            </Button>
          </div>
        </form>
      </Card>

      <div aria-live="polite" aria-busy={pending || undefined} id={resultId}>
        {outcome.kind === "pending" ? <p role="status" className="text-sm text-muted">{STATS_PENDING}</p> : null}
        {outcome.kind === "ok" ? <StatisticsView stats={outcome.stats} scopeName={outcome.scopeName} headingId={`${prefix}-stats`} /> : null}
        {outcome.kind === "refused" ? <RefusedAlert refusal={outcome.refusal} /> : null}
      </div>
      {outcome.kind === "problem" ? <FocusAlert key={outcome.attempt}>{outcome.message}</FocusAlert> : null}
    </div>
  );
}

function RefusedAlert({ refusal }: { refusal: HistoryRefused }) {
  const advice = refusalAdvice(refusal);
  return (
    <Alert tone="warning" title="These statistics cannot be worked out as asked">
      <p>{advice.message}</p>
      {advice.link ? (
        <p className="mt-1">
          <Link href={advice.link.href} className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
            {advice.link.label}
          </Link>
        </p>
      ) : null}
    </Alert>
  );
}

export function StatsWorkspace({ brands, catalog, autoRun = true }: { brands: { id: string; name: string }[]; catalog: CatalogService[]; autoRun?: boolean }) {
  const prefix = useId();
  const [form, setForm] = useState<StatsForm>(EMPTY_STATS_FORM);
  const [errors, setErrors] = useState<StatsFormErrors>({});
  const [outcome, setOutcome] = useState<StatsOutcome>({ kind: "idle" });
  const [, start] = useTransition();
  const attempts = useRef(0);
  const ran = useRef(false);

  const run = (f: StatsForm) => {
    const built = statsInput(f);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    setOutcome({ kind: "pending" });
    start(async () => {
      try {
        const r = await loadHistoryStatistics(built.input);
        if (r.status === "ok") setOutcome({ kind: "ok", stats: r.statistics, scopeName: f.brandId === "" ? "All customers together" : (brands.find((b) => b.id === f.brandId)?.name ?? "One customer"), recordsRead: r.recordsRead });
        else if (r.status === "refused") setOutcome({ kind: "refused", refusal: r.refusal });
        else {
          attempts.current += 1;
          setOutcome({ kind: "problem", message: r.status === "invalid" ? (r.problems[0] ?? GENERIC_FAILURE) : r.message, attempt: attempts.current });
        }
      } catch {
        attempts.current += 1;
        setOutcome({ kind: "problem", message: GENERIC_FAILURE, attempt: attempts.current });
      }
    });
  };

  useEffect(() => {
    if (!autoRun || ran.current) return;
    ran.current = true;
    run(EMPTY_STATS_FORM);
    // Runs once, with the default filters; later runs are the person's own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <StatsWorkspaceView brands={brands} catalog={catalog} form={form} errors={errors} outcome={outcome} onChange={(patch) => setForm((f) => ({ ...f, ...patch }))} onSubmit={() => run(form)} prefix={prefix} />;
}
