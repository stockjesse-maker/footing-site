"use client";

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, useTransition, type FormEvent, type ReactNode } from "react";
import { priceShipment, type CalculatorRequest, type CalculatorResponse } from "@/app/actions/calculator";
import { saveSingleScenario } from "@/app/actions/modeling";
import type { ResultAudience } from "@/components/pricing/calculation-result";
import { CalculationResult, ESTIMATE_NOTICE, formatDecimal, formatMoney } from "@/components/pricing/calculation-result";
import { Alert } from "@/components/ui/alert";
import { Badge, statusTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/field";
import type { ShipmentCalculation, SignatureOption, WeightUnit } from "@/engine/types";
import { formatDate } from "@/lib/format/date";

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

/** Today's date in the browser's local calendar; the server renders an empty value to avoid a hydration mismatch. */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const subscribeNever = () => () => {};
const useLocalToday = () => useSyncExternalStore(subscribeNever, localToday, () => "");

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
// Comparison of several services
// ---------------------------------------------------------------------------

const COMPARE_COLUMNS = "sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]";

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

function ComparisonList({ results }: { results: ShipmentCalculation[] }) {
  const sorted = [...results].sort((a, b) => {
    if (a.status !== b.status) return a.status === "ok" ? -1 : 1;
    return Number(a.totals.expected.amount) - Number(b.totals.expected.amount) || (a.service?.serviceName ?? "").localeCompare(b.service?.serviceName ?? "");
  });
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted">{ESTIMATE_NOTICE} Sorted by expected cost; open a service for the full breakdown.</p>
      <div className={`hidden gap-3 px-5 text-xs font-medium text-muted sm:grid ${COMPARE_COLUMNS}`} aria-hidden="true">
        <span>Service</span>
        <span>Status</span>
        <span>Billable lb (1 pkg)</span>
        <span>Expected</span>
        <span>Definite</span>
        <span>Estimated</span>
        <span>Possible adjustments</span>
      </div>
      {sorted.map((r) => {
        const ok = r.status === "ok";
        const name = r.service?.serviceName ?? r.input.serviceCode;
        return (
          <details key={`${r.input.carrierCode}/${r.input.serviceCode}`} className="group rounded-card border border-line bg-raised shadow-card">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 px-5 py-4 [&::-webkit-details-marker]:hidden">
              <span className={`grid min-w-0 flex-1 gap-1.5 sm:items-center sm:gap-3 ${COMPARE_COLUMNS}`}>
                <span className="min-w-0 font-medium break-words">{name}</span>
                <span className="flex items-baseline justify-between gap-3 sm:block">
                  <span className="text-xs text-muted sm:sr-only">Status</span>
                  <Badge tone={ok ? "success" : "warning"}>{ok ? "Priced" : "Unavailable"}</Badge>
                </span>
                <CompareCell label="Billable lb (1 pkg)">{ok ? billableLbCell(r) : "—"}</CompareCell>
                <CompareCell label="Expected" emphasis>
                  {ok ? formatMoney(r.totals.expected) : "—"}
                </CompareCell>
                <CompareCell label="Definite">{ok ? formatMoney(r.totals.definite) : "—"}</CompareCell>
                <CompareCell label="Estimated">{ok ? formatMoney(r.totals.estimated) : "—"}</CompareCell>
                <CompareCell label="Possible adjustments">{ok ? formatMoney(r.totals.conditionalExposure) : "—"}</CompareCell>
              </span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-5 shrink-0 text-muted transition-transform group-open:rotate-180 motion-reduce:transition-none">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </summary>
            <div className="border-t border-line px-5 py-5 sm:px-6">
              <CalculationResult result={r} />
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
  issues: string[];
  cardName: string;
  shipDate: string;
  request: CalculatorRequest;
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
      },
    };
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    const built = buildRequest();
    if (!built.ok) {
      setErrors(built.errors);
      setMessage("Check the highlighted fields.");
      return;
    }
    setErrors({});
    const cardName = card?.name ?? "Rate card";
    const requestShipDate = built.request.shipDate;
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
      setRun({ results: response.results, version: response.version ?? null, cardName, shipDate: requestShipDate, issues: response.issues ?? [], request: built.request });
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
              <Field id={`${idPrefix}-service`} label="Service" hint={services.length ? undefined : "No services on this version yet."}>
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
              {run.version ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>Version {run.version.versionNumber}</span>
                  <Badge tone={statusTone(run.version.status)}>{run.version.status}</Badge>
                  <span>{effectivity(run.version)}</span>
                </>
              ) : null}
              <span aria-hidden="true">·</span>
              <span>Ship date {formatDate(run.shipDate)}</span>
            </p>
          </div>
          {run.issues.length ? (
            <Alert tone="warning">
              <p className="font-medium">Some surcharge rules could not be applied</p>
              <ul className="mt-1 list-disc pl-5">
                {run.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
              <p className="mt-1">The quote below omits them; fix the rules before relying on it.</p>
            </Alert>
          ) : null}
          {run.results.length === 1 && run.results[0] ? (
            <CalculationResult result={run.results[0]} audience={audience} cardName={run.cardName} effectiveDate={run.version?.effectiveDate ?? null} />
          ) : (
            <ComparisonList results={run.results} />
          )}
          {canSave && run.results.length === 1 && run.results[0]?.status === "ok" ? <SaveScenarioForm request={run.request} brandId={brandId} /> : null}
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
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    startTransition(async () => {
      const response = await saveSingleScenario(request, name, brandId);
      setMessage(response.ok ? { ok: true, text: "Saved. Find it under Saved scenarios." } : { ok: false, text: response.message ?? "The scenario could not be saved." });
    });
  };
  return (
    <Card>
      <CardTitle>Save this result as a scenario</CardTitle>
      <CardDescription>Keep it to compare later. It stays priced at today&apos;s rates; re-price it any time.</CardDescription>
      <form onSubmit={submit} className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end" noValidate>
        <div className="flex-1">
          <Field id={`${id}-name`} label="Scenario name">
            {(aria) => <Input {...aria} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Typical 3 lb order to the West Coast" maxLength={160} required />}
          </Field>
        </div>
        <Button type="submit" loading={pending} disabled={!name.trim()}>
          Save scenario
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
