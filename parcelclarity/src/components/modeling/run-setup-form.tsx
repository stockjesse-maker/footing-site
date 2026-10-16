"use client";

import { Fragment, useId, useMemo, useRef, useState, type Dispatch, type KeyboardEvent, type MouseEvent, type ReactNode, type SetStateAction } from "react";
import { flushSync, useFormStatus } from "react-dom";
import { createBulkScenario, rerunScenario } from "@/app/actions/modeling";
import { ActionForm, SubmitButton, useFormState } from "@/components/forms/action-form";
import { useLocalToday } from "@/components/forms/local-today";
import { FulfillmentStep } from "@/components/modeling/fulfillment-step";
import { DateField } from "@/components/pricing/service-terms-form";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/field";
import type { FulfillmentAssumptions } from "@/lib/modeling/fee-input";
import {
  derivePeriodVolume,
  diffAssumptions,
  formatAssumptionDiff,
  fulfillmentFromState,
  initialFulfillmentState,
  type FulfillmentFormContext,
  type FulfillmentFormState,
  type RunSetupData,
} from "@/lib/modeling/assumptions";

export interface RunSetupInitial {
  pricingBasis?: "fixed_date" | "ship_date";
  asOfDate?: string | null;
  serviceOverrideId?: string | null;
  overrideAllServices?: boolean;
  residentialDefault?: boolean | null;
  originZipDefault?: string | null;
  /** The previous run's fulfillment answers (`assumptions.fulfillment`): step 2 opens with every one of them filled in. */
  fulfillment?: FulfillmentAssumptions | null;
}

export interface RunSetupProps {
  /** Staff pass the customer; brand members are bound to their own. */
  brandId?: string;
  datasetId?: string;
  /** Re-run an existing scenario instead of creating one. */
  projectId?: string;
  cards: { id: string; name: string; effectiveDates: string[] }[];
  services: { id: string; carrierCode: string; name: string }[];
  /** True when the file carries no residential flag: the question must be asked. */
  askResidential: boolean;
  /** True when the file carries no origin ZIP. */
  askOrigin: boolean;
  defaultOriginZip: string | null;
  /** Shipments whose shipping service is not mapped (excluded unless a service is chosen for them). */
  unmappedShipments: number;
  /** Earliest date the customer's rates cover, and the first order date in the file: orders before the rates cannot be priced on their own dates. */
  earliestRatesDate: string | null;
  firstOrderDate: string | null;
  tenantName: string;
  /** The settings of the run on screen, so "run again" starts from what the customer is looking at. */
  initial?: RunSetupInitial;
  /**
   * Step 2 "Fulfillment costs": the result of `loadRunSetupData(supabase, brandId, datasetId)`. Absent = the
   * form has no step 2 and posts no `fulfillment` field.
   */
  fulfillment?: RunSetupData | null;
  /** Wording: staff model on behalf of a customer. Defaults to "staff" when `brandId` is passed, else "brand". */
  audience?: "brand" | "staff";
}

/**
 * Choices for one run: which rates, what to assume, what to do with unmapped services, and (when the
 * customer has a fee schedule) the fulfillment costs. Step 1 is the shipping settings, step 2 the
 * fulfillment questions; both are one form, so nothing is lost moving between them and one button
 * starts the run. Every assumption is explicit. After a server-side error the form keeps what was
 * entered (the server echoes the values), so a resubmit never silently runs with different settings.
 */
export function RunSetupForm(p: RunSetupProps) {
  const action = p.projectId ? rerunScenario : createBulkScenario;
  return (
    <Card>
      <CardTitle>{p.projectId ? "Run again, or change the settings" : "Run the model"}</CardTitle>
      <CardDescription>Every shipment is priced individually on the rates you choose; results are estimates, never an invoice.</CardDescription>
      <ActionForm action={action} className="mt-5 space-y-6">
        <RunSetupFields {...p} />
      </ActionForm>
    </Card>
  );
}

/**
 * React 19 resets a form after its action has finished, failed or not. Radios and checkboxes go back to the
 * state they were created with and selects to their default option, while component state (and with it the
 * hidden fields that are posted) keeps the customer's choices. A retry would then send settings the screen
 * does not show: a skipped fulfillment step with the box unticked, business deliveries shown as home deliveries,
 * a different rates basis. The fields are created again on every response, so they start from the current state
 * and from the values the action echoed, and the reset leaves them as shown.
 */
function ResetSafe({ children }: { children: ReactNode }) {
  const state = useFormState();
  const [seen, setSeen] = useState(state);
  const [epoch, setEpoch] = useState(0);
  if (seen !== state) {
    setSeen(state);
    setEpoch((e) => e + 1);
  }
  return <Fragment key={epoch}>{children}</Fragment>;
}

function RunSetupFields(p: RunSetupProps) {
  const schedule = p.fulfillment?.schedule;
  if (p.fulfillment && schedule?.status === "ok") return <TwoStepFields {...p} setup={p.fulfillment} schedule={schedule} />;
  return (
    <>
      <Identity {...p} />
      <ResetSafe>
        <ShippingFields {...p} />
      </ResetSafe>
      <ScheduleNote {...p} />
      <SubmitButton pendingLabel="Starting…">{p.projectId ? "Run again with these settings" : "Run the model"}</SubmitButton>
    </>
  );
}

function Identity(p: RunSetupProps) {
  return (
    <>
      {p.brandId ? <input type="hidden" name="brandId" value={p.brandId} /> : null}
      {p.datasetId ? <input type="hidden" name="datasetId" value={p.datasetId} /> : null}
      {p.projectId ? <input type="hidden" name="projectId" value={p.projectId} /> : null}
    </>
  );
}

/** Why there is no step 2, when the fulfillment data was loaded but there is nothing to ask. */
function ScheduleNote(p: RunSetupProps) {
  const schedule = p.fulfillment?.schedule;
  if (!schedule) return null;
  const staff = (p.audience ?? (p.brandId ? "staff" : "brand")) === "staff";
  if (schedule.status === "none") {
    return <p className="text-sm text-muted">{staff ? "No fee schedule is assigned to this customer, so this run prices shipping only. Assign one to price fulfillment fees." : "No fulfillment fee schedule is set up for your account, so this run prices shipping only."}</p>;
  }
  if (schedule.status === "not_effective") {
    return <p className="text-sm text-muted">{`${schedule.name || (staff ? "The customer's fee schedule" : "Your fee schedule")} is not in effect today, so there are no fulfillment questions to answer here.`}</p>;
  }
  if (schedule.status === "unavailable") {
    return <Alert tone="warning">The fulfillment questions could not be loaded, so this run would price fees without any answers. Reload the page to try again.</Alert>;
  }
  return null;
}

/** Step 1: the shipping settings, exactly as before the fee schedule existed. */
function ShippingFields(p: RunSetupProps) {
  const id = useId();
  const state = useFormState();
  const localToday = useLocalToday();
  const init = p.initial ?? {};
  const [basis, setBasis] = useState<"fixed_date" | "ship_date">((state.values?.pricingBasis as "fixed_date" | "ship_date" | undefined) ?? init.pricingBasis ?? "fixed_date");
  const [override, setOverride] = useState(state.values?.serviceOverrideId ?? init.serviceOverrideId ?? "");
  const [overrideAll, setOverrideAll] = useState(state.values ? state.values.overrideAllServices === "on" : (init.overrideAllServices ?? false));
  // With no unmapped shipments a chosen service can only mean a what-if over every shipment.
  const whatIfOnly = p.unmappedShipments === 0;
  const overrideName = p.services.find((s) => s.id === override)?.name;
  const residentialInitial = state.values?.residentialDefault ?? (init.residentialDefault === false ? "no" : "yes");
  return (
    <>
      {!p.projectId ? (
        <Field id={`${id}-card`} label="Rate card" error={state.errors?.rateCardId}>
          {(aria) => (
            <Select {...aria} name="rateCardId" defaultValue={state.values?.rateCardId ?? p.cards[0]?.id ?? ""}>
              {p.cards.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">Which rates to use</legend>
        <label className="flex min-h-11 items-start gap-3 text-sm">
          <input type="radio" name="pricingBasis" value="fixed_date" checked={basis === "fixed_date"} onChange={() => setBasis("fixed_date")} className="mt-1 size-4 accent-accent" />
          <span>
            <span className="font-medium">Rates in effect on one date</span>
            <span className="block text-muted">Every order is priced at the rates in effect on the date below (today unless you change it), so you can see what these orders would cost now.</span>
          </span>
        </label>
        {basis === "fixed_date" ? <DateField id={`${id}-asof`} name="asOfDate" label="Rates in effect on" defaultValue={init.asOfDate ?? localToday} required /> : null}
        <label className="flex min-h-11 items-start gap-3 text-sm">
          <input type="radio" name="pricingBasis" value="ship_date" checked={basis === "ship_date"} onChange={() => setBasis("ship_date")} className="mt-1 size-4 accent-accent" />
          <span>
            <span className="font-medium">Rates in effect on each order&apos;s ship date</span>
            <span className="block text-muted">
              Historical view. Orders without a date cannot be priced this way.
              {p.earliestRatesDate && p.firstOrderDate && p.firstOrderDate < p.earliestRatesDate ? ` Your rates start on ${p.earliestRatesDate}; orders before that date (the file starts ${p.firstOrderDate}) cannot be priced this way.` : ""}
            </span>
          </span>
        </label>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">Shipping service</legend>
        <Field
          id={`${id}-override`}
          label={whatIfOnly ? "Price every shipment on one service (what-if)" : `Service for the ${p.unmappedShipments.toLocaleString("en-US")} shipments whose service is not mapped`}
          hint={whatIfOnly ? "Leave empty to price each shipment on the service in the file." : "Leave empty to keep the services in the file; unmapped shipments are then excluded and listed."}
        >
          {(aria) => (
            <Select {...aria} name="serviceOverrideId" defaultValue={override} onChange={(e) => setOverride(e.target.value)}>
              <option value="">Keep the services in the file</option>
              {p.services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <input type="hidden" name="unmappedPolicy" value={override ? "use_override" : "exclude"} />
        {override && whatIfOnly ? (
          <>
            <input type="hidden" name="overrideAllServices" value="on" />
            <p className="text-sm text-muted">Every shipment will be priced on {overrideName ?? "that service"}, whatever the file says: a what-if, not what was shipped.</p>
          </>
        ) : null}
        {override && !whatIfOnly ? (
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input type="checkbox" name="overrideAllServices" checked={overrideAll} onChange={(e) => setOverrideAll(e.target.checked)} className="size-5 accent-accent" />
            Also price the shipments whose service is mapped on {overrideName ?? "this service"} (what-if comparison)
          </label>
        ) : null}
      </fieldset>

      {p.askResidential || p.askOrigin ? (
        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">What the file does not say</legend>
          {p.askResidential ? (
            <Field id={`${id}-res`} label="Deliveries to homes or businesses?" hint="The file has no residential flag. Residential surcharges priced on this choice are shown as estimates.">
              {(aria) => (
                <Select {...aria} name="residentialDefault" defaultValue={residentialInitial}>
                  <option value="yes">Treat all orders as home deliveries (most online orders are)</option>
                  <option value="no">Treat all orders as business deliveries</option>
                </Select>
              )}
            </Field>
          ) : null}
          {p.askOrigin ? (
            <Field id={`${id}-origin`} label="Ships from ZIP code" error={state.errors?.originZipDefault} hint={p.defaultOriginZip ? `${p.tenantName} set ${p.defaultOriginZip} as the ship-from ZIP; change it if these orders ship from elsewhere.` : `${p.tenantName} has not set a ship-from ZIP; enter the warehouse ZIP these orders ship from.`}>
              {(aria) => <Input {...aria} name="originZipDefault" inputMode="numeric" defaultValue={state.values?.originZipDefault ?? init.originZipDefault ?? p.defaultOriginZip ?? ""} placeholder="e.g. 90001" maxLength={5} />}
            </Field>
          ) : null}
        </fieldset>
      ) : null}

      {!p.projectId ? (
        <Field id={`${id}-name`} label="Scenario name (optional)" hint="Leave empty for a name built from the file and your choices.">
          {(aria) => <Input {...aria} name="name" maxLength={160} defaultValue={state.values?.name ?? ""} placeholder="e.g. Q1 orders, current rates" />}
        </Field>
      ) : null}
    </>
  );
}

function StartButton({ children, onClick }: { children: ReactNode; onClick: (e: MouseEvent<HTMLButtonElement>) => void }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" loading={pending} onClick={onClick}>
      {pending ? "Starting…" : children}
    </Button>
  );
}

const FULFILLMENT_KEY = "fulfillment";

/** Server field errors for the step: "fulfillment.drivers.x" → "drivers.x"; "fulfillment" stays the step-level message. */
function stepErrorsFrom(errors: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, message] of Object.entries(errors ?? {})) {
    if (key === FULFILLMENT_KEY) out[FULFILLMENT_KEY] = message;
    else if (key.startsWith(`${FULFILLMENT_KEY}.`)) out[key.slice(FULFILLMENT_KEY.length + 1)] = message;
  }
  return out;
}

/** Step 1 (shipping settings) then step 2 (fulfillment costs) in one form. */
function TwoStepFields(p: RunSetupProps & { setup: RunSetupData; schedule: Extract<RunSetupData["schedule"], { status: "ok" }> }) {
  const id = useId();
  const state = useFormState();
  const { setup, schedule } = p;
  const audience = p.audience ?? (p.brandId ? "staff" : "brand");
  const [step, setStep] = useState<1 | 2>(1);
  const shippingHeading = useRef<HTMLHeadingElement>(null);
  const fulfillmentHeading = useRef<HTMLHeadingElement>(null);
  const stepTwo = useRef<HTMLDivElement>(null);

  const ctx: FulfillmentFormContext = useMemo(
    () => ({
      questions: schedule.questions,
      canDeriveVolume: derivePeriodVolume(setup.period).ok,
      showPackaging: setup.untypedPackages && schedule.packagingTypes.length > 0,
      showContent: (!setup.hasUnits || !setup.hasLines) && schedule.readsOrderContent,
    }),
    [schedule, setup],
  );
  const [answers, setAnswers] = useState<FulfillmentFormState>(() => initialFulfillmentState(ctx, p.initial?.fulfillment));
  const [showErrors, setShowErrors] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});

  // A new server response: show its step-2 errors on step 2, step-1 errors on step 1 (adjusting state while rendering, as React documents).
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    const forStep = stepErrorsFrom(state.errors);
    setServerErrors(forStep);
    if (Object.keys(forStep).length > 0) setStep(2);
    else if (state.errors && Object.keys(state.errors).length > 0) setStep(1);
  }

  const update: Dispatch<SetStateAction<FulfillmentFormState>> = (next) => {
    setServerErrors({});
    setAnswers(next);
  };

  const built = useMemo(() => fulfillmentFromState(answers, ctx), [answers, ctx]);
  const blocked = Object.keys(built.errors).length;
  const visibleErrors = { ...serverErrors, ...(showErrors ? built.errors : {}) };
  const labels = useMemo(() => Object.fromEntries(schedule.questions.map((q) => [q.key, q.label])), [schedule]);
  // The line compares the fulfillment answers only (the shipping settings of step 1 are not part of it), so "no changes" says which answers.
  const diffLines = p.projectId && blocked === 0 ? diffAssumptions({ fulfillment: p.initial?.fulfillment }, { fulfillment: built.value }, { labels }) : null;
  const diff = diffLines === null ? null : diffLines.length > 0 ? formatAssumptionDiff(diffLines) : "Your fulfillment answers are the same as in the last run.";

  const goTo = (next: 1 | 2) => {
    flushSync(() => setStep(next));
    (next === 2 ? fulfillmentHeading : shippingHeading).current?.focus();
  };

  const onStart = (e: MouseEvent<HTMLButtonElement>) => {
    if (blocked === 0) return;
    // A blank number with no choice never reaches the server: the controls that need attention are marked and the first one is focused.
    e.preventDefault();
    flushSync(() => setShowErrors(true));
    stepTwo.current?.querySelector<HTMLElement>('[data-invalid="true"], [aria-invalid="true"]')?.focus();
  };

  const onStepOneKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" && e.target instanceof HTMLInputElement && e.target.type !== "radio" && e.target.type !== "checkbox") {
      e.preventDefault();
      goTo(2);
    }
  };

  return (
    <>
      <Identity {...p} />
      <input type="hidden" name={FULFILLMENT_KEY} value={JSON.stringify(built.value)} />

      <div hidden={step !== 1} className="space-y-6" onKeyDown={onStepOneKeyDown}>
        <div>
          <p className="text-sm font-medium text-muted">Step 1 of 2</p>
          <h3 ref={shippingHeading} tabIndex={-1} className="text-base font-semibold tracking-tight outline-none">
            Shipping settings
          </h3>
        </div>
        <ResetSafe>
          <ShippingFields {...p} />
        </ResetSafe>
        <Button onClick={() => goTo(2)}>Continue to fulfillment costs</Button>
      </div>

      <div ref={stepTwo} hidden={step !== 2} className="space-y-6">
        <p className="text-sm font-medium text-muted">Step 2 of 2</p>
        <ResetSafe>
          <FulfillmentStep
            id={`${id}-fulfillment`}
            audience={audience}
            schedule={schedule}
            period={setup.period}
            showPackaging={ctx.showPackaging}
            showContent={ctx.showContent}
            state={answers}
            setState={update}
            errors={visibleErrors}
            headingRef={fulfillmentHeading}
          />
        </ResetSafe>
        {!answers.skip && diff ? (
          <p className="text-sm" aria-live="polite">
            {diff}
          </p>
        ) : null}
        {!answers.skip && showErrors && blocked > 0 ? (
          <Alert tone="danger">{blocked === 1 ? "One answer needs attention before the run can start." : `${blocked} answers need attention before the run can start.`}</Alert>
        ) : null}
        {visibleErrors[FULFILLMENT_KEY] ? <Alert tone="danger">{visibleErrors[FULFILLMENT_KEY]}</Alert> : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={() => goTo(1)}>
            Back to shipping settings
          </Button>
          {step === 2 ? <StartButton onClick={onStart}>{p.projectId ? "Run again with these settings" : "Run the model"}</StartButton> : null}
        </div>
      </div>
    </>
  );
}
