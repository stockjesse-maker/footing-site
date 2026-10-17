"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { deleteBaseline, saveBaseline } from "@/app/actions/adjustments";
import { ConfirmAction } from "@/components/forms/confirm-action";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { DataList, DataRow } from "@/components/ui/data-list";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/field";
import { GENERIC_FAILURE } from "@/lib/adjustments/action-schemas";
import { BASELINES_EMPTY_BODY, BASELINES_EMPTY_TITLE, BASELINES_INTRO, BASELINES_TITLE, BASELINE_ALL_CARRIERS, BASELINE_ALL_CUSTOMERS, BASELINE_ALL_SERVICES, BASELINE_DELETE_BUTTON, BASELINE_SAVE_BUTTON, READ_ONLY_NOTICE, formatCount } from "@/lib/adjustments/staff-copy";
import { FocusAlert } from "./focus-alert";
import { carrierOptions, serviceLabel, type CatalogService } from "./import-model";
import { EMPTY_BASELINE_FORM, baselineInput, baselinePeriod, baselineScope, baselineSize, sortBaselines, type BaselineForm, type BaselineFormErrors, type BaselineView } from "./baselines-model";

/** The saved figures, newest period first. A phone shows one card each. Delete is a two-step ConfirmAction and only for an administrator. */
export function BaselineList({ baselines, brands, catalog, canManage }: { baselines: readonly BaselineView[]; brands: readonly { id: string; name: string }[]; catalog: readonly CatalogService[]; canManage: boolean }) {
  if (!baselines.length) return <EmptyState title={BASELINES_EMPTY_TITLE}>{BASELINES_EMPTY_BODY}</EmptyState>;
  return (
    <section aria-label="Packages shipped, by period">
      <DataList>
        {sortBaselines(baselines).map((b) => {
          const scope = baselineScope(b, brands, catalog);
          const period = baselinePeriod(b);
          return (
            <DataRow key={b.id} className="sm:items-start">
              <div className="min-w-0 space-y-0.5">
                <p className="font-medium [overflow-wrap:anywhere]">{scope}</p>
                <p className="text-sm text-muted">{period}</p>
                <p className="tabular text-[15px]">
                  {baselineSize(b)}
                  {b.labelsMissingWeight !== null ? <span className="text-sm text-muted">{`, ${formatCount(b.labelsMissingWeight)} printed without a weight`}</span> : null}
                </p>
                {b.note ? <p className="max-w-prose text-sm text-muted [overflow-wrap:anywhere]">{b.note}</p> : null}
              </div>
              {canManage ? (
                <div role="group" aria-label={`Delete packages shipped: ${scope}, ${period}`} className="shrink-0">
                  <DeleteBaseline id={b.id} />
                </div>
              ) : null}
            </DataRow>
          );
        })}
      </DataList>
    </section>
  );
}

function DeleteBaseline({ id }: { id: string }) {
  const router = useRouter();
  return (
    <ConfirmAction
      label={BASELINE_DELETE_BUTTON}
      confirmLabel="Delete"
      variant="ghost"
      action={async () => {
        const result = await deleteBaseline(id);
        if (result.ok) router.refresh();
        return result;
      }}
    >
      How often adjustments happen shows nothing for these dates until you add the figure again.
    </ConfirmAction>
  );
}

export interface BaselineFormViewProps {
  brands: readonly { id: string; name: string }[];
  catalog: readonly CatalogService[];
  form: BaselineForm;
  errors: BaselineFormErrors;
  pending: boolean;
  failure: { message: string; attempt: number } | null;
  saved: boolean;
  onChange: (patch: Partial<BaselineForm>) => void;
  onSubmit: () => void;
  prefix: string;
}

export function BaselineFormView({ brands, catalog, form, errors, pending, failure, saved, onChange, onSubmit, prefix }: BaselineFormViewProps) {
  const carriers = carrierOptions(catalog as CatalogService[]);
  const services = catalog.filter((s) => s.carrierCode === form.carrierCode);
  return (
    <Card>
      <CardTitle>Add packages shipped</CardTitle>
      <CardDescription>The number of carrier packages you shipped in a period. One label is one package. Periods for the same customer, carrier and service cannot overlap.</CardDescription>
      <form
        className="mt-4 space-y-5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field id={`${prefix}-brand`} label="Customer" error={errors.brandId}>
            {(aria) => (
              <Select {...aria} value={form.brandId} onChange={(e) => onChange({ brandId: e.target.value })}>
                <option value="">{BASELINE_ALL_CUSTOMERS}</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field id={`${prefix}-carrier`} label="Carrier" error={errors.carrierCode}>
            {(aria) => (
              <Select {...aria} value={form.carrierCode} onChange={(e) => onChange({ carrierCode: e.target.value, serviceId: "" })}>
                <option value="">{BASELINE_ALL_CARRIERS}</option>
                {carriers.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field id={`${prefix}-service`} label="Service" hint={form.carrierCode === "" ? "Choose a carrier first." : undefined} error={errors.serviceId}>
            {(aria) => (
              <Select {...aria} value={form.serviceId} disabled={form.carrierCode === ""} onChange={(e) => onChange({ serviceId: e.target.value })}>
                <option value="">{BASELINE_ALL_SERVICES}</option>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {serviceLabel(s)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field id={`${prefix}-start`} label="First day of the period" error={errors.periodStart}>
            {(aria) => <Input {...aria} type="date" value={form.periodStart} onChange={(e) => onChange({ periodStart: e.target.value })} />}
          </Field>
          <Field id={`${prefix}-end`} label="Last day of the period" error={errors.periodEnd}>
            {(aria) => <Input {...aria} type="date" value={form.periodEnd} onChange={(e) => onChange({ periodEnd: e.target.value })} />}
          </Field>
          <Field id={`${prefix}-packages`} label="Packages shipped" hint="Carrier packages, not orders." error={errors.packages}>
            {(aria) => <Input {...aria} type="text" inputMode="numeric" autoComplete="off" value={form.packages} onChange={(e) => onChange({ packages: e.target.value })} />}
          </Field>
          <Field id={`${prefix}-missing`} label="Labels printed without a weight (optional)" hint="How many of those packages had no weight when the label was printed." error={errors.labelsMissing}>
            {(aria) => <Input {...aria} type="text" inputMode="numeric" autoComplete="off" value={form.labelsMissing} onChange={(e) => onChange({ labelsMissing: e.target.value })} />}
          </Field>
          <div className="sm:col-span-2">
            <Field id={`${prefix}-note`} label="Private note (optional)" hint="Only your team can read this." error={errors.note}>
              {(aria) => <Input {...aria} type="text" maxLength={1000} value={form.note} onChange={(e) => onChange({ note: e.target.value })} />}
            </Field>
          </div>
        </div>
        {failure ? <FocusAlert key={failure.attempt}>{failure.message}</FocusAlert> : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={pending}>
            {BASELINE_SAVE_BUTTON}
          </Button>
          <div aria-live="polite">{saved ? <span className="text-sm font-medium text-success">Saved.</span> : null}</div>
        </div>
      </form>
    </Card>
  );
}

/** The packages-shipped screen: the saved figures, and (for an administrator) a form to add one. */
export function BaselinesPanel({ baselines, brands, catalog, canManage }: { baselines: readonly BaselineView[]; brands: readonly { id: string; name: string }[]; catalog: readonly CatalogService[]; canManage: boolean }) {
  const router = useRouter();
  const prefix = useId();
  const [form, setForm] = useState<BaselineForm>(EMPTY_BASELINE_FORM);
  const [errors, setErrors] = useState<BaselineFormErrors>({});
  const [failure, setFailure] = useState<{ message: string; attempt: number } | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();

  const submit = () => {
    setSaved(false);
    setFailure(null);
    const built = baselineInput(form);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    start(async () => {
      try {
        const r = await saveBaseline(built.input);
        if (r.ok) {
          setForm(EMPTY_BASELINE_FORM);
          setSaved(true);
          router.refresh();
          return;
        }
        if (r.errors) setErrors(r.errors as BaselineFormErrors);
        if (r.message || !r.errors) setFailure({ message: r.message ?? GENERIC_FAILURE, attempt: Date.now() });
      } catch {
        setFailure({ message: GENERIC_FAILURE, attempt: Date.now() });
      }
    });
  };

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{BASELINES_TITLE}</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">{BASELINES_INTRO}</p>
      </div>
      {!canManage ? <Alert>{READ_ONLY_NOTICE}</Alert> : null}
      <BaselineList baselines={baselines} brands={brands} catalog={catalog} canManage={canManage} />
      {canManage ? (
        <BaselineFormView
          brands={brands}
          catalog={catalog}
          form={form}
          errors={errors}
          pending={pending}
          failure={failure}
          saved={saved}
          onChange={(patch) => {
            setSaved(false);
            setForm((f) => ({ ...f, ...patch }));
          }}
          onSubmit={submit}
          prefix={prefix}
        />
      ) : null}
    </div>
  );
}
