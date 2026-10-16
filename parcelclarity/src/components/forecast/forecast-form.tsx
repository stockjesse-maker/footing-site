"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, useTransition, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { loadForecastFormContext, previewForecast, saveForecast, type ForecastPreviewResponse } from "@/app/actions/forecast";
import { useLocalToday } from "@/components/forms/local-today";
import { ForecastResult, UnpriceableTable } from "@/components/forecast/forecast-result";
import {
  PACKAGING_LEAVE_OUT,
  asksOrderContent,
  availableZones,
  buildAssumptions,
  describeShareSum,
  emptyParcel,
  fieldErrorsFromProblems,
  initialFormState,
  preflight,
  reconcileState,
  spreadEvenly,
  type ForecastContext,
  type ForecastFormState,
} from "@/components/forecast/forecast-model";
import type { AddTarget, Audience } from "@/components/forecast/result-model";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/field";
import { contentRows as engineContentRows } from "@/engine/forecast/grid";
import { FORECAST_LIMITS, type ForecastAssumptions } from "@/engine/forecast/types";
import type { DriverQuestion } from "@/lib/fees/queries";
import { formatDate } from "@/lib/format/date";
import type { AnswerChoice } from "@/lib/modeling/assumptions";
import { PACKAGING_OTHER } from "@/lib/pricing/calculator-schema";

/**
 * "Forecast from your assumptions" (Milestone 4, design §7): the customer describes monthly volume
 * and how it splits by parcel, zone, service, home delivery, packages per order and order contents,
 * answers the fee schedule's questions, previews the expected cost per order and saves it. All state
 * lives here; the server prices (`previewForecast`) and stores (`saveForecast`), and re-reads what
 * there is to choose from when the date, ship-from ZIP or rate card changes (`loadForecastFormContext`).
 *
 * Nothing is prefilled that the person has not said (except "no multi-package orders"), a blank
 * required field is named, and a fee that cannot be computed is never turned into $0: the result lists
 * it as not included with its rate and an "Add" prompt that comes back to the field here.
 */

export interface ForecastFormProps {
  audience: Audience;
  /** Staff on behalf of a customer: the customer's brand id. */
  brandId?: string;
  tenantName: string;
  context: ForecastContext;
  /** A saved forecast to start from ("Edit as new forecast"). */
  initial?: ForecastAssumptions | null;
  editedFrom?: { name: string; asOfDate: string } | null;
}

const numberProps = { type: "text", inputMode: "decimal", autoComplete: "off", spellCheck: false } as const;
const wholeProps = { type: "text", inputMode: "numeric", autoComplete: "off", spellCheck: false } as const;

function ErrorText({ id, children }: { id: string; children?: string }) {
  return children ? (
    <p id={id} role="alert" className="text-sm font-medium text-danger">
      {children}
    </p>
  ) : null;
}

function Section({ id, title, description, children }: { id: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-4">
      <Card className="space-y-4">
        <div className="space-y-1">
          <h2 id={`${id}-heading`} tabIndex={-1} className="text-lg font-semibold tracking-tight outline-none">
            {title}
          </h2>
          {description ? <p className="text-sm text-muted">{description}</p> : null}
        </div>
        {children}
      </Card>
    </section>
  );
}

function Choice({ name, checked, onChange, describedBy, children }: { name: string; checked: boolean; onChange: () => void; describedBy?: string; children: ReactNode }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
      <input type="radio" name={name} checked={checked} onChange={onChange} aria-describedby={describedBy} className="size-4 shrink-0 accent-accent" />
      <span>{children}</span>
    </label>
  );
}

/** The live "sums to X%" line with "Spread evenly": the words carry the state, colour only echoes it. */
function ShareTotal({ id, shares, onSpread, error, what }: { id: string; shares: string[]; onSpread: () => void; error?: string; what: string }) {
  const sum = describeShareSum(shares);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <p id={id} aria-live="polite" className={`text-sm ${sum.exact ? "text-muted" : "font-medium text-danger"}`}>
          <span aria-hidden="true">{sum.exact ? "✓ " : "! "}</span>
          {sum.text}
        </p>
        <Button variant="secondary" onClick={onSpread} aria-label={`Spread evenly: ${what} shares`}>
          Spread evenly
        </Button>
      </div>
      {error && !sum.exact ? <ErrorText id={`${id}-error`}>{error}</ErrorText> : null}
    </div>
  );
}

/** The rows with their shares spread evenly: exactly 100.00 in total (see `spreadEvenly`). */
function spreadRows<T extends { sharePct: string }>(rows: T[]): T[] {
  const shares = spreadEvenly(rows.length);
  return rows.map((r, j) => ({ ...r, sharePct: shares[j]! }));
}

function isoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function ForecastForm({ audience, brandId, tenantName, context, initial = null, editedFrom = null }: ForecastFormProps) {
  const id = useId();
  const router = useRouter();
  const today = useLocalToday();
  const you = audience === "brand";
  const [state, setState] = useState<ForecastFormState>(() => initialFormState(context, initial));
  const [ctx, setCtx] = useState<ForecastContext>(context);
  const [hadDefaultOrigin] = useState(context.originZip !== "");
  const asOfDate = state.asOfDate ?? today;
  const patch = (next: Partial<ForecastFormState>) => setState((s) => ({ ...s, ...next }));

  // --- What there is to choose from, re-read when the date, ship-from ZIP or rate card changes ---
  const loaded = useRef(`${context.rateCard.id}|${context.asOfDate}|${context.originZip}`);
  const request = useRef(0);
  const [ctxProblem, setCtxProblem] = useState<string | null>(null);
  const [loadingChoices, startChoices] = useTransition();
  useEffect(() => {
    if (!isoDate(asOfDate)) return;
    const originOk = /^\d{5}$/.test(state.originZip);
    const key = `${state.rateCardId}|${asOfDate}|${originOk ? state.originZip : ctx.originZip}`;
    if (key === loaded.current) return;
    const mine = ++request.current;
    startChoices(async () => {
      const result = await loadForecastFormContext({ asOfDate, originZip: originOk ? state.originZip : undefined, rateCardId: state.rateCardId }, brandId);
      if (mine !== request.current) return;
      if (result.status === "ok") {
        loaded.current = key;
        setCtx(result);
        setCtxProblem(null);
        setState((s) => reconcileState(s, result));
      } else if (result.status === "no_rates" || result.status === "failed") setCtxProblem(result.message);
      else setCtxProblem("No rate card is assigned to this customer.");
    });
  }, [asOfDate, state.originZip, state.rateCardId, ctx.originZip, brandId]);

  // --- Validation, preview, save ---
  const built = useMemo(() => buildAssumptions(state, ctx, asOfDate), [state, ctx, asOfDate]);
  const pre = useMemo(() => preflight(state, ctx), [state, ctx]);
  const key = useMemo(() => JSON.stringify([built.assumptions, state.priceOnlyCovered, ctx.rateCard.id]), [built.assumptions, state.priceOnlyCovered, ctx.rateCard.id]);
  const [attempted, setAttempted] = useState(false);
  const [outcome, setOutcome] = useState<{ key: string; response: ForecastPreviewResponse } | null>(null);
  const [previewing, startPreview] = useTransition();
  const [saving, startSave] = useTransition();
  const [name, setName] = useState("");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});
  const summaryRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLHeadingElement>(null);

  const fresh = outcome !== null && outcome.key === key;
  const serverProblems = useMemo(() => (fresh && outcome.response.status === "invalid" ? fieldErrorsFromProblems(outcome.response.problems) : null), [fresh, outcome]);
  const errors: Record<string, string> = attempted ? { ...(serverProblems?.fields ?? {}), ...built.errors } : {};
  const general = attempted ? [...built.general, ...(serverProblems?.general ?? [])] : [];
  const errorCount = Object.keys(errors).length + general.length;
  const blockedByContext = ctxProblem !== null || ctx.schedule.status === "unavailable" || ctx.services.length === 0;

  useEffect(() => {
    if (fresh && outcome.response.status === "ok") resultRef.current?.focus();
  }, [fresh, outcome]);

  const runPreview = () => {
    setAttempted(true);
    setSaveMessage(null);
    if (!built.assumptions || blockedByContext) {
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }
    const assumptions = built.assumptions;
    const at = key;
    startPreview(async () => {
      const response = await previewForecast(assumptions, brandId, { priceOnlyCovered: state.priceOnlyCovered, rateCardId: ctx.rateCard.id });
      setOutcome({ key: at, response });
    });
  };

  const runSave = () => {
    if (!built.assumptions || !fresh || outcome.response.status !== "ok") return;
    const assumptions = built.assumptions;
    setSaveMessage(null);
    setSaveErrors({});
    startSave(async () => {
      const response = await saveForecast(assumptions, name, brandId, { priceOnlyCovered: state.priceOnlyCovered, rateCardId: ctx.rateCard.id });
      if (response.status === "saved") {
        router.push(response.href);
        return;
      }
      if (response.status === "invalid") {
        const found = fieldErrorsFromProblems(response.problems);
        setSaveErrors(found.fields);
        setSaveMessage(found.general[0] ?? null);
      } else if (response.status === "error") setSaveMessage(response.message);
      else setSaveMessage("Some orders cannot be priced; preview again before saving.");
    });
  };

  // --- "Add" in the result comes back to the field ---
  const focusId = (target: string) => {
    const el = document.getElementById(target);
    if (el) el.focus();
  };
  const onAdd = (target: AddTarget) => {
    if (target.kind === "driver" && ctx.schedule.status === "ok") {
      const index = ctx.schedule.questions.findIndex((q) => q.key === target.key);
      const first = index >= 0 ? document.querySelector<HTMLElement>(`#${CSS.escape(`${id}-q${index}`)} input`) : null;
      if (first) return first.focus();
    }
    focusId(target.kind === "content" ? "forecast-content-heading" : target.kind === "packaging" ? "forecast-parcels-heading" : "forecast-fulfillment-heading");
  };

  // --- Rows ---
  const selectedServiceIds = state.services.map((s) => s.serviceId);
  const zoneSection = availableZones(ctx.services, selectedServiceIds);
  const schedule = ctx.schedule;
  const packaging = schedule.status === "ok" ? schedule : null;
  const showPackaging = packaging !== null && (packaging.packaging.length > 0 || packaging.allowOtherPackaging);
  const showContent = asksOrderContent(ctx, state.fulfillment.skip);
  const multiZero = /^0+(\.0+)?$/.test(state.multiPct.trim());
  const updateParcel = (i: number, next: Partial<ForecastFormState["parcels"][number]>) => setState((s) => ({ ...s, parcels: s.parcels.map((p, j) => (j === i ? { ...p, ...next } : p)) }));
  const updateZone = (i: number, next: Partial<ForecastFormState["zones"][number]>) => setState((s) => ({ ...s, zones: s.zones.map((z, j) => (j === i ? { ...z, ...next } : z)) }));
  const updateService = (i: number, next: Partial<ForecastFormState["services"][number]>) => setState((s) => ({ ...s, services: s.services.map((z, j) => (j === i ? { ...z, ...next } : z)) }));
  const updateContent = (i: number, next: Partial<ForecastFormState["contentRows"][number]>) => setState((s) => ({ ...s, contentRows: s.contentRows.map((r, j) => (j === i ? { ...r, ...next } : r)) }));

  const averages = useMemo(() => {
    if (state.contentMode !== "average") return null;
    const u = state.averageUnits.trim();
    const l = state.averageLines.trim();
    const ok = /^\d{1,5}(\.\d{1,4})?$/;
    if (!ok.test(u) || !ok.test(l) || Number(u) < 1 || Number(l) < 1 || Number(l) > Number(u)) return null;
    try {
      return engineContentRows({ averageUnits: u, averageLines: l });
    } catch {
      return null;
    }
  }, [state.contentMode, state.averageUnits, state.averageLines]);

  const apply = latestOutcome(outcome, fresh);
  const originHint = hadDefaultOrigin ? `Your default is ${context.originZip}. Change it if these orders ship from elsewhere.` : undefined;

  return (
    <form
      className="space-y-6"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        runPreview();
      }}
    >
      {editedFrom ? (
        <Alert tone="info">
          Starting from {editedFrom.name} (priced on {formatDate(editedFrom.asOfDate)}). Saving creates a new forecast; the original stays as it is. The date starts from today.
        </Alert>
      ) : null}

      <Section id="forecast-volume" title="Volume, date and ship-from ZIP" description="How many orders a month, which day's rates and fees to read, and where the orders ship from.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={`${id}-orders`} label="Orders a month" error={errors.monthlyOrders} hint="A whole number from 1 to 5,000,000.">
            {(aria) => <Input {...aria} {...wholeProps} value={state.monthlyOrders} onChange={(e) => patch({ monthlyOrders: e.target.value })} className="max-w-48" />}
          </Field>
          <Field id={`${id}-date`} label="Rates and fees as of" error={errors.asOfDate ?? ctxProblem ?? undefined} hint={`The rate card and fee schedule in effect on this date.${loadingChoices ? " Updating the choices below…" : ""}`}>
            {(aria) => <Input {...aria} type="date" value={asOfDate} onChange={(e) => patch({ asOfDate: e.target.value })} className="max-w-48" />}
          </Field>
          <Field id={`${id}-origin`} label="Ship-from ZIP code" error={errors.originZip} hint={originHint ?? "The 5-digit ZIP code your orders ship from."}>
            {(aria) => <Input {...aria} {...wholeProps} maxLength={5} value={state.originZip} onChange={(e) => patch({ originZip: e.target.value.trim() })} className="max-w-36" />}
          </Field>
          {ctx.cards.length > 1 ? (
            <Field id={`${id}-card`} label="Rate card">
              {(aria) => (
                <Select {...aria} value={state.rateCardId} onChange={(e) => patch({ rateCardId: e.target.value })}>
                  {ctx.cards.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}
        </div>
        {!hadDefaultOrigin && state.originZip === "" ? <Alert tone="warning">No ship-from ZIP code is set for {you ? "your account" : "this customer"}. Enter the ZIP code the orders ship from to continue.</Alert> : null}
        {ctx.warnings.map((w) => (
          <Alert key={w} tone="warning">
            {w}
          </Alert>
        ))}
        {ctx.services.length === 0 ? <Alert tone="warning">No service is available on this rate card for {you ? "you" : "this customer"}, so nothing can be forecast.</Alert> : null}
      </Section>

      <Section id="forecast-parcels" title="Parcels" description="The parcels you ship and the share of orders in each. Each parcel is priced at exactly the weight and size you give.">
        {state.parcels.map((p, i) => {
          const err = (field: string) => errors[`parcels.${i}.${field}`];
          const sizeNeeded = ctx.services.filter((s) => selectedServiceIds.includes(s.serviceId) && !s.dimExempt);
          return (
            <fieldset key={i} className="min-w-0 space-y-3 rounded-control border border-line p-3">
              <legend className="px-1 text-sm font-semibold">Parcel {i + 1}</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id={`${id}-p${i}-weight`} label="Weight (lb)" error={err("weightLb")}>
                  {(aria) => <Input {...aria} {...numberProps} value={p.weightLb} onChange={(e) => updateParcel(i, { weightLb: e.target.value })} className="max-w-36" />}
                </Field>
                <Field id={`${id}-p${i}-share`} label="Share of orders (%)" error={err("sharePct")}>
                  {(aria) => <Input {...aria} {...numberProps} value={p.sharePct} onChange={(e) => updateParcel(i, { sharePct: e.target.value })} className="max-w-36" />}
                </Field>
              </div>
              <div className="space-y-1">
                <div className="grid grid-cols-3 gap-2">
                  {(["lengthIn", "widthIn", "heightIn"] as const).map((field) => (
                    <Field key={field} id={`${id}-p${i}-${field}`} label={field === "lengthIn" ? "Length (in)" : field === "widthIn" ? "Width (in)" : "Height (in)"}>
                      {(aria) => <Input {...aria} {...numberProps} disabled={p.unknownSize} aria-invalid={err("dims") ? true : undefined} aria-describedby={err("dims") ? `${id}-p${i}-dims-error` : undefined} value={p.unknownSize ? "" : p[field]} onChange={(e) => updateParcel(i, { [field]: e.target.value })} />}
                    </Field>
                  ))}
                </div>
                {sizeNeeded.length && !p.unknownSize ? <p className="text-sm text-muted">{sizeNeeded.map((s) => s.name).join(", ")} {sizeNeeded.length === 1 ? "prices" : "price"} by size.</p> : null}
                <ErrorText id={`${id}-p${i}-dims-error`}>{err("dims")}</ErrorText>
                <label className="flex min-h-11 items-center gap-3 text-sm">
                  <input type="checkbox" checked={p.unknownSize} onChange={(e) => updateParcel(i, e.target.checked ? { unknownSize: true, lengthIn: "", widthIn: "", heightIn: "" } : { unknownSize: false })} className="size-5 shrink-0 accent-accent" />
                  I don&apos;t know the size
                </label>
                {p.unknownSize ? <p className="text-sm text-muted">Priced without a size check, so a bulky, light parcel may cost more than shown.</p> : null}
              </div>
              {showPackaging && packaging ? (
                <Field id={`${id}-p${i}-packaging`} label="Packaging" hint="Used to price packaging fees. Parcels left without a packaging type have no packaging fees computed, and the result says so.">
                  {(aria) => (
                    <Select {...aria} value={p.packaging} onChange={(e) => updateParcel(i, { packaging: e.target.value })}>
                      <option value={PACKAGING_LEAVE_OUT}>No packaging fee, or not sure (packaging fees left out)</option>
                      {packaging.packaging.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                      {packaging.allowOtherPackaging ? <option value={PACKAGING_OTHER}>Another type (not listed)</option> : null}
                      {p.packaging !== PACKAGING_LEAVE_OUT && p.packaging !== PACKAGING_OTHER && !packaging.packaging.some((o) => o.value === p.packaging) ? <option value={p.packaging}>{p.packaging}</option> : null}
                    </Select>
                  )}
                </Field>
              ) : null}
              {state.parcels.length > 1 ? (
                <Button variant="ghost" aria-label={`Remove parcel ${i + 1}`} onClick={() => setState((s) => ({ ...s, parcels: s.parcels.filter((_, j) => j !== i) }))}>
                  Remove parcel
                </Button>
              ) : null}
            </fieldset>
          );
        })}
        <ShareTotal id={`${id}-parcels-sum`} shares={state.parcels.map((p) => p.sharePct)} what="parcel" error={errors.parcels} onSpread={() => setState((s) => ({ ...s, parcels: spreadRows(s.parcels) }))} />
        <Button variant="secondary" disabled={state.parcels.length >= FORECAST_LIMITS.parcels} onClick={() => setState((s) => ({ ...s, parcels: [...s.parcels, emptyParcel()] }))}>
          Add a parcel
        </Button>
      </Section>

      <Section id="forecast-services" title="Services" description="The shipping services you use and the share of orders on each.">
        {state.services.map((row, i) => (
          <fieldset key={i} className="min-w-0 space-y-3 rounded-control border border-line p-3">
            <legend className="px-1 text-sm font-semibold">Service {i + 1}</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id={`${id}-s${i}-service`} label="Service" error={errors[`services.${i}.serviceId`]}>
                {(aria) => (
                  <Select {...aria} value={row.serviceId} onChange={(e) => updateService(i, { serviceId: e.target.value })}>
                    <option value="">Choose a service</option>
                    {ctx.services.map((s) => (
                      <option key={s.serviceId} value={s.serviceId} disabled={s.serviceId !== row.serviceId && selectedServiceIds.includes(s.serviceId)}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field id={`${id}-s${i}-share`} label="Share of orders (%)" error={errors[`services.${i}.sharePct`]}>
                {(aria) => <Input {...aria} {...numberProps} value={row.sharePct} onChange={(e) => updateService(i, { sharePct: e.target.value })} className="max-w-36" />}
              </Field>
            </div>
            {state.services.length > 1 ? (
              <Button variant="ghost" aria-label={`Remove service ${i + 1}`} onClick={() => setState((s) => ({ ...s, services: s.services.filter((_, j) => j !== i) }))}>
                Remove service
              </Button>
            ) : null}
          </fieldset>
        ))}
        <ShareTotal id={`${id}-services-sum`} shares={state.services.map((s) => s.sharePct)} what="service" error={errors.services} onSpread={() => setState((s) => ({ ...s, services: spreadRows(s.services) }))} />
        <Button variant="secondary" disabled={state.services.length >= Math.min(FORECAST_LIMITS.services, ctx.services.length)} onClick={() => setState((s) => ({ ...s, services: [...s.services, { serviceId: "", sharePct: "" }] }))}>
          Add a service
        </Button>
      </Section>

      {zoneSection.hidden ? (
        <p className="text-sm text-muted">The services you chose are priced without zones, so there is nothing to say about where orders go.</p>
      ) : (
        <Section id="forecast-zones" title="Where orders go (zones)" description="The shipping zones your orders go to and the share in each. Zone 1 is closest to the ship-from ZIP; higher zones are farther. Only zones your rate card prices are listed.">
          {zoneSection.zones.length === 0 ? <Alert tone="warning">Your rate card prices no zones for the services chosen from this ZIP code.</Alert> : null}
          {state.zones.map((row, i) => (
            <fieldset key={i} className="min-w-0 space-y-3 rounded-control border border-line p-3">
              <legend className="px-1 text-sm font-semibold">Zone {i + 1}</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id={`${id}-z${i}-zone`} label="Zone" error={errors[`zones.${i}.zone`]}>
                  {(aria) => (
                    <Select {...aria} value={row.zone} onChange={(e) => updateZone(i, { zone: e.target.value })}>
                      <option value="">Choose a zone</option>
                      {zoneSection.zones.map((z) => (
                        <option key={z} value={z} disabled={z !== row.zone && state.zones.some((other) => other.zone === z)}>
                          Zone {z}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field id={`${id}-z${i}-share`} label="Share of orders (%)" error={errors[`zones.${i}.sharePct`]}>
                  {(aria) => <Input {...aria} {...numberProps} value={row.sharePct} onChange={(e) => updateZone(i, { sharePct: e.target.value })} className="max-w-36" />}
                </Field>
              </div>
              {state.zones.length > 1 ? (
                <Button variant="ghost" aria-label={`Remove zone ${i + 1}`} onClick={() => setState((s) => ({ ...s, zones: s.zones.filter((_, j) => j !== i) }))}>
                  Remove zone
                </Button>
              ) : null}
            </fieldset>
          ))}
          <ShareTotal id={`${id}-zones-sum`} shares={state.zones.map((z) => z.sharePct)} what="zone" error={errors.zones} onSpread={() => setState((s) => ({ ...s, zones: spreadRows(s.zones) }))} />
          <Button variant="secondary" disabled={state.zones.length >= Math.min(FORECAST_LIMITS.zones, zoneSection.zones.length)} onClick={() => setState((s) => ({ ...s, zones: [...s.zones, { zone: "", sharePct: "" }] }))}>
            Add a zone
          </Button>
        </Section>
      )}

      <Section id="forecast-orders" title="Deliveries and packages" description="How many orders go to homes, and how many ship as more than one package.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={`${id}-res`} label="Orders delivered to homes (%)" error={errors.residentialPct} hint="0 to 100. Orders to homes can cost more than orders to businesses; enter 0 if none go to homes.">
            {(aria) => <Input {...aria} {...numberProps} value={state.residentialPct} onChange={(e) => patch({ residentialPct: e.target.value })} className="max-w-36" />}
          </Field>
          <Field id={`${id}-multi`} label="Orders shipped as several packages (%)" error={errors["multiPackage.pct"]} hint="Each of these orders ships as one shipment of identical packages. 0 means every order is one package.">
            {(aria) => <Input {...aria} {...numberProps} value={state.multiPct} onChange={(e) => patch({ multiPct: e.target.value })} className="max-w-36" />}
          </Field>
          <Field id={`${id}-pkgs`} label="Packages in each of those orders" error={errors["multiPackage.packagesPerOrder"]} hint={`A whole number from ${FORECAST_LIMITS.packagesPerOrderMin} to ${FORECAST_LIMITS.packagesPerOrderMax}.`}>
            {(aria) => <Input {...aria} {...wholeProps} disabled={multiZero} value={state.packagesPerOrder} onChange={(e) => patch({ packagesPerOrder: e.target.value })} className="max-w-24" />}
          </Field>
        </div>
      </Section>

      {showContent ? (
        <Section id="forecast-content" title="What is in a typical order" description={`${you ? "Your" : "The customer's"} fee schedule charges by items, order lines or products. Describe the orders by size, or give averages.`}>
          <fieldset className="min-w-0 border-0 p-0">
            <legend className="sr-only">How to describe a typical order</legend>
            <Choice name={`${id}-content-mode`} checked={state.contentMode === "rows"} onChange={() => patch({ contentMode: "rows" })}>
              Describe typical orders in rows
            </Choice>
            <Choice name={`${id}-content-mode`} checked={state.contentMode === "average"} onChange={() => patch({ contentMode: "average" })}>
              Give averages instead
            </Choice>
          </fieldset>
          {state.contentMode === "rows" ? (
            <div className="space-y-3">
              {state.contentRows.map((row, i) => (
                <fieldset key={i} className="min-w-0 space-y-2 rounded-control border border-line p-3">
                  <legend className="px-1 text-sm font-semibold">Order type {i + 1}</legend>
                  <div className="grid grid-cols-3 gap-2">
                    {(["units", "lines", "sharePct"] as const).map((field) => (
                      <Field key={field} id={`${id}-c${i}-${field}`} label={field === "units" ? "Items" : field === "lines" ? "Lines" : "% of orders"} error={errors[`content.rows.${i}.${field}`]}>
                        {(aria) => <Input {...aria} {...(field === "sharePct" ? numberProps : wholeProps)} value={row[field]} onChange={(e) => updateContent(i, { [field]: e.target.value })} />}
                      </Field>
                    ))}
                  </div>
                  {state.contentRows.length > 1 ? (
                    <Button variant="ghost" aria-label={`Remove row, order type ${i + 1}`} onClick={() => setState((s) => ({ ...s, contentRows: s.contentRows.filter((_, j) => j !== i) }))}>
                      Remove row
                    </Button>
                  ) : null}
                </fieldset>
              ))}
              <ShareTotal id={`${id}-content-sum`} shares={state.contentRows.map((r) => r.sharePct)} what="order type" error={errors["content.rows"]} onSpread={() => setState((s) => ({ ...s, contentRows: spreadRows(s.contentRows) }))} />
              <Button variant="secondary" disabled={state.contentRows.length >= FORECAST_LIMITS.contentRows} onClick={() => setState((s) => ({ ...s, contentRows: [...s.contentRows, { units: "", lines: "", sharePct: "" }] }))}>
                Add a row
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id={`${id}-avg-units`} label="Average items per order" error={errors["content.averageUnits"]}>
                  {(aria) => <Input {...aria} {...numberProps} value={state.averageUnits} onChange={(e) => patch({ averageUnits: e.target.value })} placeholder="e.g. 1.4" className="max-w-36" />}
                </Field>
                <Field id={`${id}-avg-lines`} label="Average order lines per order" error={errors["content.averageLines"]}>
                  {(aria) => <Input {...aria} {...numberProps} value={state.averageLines} onChange={(e) => patch({ averageLines: e.target.value })} placeholder="e.g. 1.2" className="max-w-36" />}
                </Field>
              </div>
              {averages ? (
                <p className="text-sm text-muted" aria-live="polite">
                  That is {averages.map((r) => `${r.sharePct}% of orders with ${r.units} ${r.units === 1 ? "item" : "items"} on ${r.lines} ${r.lines === 1 ? "line" : "lines"}`).join("; ")}, which gives exactly these averages.
                </p>
              ) : null}
            </div>
          )}
        </Section>
      ) : null}

      <Section
        id="forecast-fulfillment"
        title="Fulfillment costs"
        description={
          schedule.status === "ok"
            ? `${you ? "Your" : "The customer's"} fee schedule ${schedule.name} (in effect from ${formatDate(schedule.effectiveDate)}) charges for things beyond shipping. Answer what you know; anything you leave out is shown as not included, never as $0.`
            : undefined
        }
      >
        {schedule.status === "none" ? <p className="text-sm">{tenantName} has not set up a fee schedule for {you ? "you" : "this customer"}, so this forecast covers shipping only.</p> : null}
        {schedule.status === "not_effective" ? (
          <Alert tone="warning">
            The fee schedule {schedule.name} has no fees in effect on {asOfDate && isoDate(asOfDate) ? formatDate(asOfDate) : "that date"}, so this forecast covers shipping only. Choose another date to include fees.
          </Alert>
        ) : null}
        {schedule.status === "unavailable" ? <Alert tone="danger">The fee schedule could not be loaded, so fulfillment costs cannot be forecast right now. Reload the page to try again.</Alert> : null}
        {schedule.status === "ok" ? (
          <>
            <div className="space-y-0.5">
              <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
                <input type="checkbox" checked={state.fulfillment.skip} onChange={(e) => setState((s) => ({ ...s, fulfillment: { ...s.fulfillment, skip: e.target.checked } }))} aria-describedby={`${id}-skip-help`} className="size-5 shrink-0 accent-accent" />
                Skip fulfillment costs (shipping only)
              </label>
              <p id={`${id}-skip-help`} className="pl-8 text-sm text-muted">
                The forecast prices shipping only: no order fees, monthly charges or all-in figure.
              </p>
            </div>
            <fieldset disabled={state.fulfillment.skip} className="min-w-0 space-y-4 border-0 p-0 disabled:opacity-60">
              <legend className="sr-only">Fulfillment cost questions</legend>
              {schedule.questions.map((q, index) => (
                <Question key={q.key} q={q} qid={`${id}-q${index}`} state={state} setState={setState} error={errors[`fulfillment.${q.answers === "orderShares" ? "orderShares" : "drivers"}.${q.key}`]} />
              ))}
              {schedule.questions.length === 0 ? <p className="text-sm text-muted">Your fee schedule has no questions to answer: its fees come from the orders themselves.</p> : null}
            </fieldset>
          </>
        ) : null}
      </Section>

      <Card className="space-y-3">
        <p className="text-sm" aria-live="polite">
          This forecast prices {pre.sentence}.{pre.overLimit ? ` That is more than the limit of ${FORECAST_LIMITS.cells.toLocaleString("en-US")}; use fewer parcel, zone or service rows.` : ""}
        </p>
        {attempted && errorCount > 0 ? (
          <div ref={summaryRef} tabIndex={-1} className="outline-none">
            <Alert tone="danger" title={`Fix ${errorCount === 1 ? "this" : `these ${errorCount}`} before previewing`}>
              <ul className="list-disc space-y-0.5 pl-5">
                {[...general, ...Object.values(errors)].slice(0, 6).map((m, i) => (
                  <li key={`${i}-${m}`}>{m}</li>
                ))}
              </ul>
              {errorCount > 6 ? <p className="mt-1">…and {errorCount - 6} more, marked on the fields.</p> : null}
            </Alert>
          </div>
        ) : null}
        {attempted && errorCount === 0 && blockedByContext ? (
          <div ref={summaryRef} tabIndex={-1} className="outline-none">
            <Alert tone="danger">{ctxProblem ?? (ctx.services.length === 0 ? "No service is available to forecast." : "The fee schedule could not be loaded.")}</Alert>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="lg" loading={previewing}>
            {outcome ? "Preview again" : "Preview forecast"}
          </Button>
          <p className="text-sm text-muted">Nothing is saved until you save it below.</p>
        </div>
      </Card>

      {outcome ? (
        <section aria-labelledby={`${id}-result-heading`} className="space-y-5" aria-busy={previewing || undefined}>
          <h2 id={`${id}-result-heading`} ref={resultRef} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">
            Your forecast
          </h2>
          {!fresh ? <Alert tone="warning">You changed the forecast since this preview. Preview again to update it; saving needs a current preview.</Alert> : null}
          {apply.kind === "ok" ? (
            <div className={fresh ? undefined : "opacity-60"}>
              <ForecastResult data={apply.response.result} audience={audience} onAdd={onAdd} />
            </div>
          ) : null}
          {apply.kind === "blocked" ? (
            <Card className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold tracking-tight">Some orders cannot be priced from your rate card</h3>
                <p className="mt-1 text-sm text-muted">The rate card has to cover every combination you described, or the average would hide a gap. Change the mix, or price only what the rate card covers.</p>
              </div>
              <UnpriceableTable rows={apply.response.unpriceable} sharePct={apply.response.unpriceableSharePct} audience={audience} />
              <label className="flex min-h-11 items-start gap-3 text-sm">
                <input type="checkbox" checked={state.priceOnlyCovered} onChange={(e) => patch({ priceOnlyCovered: e.target.checked })} aria-describedby={`${id}-covered-help`} className="mt-1.5 size-5 shrink-0 accent-accent" />
                <span>
                  <span className="font-medium">Price only what the rate card covers</span>
                  <span id={`${id}-covered-help`} className="block text-muted">
                    Figures are then averages over the orders that can be priced, with nothing estimated for the rest, and there is no all-in figure. Press Preview again after ticking it.
                  </span>
                </span>
              </label>
            </Card>
          ) : null}
          {apply.kind === "invalid" && general.length === 0 && Object.keys(errors).length === 0 ? <Alert tone="danger">{apply.response.problems.slice(0, 4).join(" ")}</Alert> : null}
          {apply.kind === "error" ? <Alert tone="danger">{apply.response.message}</Alert> : null}

          {apply.kind === "ok" ? (
            <Card className="space-y-3" role="group" aria-label="Save this forecast">
              <div>
                <h3 className="text-lg font-semibold tracking-tight">Save this forecast</h3>
                <p className="mt-1 text-sm text-muted">
                  The forecast is priced again when you save and does not change afterwards. {audience === "staff" ? "It stays private to your team until you share it with the customer." : "You can find it under Saved scenarios."}
                </p>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="flex-1">
                  <Field id={`${id}-name`} label="Forecast name" error={saveErrors.name}>
                    {(aria) => <Input {...aria} value={name} onChange={(e) => setName(e.target.value)} maxLength={160} placeholder="e.g. 1,250 orders a month, mostly zone 4" autoComplete="off" />}
                  </Field>
                </div>
                <Button onClick={runSave} loading={saving} disabled={!fresh || name.trim() === ""}>
                  Save forecast
                </Button>
              </div>
              {saveMessage ? <Alert tone="danger">{saveMessage}</Alert> : null}
            </Card>
          ) : null}
        </section>
      ) : null}
    </form>
  );
}

/** The latest outcome as a discriminated union the render reads once (null while there is none). */
function latestOutcome(outcome: { key: string; response: ForecastPreviewResponse } | null, fresh: boolean):
  | { kind: "none" }
  | { kind: "ok"; response: Extract<ForecastPreviewResponse, { status: "ok" }> }
  | { kind: "blocked"; response: Extract<ForecastPreviewResponse, { status: "blocked" }> }
  | { kind: "invalid"; response: Extract<ForecastPreviewResponse, { status: "invalid" }> }
  | { kind: "error"; response: Extract<ForecastPreviewResponse, { status: "error" }> } {
  if (!outcome) return { kind: "none" };
  const r = outcome.response;
  // A stale blocked or invalid outcome says nothing about the current inputs; a stale result stays on screen, dimmed, until the next preview.
  if (!fresh && r.status !== "ok") return { kind: "none" };
  switch (r.status) {
    case "ok":
      return { kind: "ok", response: r };
    case "blocked":
      return { kind: "blocked", response: r };
    case "invalid":
      return { kind: "invalid", response: r };
    default:
      return { kind: "error", response: r };
  }
}

// ---------------------------------------------------------------------------
// One fee schedule question: a number, "not sure" or "we don't use this"
// ---------------------------------------------------------------------------
function unitSuffix(q: DriverQuestion): string {
  if (q.kind === "returns_rate") return "% of orders";
  if (q.billingPeriod === "week") return `${q.unit} per week`;
  if (q.billingPeriod === "day") return `${q.unit} per day`;
  return q.unit;
}

function Question({ q, qid, state, setState, error }: { q: DriverQuestion; qid: string; state: ForecastFormState; setState: Dispatch<SetStateAction<ForecastFormState>>; error?: string }) {
  const describedBy = [q.helpText ? `${qid}-help` : null, error ? `${qid}-err` : null].filter(Boolean).join(" ") || undefined;
  const isShare = q.answers === "orderShares";
  const choice: AnswerChoice | null = isShare ? (state.fulfillment.shares[q.key]?.choice ?? null) : (state.fulfillment.drivers[q.key]?.choice ?? null);
  const patchFulfillment = (fn: (f: ForecastFormState["fulfillment"]) => ForecastFormState["fulfillment"]) => setState((s) => ({ ...s, fulfillment: fn(s.fulfillment) }));
  const setChoice = (next: AnswerChoice) =>
    patchFulfillment((f) => (isShare ? { ...f, shares: { ...f.shares, [q.key]: { sharePct: "", count: "", ...f.shares[q.key], choice: next } } } : { ...f, drivers: { ...f.drivers, [q.key]: { value: "", ...f.drivers[q.key], choice: next } } }));
  const share = state.fulfillment.shares[q.key];
  const driver = state.fulfillment.drivers[q.key];
  return (
    <fieldset id={qid} aria-describedby={describedBy} className="min-w-0 space-y-2 rounded-card border border-line p-4">
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
        <Choice name={qid} checked={choice === "number"} onChange={() => setChoice("number")} describedBy={describedBy}>
          Enter a number
        </Choice>
        {isShare ? (
          <>
            <Input {...numberProps} aria-label={`${q.label}: share of orders, in percent`} aria-invalid={error ? true : undefined} value={share?.sharePct ?? ""} onChange={(e) => patchFulfillment((f) => ({ ...f, shares: { ...f.shares, [q.key]: { count: "", ...f.shares[q.key], choice: "number", sharePct: e.target.value } } }))} className="max-w-24" />
            <span className="text-sm text-muted">% of orders get</span>
            <Input {...wholeProps} aria-label={`${q.label}: ${q.unit} per order`} aria-invalid={error ? true : undefined} value={share?.count ?? ""} onChange={(e) => patchFulfillment((f) => ({ ...f, shares: { ...f.shares, [q.key]: { sharePct: "", ...f.shares[q.key], choice: "number", count: e.target.value } } }))} className="max-w-20" />
            <span className="text-sm text-muted">{q.unit} each</span>
          </>
        ) : (
          <>
            <Input {...numberProps} aria-label={`${q.label}: number of ${q.kind === "returns_rate" ? "percent of orders" : q.unit}`} aria-invalid={error ? true : undefined} value={driver?.value ?? ""} onChange={(e) => patchFulfillment((f) => ({ ...f, drivers: { ...f.drivers, [q.key]: { ...f.drivers[q.key], choice: "number", value: e.target.value } } }))} className="max-w-36" />
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
}
