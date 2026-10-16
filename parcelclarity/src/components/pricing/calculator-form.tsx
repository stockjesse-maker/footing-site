"use client";

import { useEffect, useId, useMemo, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { loadCalculatorBox, priceShipment, type CalculatorRequest, type CalculatorResponse } from "@/app/actions/calculator";
import { saveSingleScenario } from "@/app/actions/modeling";
import { useLocalToday } from "@/components/forms/local-today";
import type { ResultAudience } from "@/components/pricing/calculation-result";
import { CalculationResult, ESTIMATE_NOTICE, feesTotalText, formatDecimal, formatMoney } from "@/components/pricing/calculation-result";
import { Alert } from "@/components/ui/alert";
import { Badge, statusTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/field";
import type { ShipmentCalculation, SignatureOption, WeightUnit } from "@/engine/types";
import { formatDate } from "@/lib/format/date";
import {
  PACKAGING_OTHER,
  boxFromDrafts,
  describeBox,
  emptyBoxDrafts,
  type BoxDrafts,
  type BoxFieldRef,
  type CalculatorBoxOptions,
  type CalculatorBoxOptionsOk,
  type CalculatorFeesResponse,
  type OrderFeesView,
} from "@/lib/pricing/calculator-schema";

/**
 * Single-shipment calculator. All state lives in React; the only server round trip is the
 * priceShipment action, which re-checks permissions and loads the rate card under the caller's
 * Row Level Security. Pages pass plain, serialisable rate-card summaries.
 */

export interface CalculatorService {
  serviceId: string;
  carrierCode: string;
  code: string;
  name: string;
}

export interface CalculatorVersion {
  id: string;
  versionNumber: number;
  status: string;
  effectiveDate: string | null;
  expirationDate: string | null;
  services: CalculatorService[];
}

export interface CalculatorCard {
  id: string;
  name: string;
  versions: CalculatorVersion[];
}

export interface CalculatorFormProps {
  cards: CalculatorCard[];
  initialRateCardId?: string;
  initialVersionId?: string;
  /** Staff may price against a specific version, including drafts. Brand portals pass false. */
  allowVersionChoice?: boolean;
  /** Customers see plain provenance (no keys, ids or verification badges). */
  audience?: ResultAudience;
  /** Staff pricing on behalf of a customer: that customer's exceptions apply and results can be saved for them. */
  brandId?: string;
  /** Offer "Save as scenario" for single-service results (brand portal and on-behalf pricing). */
  canSave?: boolean;
}

interface PackageDraft {
  key: number;
  weight: string;
  weightUnit: WeightUnit;
  length: string;
  width: string;
  height: string;
  declaredValue: string;
}

type DestinationMode = "zip" | "zone";
type FieldErrors = Record<string, string>;

const SIGNATURE_OPTIONS: { value: SignatureOption; label: string }[] = [
  { value: "none", label: "No signature" },
  { value: "indirect", label: "Indirect signature" },
  { value: "direct", label: "Direct signature" },
  { value: "adult", label: "Adult signature" },
];

const DECIMAL = /^\d+(\.\d+)?$/;
const DIMS = ["length", "width", "height"] as const;

const newPackage = (key: number): PackageDraft => ({ key, weight: "", weightUnit: "lb", length: "", width: "", height: "", declaredValue: "" });

/** "1,234.50" → "1234.50"; ".5" → "0.5"; "5." → "5". Returns the cleaned text, valid or not. */
function cleanDecimal(raw: string): string {
  let v = raw.trim().replace(/[$,\s]/g, "");
  if (v.startsWith(".")) v = `0${v}`;
  if (v.endsWith(".")) v = v.slice(0, -1);
  return v;
}

/** 5-digit ZIP, accepting ZIP+4 input. Returns null when not a US ZIP. */
function cleanZip(raw: string): string | null {
  const v = raw.trim().replace(/-\d{4}$/, "");
  return /^\d{5}$/.test(v) ? v : null;
}


/** The inputs a result rests on, echoed in plain words so an assumption left at its default is visible. */
function describeRequest(r: CalculatorRequest, boxOptions?: CalculatorBoxOptionsOk | null): string {
  const destination = r.destinationZone ? `zone ${r.destinationZone}` : (r.destinationZip ?? "?");
  const packages = r.packages.map((p) => `${formatDecimal(p.weight)} ${p.weightUnit}${p.length && p.width && p.height ? ` (${formatDecimal(p.length)}×${formatDecimal(p.width)}×${formatDecimal(p.height)} in)` : ", no dimensions"}`).join("; ");
  const options = [r.residential ? "home delivery" : "business delivery", r.signature !== "none" ? `${r.signature.replace(/_/g, " ")} signature` : null, r.saturdayDelivery ? "Saturday delivery" : null].filter(Boolean).join(", ");
  const box = r.box ? ` In the box: ${describeBox(r.box, boxOptions)}.` : "";
  return `From ${r.originZip} to ${destination} · ${options} · ${r.packages.length === 1 ? "1 package" : `${r.packages.length} packages`}: ${packages}.${box}`;
}

function effectivity(v: { effectiveDate: string | null; expirationDate: string | null }): string {
  if (!v.effectiveDate) return "dates set at activation";
  return v.expirationDate ? `${formatDate(v.effectiveDate)} – ${formatDate(v.expirationDate)}` : `from ${formatDate(v.effectiveDate)}`;
}

function versionInEffect(versions: CalculatorVersion[], shipDate: string): CalculatorVersion | undefined {
  if (!shipDate) return undefined;
  return versions.find((v) => v.status === "active" && v.effectiveDate !== null && v.effectiveDate <= shipDate && (!v.expirationDate || v.expirationDate >= shipDate));
}

// ---------------------------------------------------------------------------
// Controls not covered by the shared Field helpers: switch and segmented toggle
// ---------------------------------------------------------------------------

function ToggleField({ id, label, hint, checked, onChange }: { id: string; label: string; hint?: string; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium select-none">
        <input id={id} type="checkbox" role="switch" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-describedby={hint ? `${id}-hint` : undefined} />
        <span
          aria-hidden="true"
          className="relative inline-block h-7 w-12 shrink-0 rounded-full bg-line-strong transition-colors peer-checked:bg-accent peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent after:absolute after:top-0.5 after:left-0.5 after:size-6 after:rounded-full after:bg-raised after:shadow-card after:transition-transform peer-checked:after:translate-x-5 motion-reduce:after:transition-none"
        />
        <span>{label}</span>
      </label>
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function SegmentedToggle<T extends string>({ name, legend, value, options, onChange }: { name: string; legend: string; value: T; options: { value: T; label: string }[]; onChange: (next: T) => void }) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="block text-sm font-medium">{legend}</legend>
      <div className="inline-flex w-full rounded-control bg-surface p-1 sm:w-auto">
        {options.map((o) => (
          <label key={o.value} className="flex-1 cursor-pointer sm:flex-none">
            <input type="radio" name={name} value={o.value} className="peer sr-only" checked={value === o.value} onChange={() => onChange(o.value)} />
            <span className="flex min-h-11 items-center justify-center rounded-lg px-5 text-sm font-medium text-muted transition-colors select-none peer-checked:bg-raised peer-checked:text-fg peer-checked:shadow-card peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent">
              {o.label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Package row
// ---------------------------------------------------------------------------

function PackageRow({
  index,
  pkg,
  removable,
  errors,
  onChange,
  onRemove,
  idPrefix,
}: {
  index: number;
  pkg: PackageDraft;
  removable: boolean;
  errors: FieldErrors;
  onChange: (patch: Partial<PackageDraft>) => void;
  onRemove: () => void;
  idPrefix: string;
}) {
  const p = `${idPrefix}-pkg-${pkg.key}`;
  const e = (field: string) => errors[`packages.${index}.${field}`];
  const dimsError = e("dimensions");
  return (
    <div className="space-y-4 rounded-control border border-line bg-surface p-4">
      <div className="flex min-h-9 items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Package {index + 1}</h3>
        {removable ? (
          <Button type="button" size="sm" className="min-h-11 sm:min-h-9" variant="ghost" onClick={onRemove} aria-label={`Remove package ${index + 1}`}>
            Remove
          </Button>
        ) : null}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid grid-cols-[1fr_6.5rem] gap-2">
          <Field id={`${p}-weight`} label="Weight" error={e("weight")}>
            {(aria) => <Input {...aria} type="text" inputMode="decimal" autoComplete="off" placeholder="e.g. 2.5" value={pkg.weight} onChange={(ev) => onChange({ weight: ev.target.value })} />}
          </Field>
          <Field id={`${p}-unit`} label="Unit">
            {(aria) => (
              <Select {...aria} value={pkg.weightUnit} onChange={(ev) => onChange({ weightUnit: ev.target.value === "oz" ? "oz" : "lb" })}>
                <option value="lb">lb</option>
                <option value="oz">oz</option>
              </Select>
            )}
          </Field>
        </div>
        <Field id={`${p}-declaredValue`} label="Declared value (USD, optional)" error={e("declaredValue")}>
          {(aria) => <Input {...aria} type="text" inputMode="decimal" autoComplete="off" placeholder="e.g. 150" value={pkg.declaredValue} onChange={(ev) => onChange({ declaredValue: ev.target.value })} />}
        </Field>
      </div>
      <div className="space-y-1.5">
        <div className="grid grid-cols-3 gap-2">
          {DIMS.map((dim) => (
            <Field key={dim} id={`${p}-${dim}`} label={`${dim[0]!.toUpperCase()}${dim.slice(1)} (in)`} error={e(dim)}>
              {(aria) => (
                <Input
                  {...aria}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  aria-invalid={dimsError || e(dim) ? true : undefined}
                  aria-describedby={[aria["aria-describedby"], dimsError ? `${p}-dims-error` : null].filter(Boolean).join(" ") || undefined}
                  value={pkg[dim]}
                  onChange={(ev) => onChange({ [dim]: ev.target.value })}
                />
              )}
            </Field>
          ))}
        </div>
        {dimsError ? (
          <p id={`${p}-dims-error`} role="alert" className="text-sm font-medium text-danger">
            {dimsError}
          </p>
        ) : (
          <p className="text-sm text-muted">Enter all three for dimensional weight, or leave them empty to price on actual weight.</p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// What's in the box
// ---------------------------------------------------------------------------

const boxFieldId = (idPrefix: string, field: BoxFieldRef): string => (field.startsWith("count:") ? `${idPrefix}-box-count-${field.slice("count:".length)}` : `${idPrefix}-box-${field}`);

/**
 * The block that feeds the order fees: items, different products, packaging and the per-order counts the
 * fee schedule in effect on the ship date asks for. Fields the schedule does not need are not shown.
 */
export function BoxBlock({
  idPrefix,
  options,
  drafts,
  errors,
  packageCount,
  onChange,
}: {
  idPrefix: string;
  options: CalculatorBoxOptionsOk;
  drafts: BoxDrafts;
  errors: Record<string, string>;
  packageCount: number;
  onChange: (patch: Partial<BoxDrafts>) => void;
}) {
  const id = (field: BoxFieldRef) => boxFieldId(idPrefix, field);
  const showPackaging = options.packaging.length > 0 || options.allowOtherPackaging;
  return (
    <fieldset className="space-y-4">
      <legend className="text-sm font-semibold">What&apos;s in the box</legend>
      <p className="text-sm text-muted">
        Fee schedule <span className="font-medium text-fg">{options.scheduleName}</span>, in effect from {formatDate(options.effectiveDate)}. Enter the items to see order fees for this order; monthly charges are not included.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${idPrefix}-box-units`} label="Items (units)" error={errors["box.units"]} hint="Total units in the box, across all products.">
          {(aria) => <Input {...aria} type="text" inputMode="numeric" autoComplete="off" placeholder="e.g. 3" value={drafts.units} onChange={(e) => onChange({ units: e.target.value })} />}
        </Field>
        <Field id={`${idPrefix}-box-products`} label="Different products" error={errors["box.products"]} hint="How many different products (SKUs), however many of each.">
          {(aria) => <Input {...aria} type="text" inputMode="numeric" autoComplete="off" placeholder="e.g. 2" value={drafts.products} onChange={(e) => onChange({ products: e.target.value })} />}
        </Field>
        {options.showLines ? (
          <Field id={`${idPrefix}-box-lines`} label="Order lines" error={errors["box.lines"]} hint="Lines on the order. A product ordered once is one line.">
            {(aria) => <Input {...aria} type="text" inputMode="numeric" autoComplete="off" placeholder="e.g. 2" value={drafts.lines} onChange={(e) => onChange({ lines: e.target.value })} />}
          </Field>
        ) : null}
        {showPackaging ? (
          <Field id={`${idPrefix}-box-packaging`} label="Packaging" hint={packageCount > 1 ? "Used for every package in this shipment." : "The packaging this order ships in."}>
            {(aria) => (
              <Select {...aria} value={drafts.packaging} onChange={(e) => onChange({ packaging: e.target.value })}>
                <option value="">Not sure</option>
                {options.packaging.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
                {options.allowOtherPackaging ? <option value={PACKAGING_OTHER}>{options.packaging.length ? "Another type (not listed)" : "Packaging used"}</option> : null}
              </Select>
            )}
          </Field>
        ) : null}
        {options.counts.map((c) => (
          <Field
            key={c.key}
            id={id(`count:${c.key}`)}
            label={c.label}
            error={errors[`box.counts.${c.key}`]}
            hint={
              <>
                {c.rate} {c.helpText ? `${c.helpText} ` : ""}Enter 0 if there are none; leave it blank if you are not sure and the fee is left out.
              </>
            }
          >
            {(aria) => (
              <Input
                {...aria}
                type="text"
                inputMode="numeric"
                autoComplete="off"
                placeholder="0"
                value={drafts.counts[c.key] ?? ""}
                onChange={(e) => onChange({ counts: { ...drafts.counts, [c.key]: e.target.value } })}
              />
            )}
          </Field>
        ))}
      </div>
    </fieldset>
  );
}

/** What stands in place of the block when there is no fee schedule to read; never an amount. */
export function BoxNote({ options }: { options: CalculatorBoxOptions }) {
  if (options.status === "no_schedule" || options.status === "not_effective") return <p className="text-sm text-muted">No fee schedule in effect on this date. Only shipping is priced.</p>;
  if (options.status === "load_failed") return <p className="text-sm text-muted">Order fees could not be loaded right now. Shipping can still be priced; change the ship date or reload the page to try again.</p>;
  if (options.status === "ok" && !options.hasOrderFees) return <p className="text-sm text-muted">Fee schedule {options.scheduleName} has no per-order fees; its charges are monthly, so none are added to one order.</p>;
  return null;
}

// ---------------------------------------------------------------------------
// Comparison of several services
// ---------------------------------------------------------------------------

const COMPARE_COLUMNS = "sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]";
/** One more column, "Shipping + order fees", when order fees were computed. */
const COMPARE_COLUMNS_WITH_FEES = "sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)]";

function CompareCell({ label, children, emphasis }: { label: string; children: ReactNode; emphasis?: boolean }) {
  return (
    <span className="flex items-baseline justify-between gap-3 sm:block">
      <span className="text-xs text-muted sm:sr-only">{label}</span>
      <span className={`tabular ${emphasis ? "font-semibold" : ""}`}>{children}</span>
    </span>
  );
}

/** The engine prices each package on its own billable weight; the UI never sums them. Several packages are counted, and the expanded result lists each weight. */
function billableLbCell(result: ShipmentCalculation): string {
  const [first] = result.packages;
  if (!first) return "—";
  return result.packages.length === 1 ? formatDecimal(first.billableLb) : `${result.packages.length} pkgs`;
}

function ComparisonList({
  results,
  fees,
  audience,
  cardName,
  effectiveDate,
  onAddFeeInput,
}: {
  results: ShipmentCalculation[];
  /** Order fees per result (same order as `results`); null when none were computed. */
  fees: (OrderFeesView | null)[] | null;
  audience: ResultAudience;
  cardName: string;
  effectiveDate: string | null;
  onAddFeeInput: (field: BoxFieldRef) => void;
}) {
  const labels =
    audience === "brand"
      ? { expected: "Estimated total", definite: "From your rate card", estimated: "Based on assumptions", conditional: "May be added after shipping" }
      : { expected: "Expected", definite: "Definite", estimated: "Estimated", conditional: "Possible adjustments" };
  const feeLabel = "Shipping + order fees";
  const showFees = !!fees && fees.some((f) => f !== null);
  const columns = showFees ? COMPARE_COLUMNS_WITH_FEES : COMPARE_COLUMNS;
  const sorted = results
    .map((r, i) => ({ r, fees: fees?.[i] ?? null }))
    .sort((a, b) => {
      if (a.r.status !== b.r.status) return a.r.status === "ok" ? -1 : 1;
      return Number(a.r.totals.expected.amount) - Number(b.r.totals.expected.amount) || (a.r.service?.serviceName ?? "").localeCompare(b.r.service?.serviceName ?? "");
    });
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted">
        {ESTIMATE_NOTICE} Sorted by expected shipping cost; open a service for the full breakdown.
        {showFees ? " Order fees are for the box described above; monthly charges are not included." : ""}
      </p>
      <div className={`hidden gap-3 px-5 text-xs font-medium text-muted sm:grid ${columns}`} aria-hidden="true">
        <span>Service</span>
        <span>Status</span>
        <span>Billable lb (1 pkg)</span>
        <span>{labels.expected}</span>
        <span>{labels.definite}</span>
        <span>{labels.estimated}</span>
        <span>{labels.conditional}</span>
        {showFees ? <span>{feeLabel}</span> : null}
      </div>
      {sorted.map(({ r, fees: feeView }) => {
        const ok = r.status === "ok";
        const name = r.service?.serviceName ?? r.input.serviceCode;
        return (
          <details key={`${r.input.carrierCode}/${r.input.serviceCode}`} className="group rounded-card border border-line bg-raised shadow-card">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 px-5 py-4 [&::-webkit-details-marker]:hidden">
              <span className={`grid min-w-0 flex-1 gap-1.5 sm:items-center sm:gap-3 ${columns}`}>
                <span className="min-w-0 font-medium break-words">{name}</span>
                <span className="flex items-baseline justify-between gap-3 sm:block">
                  <span className="text-xs text-muted sm:sr-only">Status</span>
                  <Badge tone={ok ? "success" : "warning"}>{ok ? "Priced" : "Unavailable"}</Badge>
                </span>
                <CompareCell label="Billable lb (1 pkg)">{ok ? billableLbCell(r) : "—"}</CompareCell>
                <CompareCell label={labels.expected} emphasis>
                  {ok ? formatMoney(r.totals.expected) : "—"}
                </CompareCell>
                <CompareCell label={labels.definite}>{ok ? formatMoney(r.totals.definite) : "—"}</CompareCell>
                <CompareCell label={labels.estimated}>{ok ? formatMoney(r.totals.estimated) : "—"}</CompareCell>
                <CompareCell label={labels.conditional}>{ok ? formatMoney(r.totals.conditionalExposure) : "—"}</CompareCell>
                {showFees ? (
                  <CompareCell label={feeLabel} emphasis>
                    {ok ? feesTotalText(feeView) : "—"}
                  </CompareCell>
                ) : null}
              </span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-5 shrink-0 text-muted transition-transform group-open:rotate-180 motion-reduce:transition-none">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </summary>
            <div className="border-t border-line px-5 py-5 sm:px-6">
              <CalculationResult result={r} audience={audience} cardName={cardName} effectiveDate={effectiveDate} fees={feeView} onAddFeeInput={onAddFeeInput} />
            </div>
          </details>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

interface PricedRun {
  results: ShipmentCalculation[];
  version: NonNullable<CalculatorResponse["version"]> | null;
  effectiveDate: string | null;
  issues: string[];
  cardName: string;
  shipDate: string;
  request: CalculatorRequest;
  /** Order fees of each result, or why there are none; null when the request carried no box. */
  fees: CalculatorFeesResponse | null;
  /** The box options the request was made with (for the echo), and whether the block was on offer. */
  boxOptions: CalculatorBoxOptionsOk | null;
}

export function CalculatorForm({ cards, initialRateCardId, initialVersionId, allowVersionChoice = true, audience = "staff", brandId, canSave = false }: CalculatorFormProps) {
  const idPrefix = useId();
  const today = useLocalToday();
  const [rateCardId, setRateCardId] = useState(() => (initialRateCardId && cards.some((c) => c.id === initialRateCardId) ? initialRateCardId : (cards[0]?.id ?? "")));
  const [versionId, setVersionId] = useState(() => {
    const card = cards.find((c) => c.id === (initialRateCardId ?? cards[0]?.id));
    return allowVersionChoice && initialVersionId && card?.versions.some((v) => v.id === initialVersionId) ? initialVersionId : "";
  });
  const [shipDateInput, setShipDateInput] = useState<string | null>(null);
  const shipDate = shipDateInput ?? today;
  const [originZip, setOriginZip] = useState("");
  const [destinationMode, setDestinationMode] = useState<DestinationMode>("zip");
  const [destinationZip, setDestinationZip] = useState("");
  const [destinationZone, setDestinationZone] = useState("");
  const [residential, setResidential] = useState(false);
  const [service, setService] = useState("*");
  const [signature, setSignature] = useState<SignatureOption>("none");
  const [saturdayDelivery, setSaturdayDelivery] = useState(false);
  const nextKey = useRef(1);
  const [packages, setPackages] = useState<PackageDraft[]>(() => [newPackage(0)]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [boxDrafts, setBoxDrafts] = useState<BoxDrafts>(emptyBoxDrafts);
  const [boxSubmitted, setBoxSubmitted] = useState(false);
  const [boxFetched, setBoxFetched] = useState<{ key: string; options: CalculatorBoxOptions } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [run, setRun] = useState<PricedRun | null>(null);
  const [pending, startTransition] = useTransition();
  const resultsHeading = useRef<HTMLHeadingElement>(null);

  // Bring each new result into view and hand focus to its heading so screen readers announce it.
  useEffect(() => {
    const heading = resultsHeading.current;
    if (!run || !heading) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    heading.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    heading.focus({ preventScroll: true });
  }, [run]);

  // The fee schedule in effect on the ship date decides whether "What's in the box" is offered and what it asks.
  // Only a customer's calculator (the brand portal, or staff pricing on behalf of one) has a schedule to read.
  const boxKey = (audience === "brand" || brandId) && /^\d{4}-\d{2}-\d{2}$/.test(shipDate) ? `${brandId ?? "self"}|${shipDate}` : null;
  useEffect(() => {
    if (!boxKey) return;
    let cancelled = false;
    loadCalculatorBox({ ...(brandId ? { brandId } : {}), shipDate }).then(
      (options) => {
        if (!cancelled) setBoxFetched({ key: boxKey, options });
      },
      () => {
        if (!cancelled) setBoxFetched({ key: boxKey, options: { status: "load_failed" } });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [boxKey, brandId, shipDate]);
  const boxOptions: CalculatorBoxOptions | null = boxKey && boxFetched?.key === boxKey ? boxFetched.options : null;
  const boxOk = boxOptions?.status === "ok" && boxOptions.hasOrderFees ? boxOptions : null;
  const boxLive = useMemo(() => boxFromDrafts(boxDrafts, boxOk), [boxDrafts, boxOk]);
  // Errors show as the customer types, except "enter the items", which waits for a calculate attempt.
  const boxErrors = useMemo(() => {
    const out = { ...boxLive.errors };
    if (!boxSubmitted && boxDrafts.units.trim() === "") delete out["box.units"];
    return out;
  }, [boxLive.errors, boxSubmitted, boxDrafts.units]);
  const patchBox = (patch: Partial<BoxDrafts>) => setBoxDrafts((d) => ({ ...d, ...patch }));
  const focusBoxField = (field: BoxFieldRef) => {
    const el = document.getElementById(boxFieldId(idPrefix, field));
    el?.scrollIntoView({ block: "center" });
    el?.focus();
  };

  const card = cards.find((c) => c.id === rateCardId);
  const versions = useMemo(() => card?.versions ?? [], [card]);
  const inEffect = useMemo(() => versionInEffect(versions, shipDate), [versions, shipDate]);
  const chosenVersion = versionId ? versions.find((v) => v.id === versionId) : undefined;

  // Services offered: those of the chosen version, else of the version in effect, else every service the card has ever had.
  const services = useMemo(() => {
    const source = chosenVersion ? [chosenVersion] : inEffect ? [inEffect] : versions;
    const seen = new Map<string, CalculatorService>();
    for (const v of source) for (const s of v.services) seen.set(`${s.carrierCode}/${s.code}`, s);
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [chosenVersion, inEffect, versions]);
  const serviceValue = service === "*" || services.some((s) => `${s.carrierCode}/${s.code}` === service) ? service : "*";

  const selectCard = (id: string) => {
    setRateCardId(id);
    setVersionId("");
    setService("*");
    setErrors({});
  };

  const updatePackage = (key: number, patch: Partial<PackageDraft>) => setPackages((list) => list.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  const addPackage = () => setPackages((list) => (list.length >= 50 ? list : [...list, newPackage(nextKey.current++)]));
  const removePackage = (key: number) => setPackages((list) => (list.length > 1 ? list.filter((p) => p.key !== key) : list));

  const buildRequest = (): { ok: true; request: CalculatorRequest } | { ok: false; errors: FieldErrors } => {
    const errs: FieldErrors = {};
    if (!rateCardId) errs.rateCardId = "Choose a rate card.";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(shipDate)) errs.shipDate = "Enter the ship date.";
    const origin = cleanZip(originZip);
    if (!origin) errs.originZip = "Enter the 5-digit origin ZIP code.";
    let destZip: string | undefined;
    let destZone: string | undefined;
    if (destinationMode === "zip") {
      const z = cleanZip(destinationZip);
      if (!z) errs.destinationZip = "Enter the 5-digit destination ZIP code.";
      destZip = z ?? undefined;
    } else {
      const z = destinationZone.trim().toUpperCase().replace(/^ZONE\s*/, "");
      if (!/^[A-Z0-9]{1,12}$/.test(z)) errs.destinationZone = "Enter the zone as printed on the rate card, for example 5.";
      destZone = z;
    }
    const reqPackages: CalculatorRequest["packages"] = packages.map((p, i) => {
      const weight = cleanDecimal(p.weight);
      if (!DECIMAL.test(weight) || Number(weight) <= 0) errs[`packages.${i}.weight`] = "Enter the weight as a number above zero.";
      const dims = DIMS.map((d) => cleanDecimal(p[d]));
      const given = dims.filter((d) => d !== "");
      if (given.length > 0 && given.length < 3) errs[`packages.${i}.dimensions`] = "Enter length, width and height, or leave all three empty.";
      DIMS.forEach((d, j) => {
        const v = dims[j] ?? "";
        if (v !== "" && (!DECIMAL.test(v) || Number(v) <= 0)) errs[`packages.${i}.${d}`] = "Enter a number above zero.";
      });
      const declared = cleanDecimal(p.declaredValue);
      if (declared !== "" && !DECIMAL.test(declared)) errs[`packages.${i}.declaredValue`] = "Enter an amount, for example 150 or 150.00.";
      const withDims = given.length === 3;
      return {
        weight,
        weightUnit: p.weightUnit,
        length: withDims ? dims[0] : undefined,
        width: withDims ? dims[1] : undefined,
        height: withDims ? dims[2] : undefined,
        declaredValue: declared || undefined,
      };
    });
    const box = boxFromDrafts(boxDrafts, boxOk);
    Object.assign(errs, box.errors);
    if (Object.keys(errs).length) return { ok: false, errors: errs };
    return {
      ok: true,
      request: {
        rateCardId,
        ...(brandId ? { brandId } : {}),
        versionId: allowVersionChoice && versionId ? versionId : undefined,
        shipDate,
        originZip: origin!,
        destinationZip: destZip,
        destinationZone: destZone,
        residential,
        service: serviceValue,
        signature,
        saturdayDelivery,
        packages: reqPackages,
        ...(box.box ? { box: box.box } : {}),
      },
    };
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    setBoxSubmitted(true);
    const built = buildRequest();
    if (!built.ok) {
      setErrors(built.errors);
      const count = Object.keys(built.errors).length;
      setMessage(`Fix the ${count === 1 ? "field" : `${count} fields`} marked below.`);
      // On a phone the form is several screens tall: bring the first problem into view and hand it focus.
      requestAnimationFrame(() => {
        const first = document.querySelector<HTMLElement>('form [aria-invalid="true"]');
        first?.scrollIntoView({ block: "center" });
        first?.focus();
      });
      return;
    }
    setErrors({});
    const cardName = card?.name ?? "Rate card";
    const requestShipDate = built.request.shipDate;
    const requestBoxOptions = boxOk;
    startTransition(async () => {
      let response: CalculatorResponse;
      try {
        response = await priceShipment(built.request);
      } catch {
        response = { ok: false, message: "The calculation could not be completed. Check your connection and try again." };
      }
      if (!response.ok || !response.results) {
        setMessage(response.message ?? "Something went wrong. Please try again.");
        return;
      }
      setRun({
        results: response.results,
        version: response.version ?? null,
        effectiveDate: response.effectiveDate ?? null,
        cardName,
        shipDate: requestShipDate,
        issues: response.issues ?? [],
        request: built.request,
        fees: response.fees ?? null,
        boxOptions: requestBoxOptions,
      });
    });
  };

  const versionHint = chosenVersion
    ? chosenVersion.status === "draft"
      ? "Pricing against a draft: customers are never priced on drafts."
      : `Version ${chosenVersion.versionNumber}, ${effectivity(chosenVersion)}.`
    : inEffect
      ? `Version ${inEffect.versionNumber} is in effect on the ship date (${effectivity(inEffect)}).`
      : versions.length
        ? "No active version covers this ship date. Pick a version to test it anyway."
        : "This rate card has no versions yet.";

  const feesByService = run?.fees?.status === "computed" ? run.fees.byService : null;

  return (
    <div className="space-y-8">
      <Card>
        <CardTitle>Shipment</CardTitle>
        <CardDescription>Price one shipment from the rate card: base rate, surcharges and fuel under the rules in force on the ship date. The result is an estimate, never an invoice.</CardDescription>
        <form onSubmit={submit} noValidate className="mt-5 space-y-8">
          <fieldset className="space-y-4">
            <legend className="text-sm font-semibold">Pricing</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id={`${idPrefix}-rateCardId`} label="Rate card" error={errors.rateCardId}>
                {(aria) => (
                  <Select {...aria} value={rateCardId} onChange={(e) => selectCard(e.target.value)}>
                    {cards.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {allowVersionChoice ? (
                <Field id={`${idPrefix}-versionId`} label="Version" hint={versionHint}>
                  {(aria) => (
                    <Select {...aria} value={versionId} onChange={(e) => setVersionId(e.target.value)}>
                      <option value="">Version in effect on ship date{inEffect ? ` (version ${inEffect.versionNumber})` : ""}</option>
                      {versions.map((v) => (
                        <option key={v.id} value={v.id}>
                          Version {v.versionNumber} · {v.status} · {effectivity(v)}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              ) : null}
            </div>
          </fieldset>

          <fieldset className="space-y-4">
            <legend className="text-sm font-semibold">Route</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id={`${idPrefix}-shipDate`} label="Ship date" error={errors.shipDate}>
                {(aria) => <Input {...aria} type="date" value={shipDate} onChange={(e) => setShipDateInput(e.target.value)} />}
              </Field>
              <Field id={`${idPrefix}-originZip`} label="Origin ZIP" error={errors.originZip}>
                {(aria) => <Input {...aria} type="text" inputMode="numeric" autoComplete="off" maxLength={10} placeholder="e.g. 90210" value={originZip} onChange={(e) => setOriginZip(e.target.value)} />}
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <SegmentedToggle
                name={`${idPrefix}-destinationMode`}
                legend="Destination"
                value={destinationMode}
                options={[
                  { value: "zip", label: "ZIP" },
                  { value: "zone", label: "Zone" },
                ]}
                onChange={setDestinationMode}
              />
              {destinationMode === "zip" ? (
                <Field id={`${idPrefix}-destinationZip`} label="Destination ZIP" error={errors.destinationZip}>
                  {(aria) => <Input {...aria} type="text" inputMode="numeric" autoComplete="off" maxLength={10} placeholder="e.g. 10001" value={destinationZip} onChange={(e) => setDestinationZip(e.target.value)} />}
                </Field>
              ) : (
                <Field id={`${idPrefix}-destinationZone`} label="Destination zone" error={errors.destinationZone} hint="As printed on the rate card, for example 5.">
                  {(aria) => <Input {...aria} type="text" autoComplete="off" autoCapitalize="characters" maxLength={12} placeholder="e.g. 5" value={destinationZone} onChange={(e) => setDestinationZone(e.target.value)} />}
                </Field>
              )}
            </div>
            <ToggleField id={`${idPrefix}-residential`} label="Residential address" hint="Delivery to a home rather than a business." checked={residential} onChange={setResidential} />
          </fieldset>

          <fieldset className="space-y-4">
            <legend className="text-sm font-semibold">Service and options</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id={`${idPrefix}-service`} label="Service" hint={services.length ? undefined : audience === "staff" ? "No services on this version yet." : "No services are available for this ship date."}>
                {(aria) => (
                  <Select {...aria} value={serviceValue} onChange={(e) => setService(e.target.value)}>
                    <option value="*">Compare all services</option>
                    {services.map((s) => (
                      <option key={`${s.carrierCode}/${s.code}`} value={`${s.carrierCode}/${s.code}`}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field id={`${idPrefix}-signature`} label="Signature">
                {(aria) => (
                  <Select {...aria} value={signature} onChange={(e) => setSignature(SIGNATURE_OPTIONS.find((o) => o.value === e.target.value)?.value ?? "none")}>
                    {SIGNATURE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <ToggleField id={`${idPrefix}-saturday`} label="Saturday delivery" checked={saturdayDelivery} onChange={setSaturdayDelivery} />
          </fieldset>

          <fieldset className="space-y-4">
            <legend className="text-sm font-semibold">Packages</legend>
            <div className="space-y-4">
              {packages.map((p, i) => (
                <PackageRow key={p.key} index={i} pkg={p} removable={packages.length > 1} errors={errors} idPrefix={idPrefix} onChange={(patch) => updatePackage(p.key, patch)} onRemove={() => removePackage(p.key)} />
              ))}
            </div>
            <Button type="button" variant="secondary" onClick={addPackage} disabled={packages.length >= 50}>
              Add a package
            </Button>
          </fieldset>

          {boxOk ? <BoxBlock idPrefix={idPrefix} options={boxOk} drafts={boxDrafts} errors={boxErrors} packageCount={packages.length} onChange={patchBox} /> : boxOptions ? <BoxNote options={boxOptions} /> : null}

          {message ? <Alert tone="danger">{message}</Alert> : null}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <Button type="submit" size="lg" loading={pending} disabled={!cards.length}>
              {pending ? "Calculating…" : "Calculate"}
            </Button>
            <p className="text-sm text-muted">Results are estimates from the rate card and rules in force on the ship date, never an invoice.</p>
          </div>
        </form>
      </Card>

      {run ? (
        <section aria-labelledby={`${idPrefix}-results-heading`} className="space-y-4" aria-busy={pending || undefined}>
          <div>
            <h2 id={`${idPrefix}-results-heading`} ref={resultsHeading} tabIndex={-1} className="scroll-mt-4 text-xl font-semibold tracking-tight outline-none">
              {run.results.length === 1 ? `Result: ${run.results[0]?.service?.serviceName ?? run.results[0]?.input.serviceCode ?? "shipment"}` : `Results: ${run.results.length} services`}
            </h2>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
              <span>{run.cardName}</span>
              {audience === "staff" && run.version ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>Version {run.version.versionNumber}</span>
                  <Badge tone={statusTone(run.version.status)}>{run.version.status}</Badge>
                  <span>{effectivity(run.version)}</span>
                </>
              ) : run.effectiveDate ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>rates effective {formatDate(run.effectiveDate)}</span>
                </>
              ) : null}
              <span aria-hidden="true">·</span>
              <span>Ship date {formatDate(run.shipDate)}</span>
            </p>
            <p className="mt-1 text-sm text-muted">{describeRequest(run.request, run.boxOptions)}</p>
          </div>
          {run.boxOptions && !run.request.box ? <Alert tone="info">Add what&apos;s in the box to see order fees.</Alert> : null}
          {run.fees && run.fees.status !== "computed" ? (
            <Alert tone={run.fees.status === "load_failed" ? "warning" : "info"}>
              {run.fees.status === "load_failed" ? "Order fees could not be calculated right now. The shipping price is unaffected; try again in a moment." : "No fee schedule in effect on this date, so no order fees are included."}
            </Alert>
          ) : null}
          {run.issues.length ? (
            <Alert tone="warning">
              <p className="font-medium">Some surcharge rules could not be applied</p>
              <ul className="mt-1 list-disc pl-5">
                {run.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
              <p className="mt-1">{audience === "staff" ? "The quote below omits them; fix the rules before relying on it." : "The estimate below omits them; ask your 3PL before relying on it."}</p>
            </Alert>
          ) : null}
          {run.results.length === 1 && run.results[0] ? (
            <CalculationResult result={run.results[0]} audience={audience} cardName={run.cardName} effectiveDate={run.effectiveDate} fees={feesByService?.[0] ?? null} onAddFeeInput={focusBoxField} />
          ) : (
            <ComparisonList results={run.results} fees={feesByService} audience={audience} cardName={run.cardName} effectiveDate={run.effectiveDate} onAddFeeInput={focusBoxField} />
          )}
          {canSave && run.results.length === 1 && run.results[0]?.status === "ok" ? <SaveScenarioForm request={run.request} brandId={brandId} /> : null}
          {canSave && run.results.length > 1 ? <p className="text-sm text-muted">To save a result as a scenario, choose one service above and calculate again.</p> : null}
        </section>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Save as scenario
// ---------------------------------------------------------------------------

/** Names and saves the result just shown. The server prices the request again; nothing from the client's copy is stored. */
function SaveScenarioForm({ request, brandId }: { request: CalculatorRequest; brandId?: string }) {
  const id = useId();
  const [name, setName] = useState("");
  const [savedAs, setSavedAs] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const saved = savedAs !== null && savedAs === name.trim();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saved) return;
    startTransition(async () => {
      const response = await saveSingleScenario(request, name, brandId);
      if (response.ok) setSavedAs(name.trim());
      setMessage(response.ok ? { ok: true, text: "Saved. Find it under Saved scenarios." } : { ok: false, text: response.message ?? "The scenario could not be saved." });
    });
  };
  return (
    <Card>
      <CardTitle>Save this result as a scenario</CardTitle>
      <CardDescription>
        Keep it to compare later. It is priced for the ship date you entered ({formatDate(request.shipDate)}) and does not change afterwards.
        {request.box ? " The order fees shown for what's in the box are saved with it; monthly charges are not part of it." : ""}
      </CardDescription>
      <form onSubmit={submit} className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end" noValidate>
        <div className="flex-1">
          <Field id={`${id}-name`} label="Scenario name">
            {(aria) => <Input {...aria} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Typical 3 lb order to the West Coast" maxLength={160} required />}
          </Field>
        </div>
        <Button type="submit" loading={pending} disabled={!name.trim() || saved}>
          {saved ? "Saved" : "Save scenario"}
        </Button>
      </form>
      {message ? (
        <Alert tone={message.ok ? "success" : "danger"} className="mt-3">
          {message.text}
        </Alert>
      ) : null}
    </Card>
  );
}
