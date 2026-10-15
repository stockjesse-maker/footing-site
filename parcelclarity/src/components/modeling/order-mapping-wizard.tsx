"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { discardDataset, materialiseDataset, saveOrderMapping } from "@/app/actions/modeling";
import { ConfirmAction } from "@/components/forms/confirm-action";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Field, Select } from "@/components/ui/field";
import type { OrderDetection } from "@/lib/orders/mapping";
import type { OrderColumnMap, OrderMapping, OrderValidationReport, ParsedOrder } from "@/lib/orders/types";

/**
 * "How we read your file": the customer confirms which columns mean what, how rows group into
 * shipments and packages, the date format and weight unit, and which of the 3PL's services each
 * shipping method in the file maps to. Then the validation report shows exact counts with a plain
 * derivation ("Does this look right?") before anything is priced.
 */

export interface DatasetValidation extends OrderValidationReport {
  sampleOrders?: ParsedOrder[];
}

export interface OrderMappingWizardProps {
  datasetId: string;
  brandId?: string;
  status: string;
  detected: OrderDetection & { filename?: string };
  mapping: OrderMapping | null;
  validation: DatasetValidation | null;
  services: { id: string; carrierCode: string; name: string }[];
  defaultOriginZip: string | null;
  skuProfileCount: number;
  productsHref: string;
  /** Where a corrected file is uploaded (the hub). */
  uploadHref: string;
  /** Whether a rate card is assigned, so the "ready" copy does not promise a form that is not there. */
  hasCards: boolean;
}

type ColumnField = keyof OrderColumnMap;

const COLUMN_LABELS: Array<[ColumnField, string, string?]> = [
  ["orderId", "Order id"],
  ["shipmentId", "Shipment id", "Leave empty when each order is one shipment."],
  ["orderDate", "Order date"],
  ["shipDate", "Ship date"],
  ["destinationZip", "Destination ZIP"],
  ["originZip", "Origin ZIP", "Where the order shipped from; set a default later if the file has none."],
  ["residential", "Residential / commercial"],
  ["carrier", "Carrier"],
  ["service", "Shipping service / method"],
  ["weight", "Package weight"],
  ["weightUnit", "Weight unit column"],
  ["length", "Length"],
  ["width", "Width"],
  ["height", "Height"],
  ["packageId", "Package id / tracking number"],
  ["sku", "SKU"],
  ["units", "Quantity"],
  ["cancelled", "Cancelled at / status"],
  ["requiresShipping", "Requires shipping (Shopify)"],
  ["packageCount", "Package count"],
  ["country", "Destination country", "Leave empty if every order ships within the US."],
  ["declaredValue", "Declared value"],
  ["packaging", "Packaging type"],
];

/** JSON with object keys sorted at every level, so two equal mappings serialise identically whatever their key order. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));
}

const FORMAT_LABEL: Record<OrderMapping["format"], string> = { generic: "Generic orders file", shopify: "Shopify order export", shiphero: "ShipHero shipment export" };

export function OrderMappingWizard(p: OrderMappingWizardProps) {
  const id = useId();
  const router = useRouter();
  const headers = p.detected.sheets[0]?.headers ?? [];
  const [mapping, setMapping] = useState<OrderMapping>(() => p.mapping ?? p.detected.suggestion ?? emptyMapping(p.detected.sheets[0]?.name ?? "Sheet1"));
  const [message, setMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [preparing, startPreparing] = useTransition();
  const editable = ["uploaded", "mapped", "validated"].includes(p.status);
  // What the saved report describes is the saved mapping; edits on screen make it stale until saved again.
  // (Compared with sorted keys: the stored copy comes back from jsonb in a different key order.)
  const saved = p.mapping ?? p.detected.suggestion;
  const dirty = stable(mapping) !== stable(saved);
  // Where the file cannot decide, the customer must: no silent default for an ambiguous date format or an unstated weight unit.
  const mustChooseDate = p.detected.dateFormatAmbiguous && !p.mapping;
  const mustChooseUnit = mapping.columns.weight !== null && mapping.columns.weightUnit === null && p.detected.weightUnitFromHeader === null && !p.mapping;
  const [dateChosen, setDateChosen] = useState(!mustChooseDate);
  const [unitChosen, setUnitChosen] = useState(!mustChooseUnit);
  const choicesMissing = (mustChooseDate && !dateChosen) || (mustChooseUnit && !unitChosen);
  const sample = p.detected.sheets[0]?.sample ?? [];
  const sampleFor = (column: number | null | undefined) => (column === null || column === undefined ? null : (sample.map((r) => r[column] ?? "").find((cell) => cell !== "") ?? null));

  const setColumn = (field: ColumnField, value: string) => setMapping((m) => ({ ...m, columns: { ...m.columns, [field]: value === "" ? null : Number(value) } }));
  const save = () =>
    startTransition(async () => {
      setMessage(null);
      setStatus(null);
      const r = await saveOrderMapping(p.datasetId, mapping, p.brandId);
      if (!r.ok) {
        setMessage(r.message ?? "The mapping could not be saved.");
        return;
      }
      router.refresh();
      setStatus("Checked. The counts below are updated.");
      // The report sits below ~20 selects on a phone: bring it into view and hand it focus.
      requestAnimationFrame(() => {
        const heading = document.getElementById(`${id}-report`);
        heading?.scrollIntoView({ block: "start" });
        heading?.focus();
      });
    });
  const prepare = () =>
    startPreparing(async () => {
      setMessage(null);
      const r = await materialiseDataset(p.datasetId, p.brandId);
      if (!r.ok) setMessage(r.message ?? "The file could not be prepared.");
      router.refresh();
    });

  const columnOptions = headers.map((h, i) => ({ value: String(i), label: h || `Column ${i + 1}` }));
  const v = p.validation;

  return (
    <div className="space-y-6">
      {editable ? (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>How we read your file</CardTitle>
              <CardDescription>
                {FORMAT_LABEL[mapping.format]}
                {p.detected.filename ? ` · ${p.detected.filename}` : ""} · {p.detected.sheets[0]?.rowCount.toLocaleString("en-US") ?? 0} rows
              </CardDescription>
            </div>
            <Badge tone="accent">{p.status === "validated" ? "Checked" : "Needs review"}</Badge>
          </div>
          {p.detected.notes.length ? (
            <ul className="mt-4 space-y-1 text-sm text-muted">
              {p.detected.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}

          <fieldset className="mt-5 space-y-3">
            <legend className="text-sm font-semibold">Columns</legend>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {COLUMN_LABELS.map(([field, label, hint]) => (
                <Field key={field} id={`${id}-${field}`} label={label} hint={[hint, sampleFor(mapping.columns[field]) ? `e.g. "${sampleFor(mapping.columns[field])}"` : null].filter(Boolean).join(" ") || undefined}>
                  {(aria) => (
                    <Select {...aria} value={mapping.columns[field] === null || mapping.columns[field] === undefined ? "" : String(mapping.columns[field])} onChange={(e) => setColumn(field, e.target.value)}>
                      {field !== "orderId" ? <option value="">Not in the file</option> : null}
                      {columnOptions.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              ))}
            </div>
          </fieldset>

          <fieldset className="mt-6 space-y-3">
            <legend className="text-sm font-semibold">How rows become shipments and packages</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id={`${id}-gs`} label="Shipments">
                {(aria) => (
                  <Select {...aria} value={mapping.grouping.shipments} onChange={(e) => setMapping((m) => ({ ...m, grouping: { ...m.grouping, shipments: e.target.value as OrderMapping["grouping"]["shipments"] } }))}>
                    <option value="by_shipment_id">One per shipment id within an order</option>
                    <option value="one_per_order">One per order</option>
                    <option value="one_per_row">Each row is a shipment</option>
                  </Select>
                )}
              </Field>
              <Field id={`${id}-gp`} label="Packages">
                {(aria) => (
                  <Select {...aria} value={mapping.grouping.packages} onChange={(e) => setMapping((m) => ({ ...m, grouping: { ...m.grouping, packages: e.target.value as OrderMapping["grouping"]["packages"] } }))}>
                    <option value="by_package_columns">From the package columns (id, weight, dimensions)</option>
                    <option value="one_per_shipment">One per shipment</option>
                    <option value="one_per_row">Each row is a package</option>
                  </Select>
                )}
              </Field>
            </div>
          </fieldset>

          <fieldset className="mt-6 space-y-3">
            <legend className="text-sm font-semibold">Formats</legend>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field id={`${id}-df`} label="Dates" hint={p.detected.dateFormatAmbiguous ? "The dates could be month-first or day-first; the file cannot tell. Please choose." : undefined} error={mustChooseDate && !dateChosen ? "Please choose how to read the dates." : undefined}>
                {(aria) => (
                  <Select
                    {...aria}
                    value={mustChooseDate && !dateChosen ? "" : mapping.dateFormat}
                    onChange={(e) => {
                      if (!e.target.value) return;
                      setDateChosen(true);
                      setMapping((m) => ({ ...m, dateFormat: e.target.value as OrderMapping["dateFormat"] }));
                    }}
                  >
                    {mustChooseDate && !dateChosen ? <option value="">— choose —</option> : null}
                    <option value="iso">Year-month-day (2026-03-04)</option>
                    <option value="mdy">Month/day/year (3/4/2026)</option>
                    <option value="dmy">Day/month/year (4/3/2026)</option>
                  </Select>
                )}
              </Field>
              <Field
                id={`${id}-wu`}
                label="Weight unit when not stated"
                hint={v?.weights.medianLb ? `Median weight with your last saved choice: ${v.weights.medianLb} lb. If that looks 16× too heavy, the file is in ounces.` : mustChooseUnit ? "Neither the header nor the cells name a unit. Please choose." : "Pounds unless the header or cells say otherwise."}
                error={mustChooseUnit && !unitChosen ? "Please choose the unit the weights are in." : undefined}
              >
                {(aria) => (
                  <Select
                    {...aria}
                    value={mustChooseUnit && !unitChosen ? "" : mapping.weightUnit}
                    onChange={(e) => {
                      if (!e.target.value) return;
                      setUnitChosen(true);
                      setMapping((m) => ({ ...m, weightUnit: e.target.value as OrderMapping["weightUnit"] }));
                    }}
                  >
                    {mustChooseUnit && !unitChosen ? <option value="">— choose —</option> : null}
                    <option value="lb">Pounds (lb)</option>
                    <option value="oz">Ounces (oz)</option>
                    <option value="g">Grams (converted to lb)</option>
                    <option value="kg">Kilograms (converted to lb)</option>
                  </Select>
                )}
              </Field>
              <div className="space-y-3 pt-7">
                <label className="flex min-h-11 items-center gap-3 text-sm">
                  <input type="checkbox" checked={mapping.padShortZips} onChange={(e) => setMapping((m) => ({ ...m, padShortZips: e.target.checked }))} className="size-5 accent-accent" />
                  Pad 3–4 digit ZIPs to five (spreadsheets drop leading zeros)
                </label>
              </div>
            </div>
          </fieldset>

          {p.detected.serviceStrings.length ? (
            <fieldset className="mt-6 space-y-3">
              <legend className="text-sm font-semibold">Which of your services does each shipping method use?</legend>
              <p className="text-sm text-muted">Shipments with an unmapped method are left out of the model unless you choose a service for them when you run it.</p>
              <div className="grid gap-4 sm:grid-cols-2">
                {p.detected.serviceStrings.map((s) => (
                  <Field key={s.normalized} id={`${id}-svc-${s.normalized.replace(/\s+/g, "-")}`} label={`"${s.text}" (${s.rows.toLocaleString("en-US")} rows)`}>
                    {(aria) => (
                      <Select {...aria} value={mapping.serviceMap[s.normalized] ?? ""} onChange={(e) => setMapping((m) => ({ ...m, serviceMap: { ...m.serviceMap, [s.normalized]: e.target.value || null } }))}>
                        <option value="">Not mapped</option>
                        {p.services.map((svc) => (
                          <option key={svc.id} value={svc.id}>
                            {svc.name}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                ))}
              </div>
            </fieldset>
          ) : null}

          <fieldset className="mt-6 space-y-3">
            <legend className="text-sm font-semibold">Weights the file does not carry</legend>
            <label className="flex min-h-11 items-start gap-3 text-sm">
              <input type="checkbox" checked={mapping.useSkuProfiles} onChange={(e) => setMapping((m) => ({ ...m, useSkuProfiles: e.target.checked }))} className="mt-0.5 size-5 accent-accent" />
              <span>Derive missing package weights from product weights ({p.skuProfileCount.toLocaleString("en-US")} products on file). Prices built on derived weights are shown as estimates.</span>
            </label>
            <a href={p.productsHref} target="_blank" rel="noopener" className="inline-flex min-h-11 items-center text-sm font-medium text-accent-text hover:underline">
              Manage product weights (opens in a new tab, so your choices here are kept)
            </a>
          </fieldset>

          {message ? (
            <Alert tone="danger" className="mt-4">
              {message}
            </Alert>
          ) : null}
          {status ? (
            <Alert tone="success" className="mt-4">
              {status}
            </Alert>
          ) : null}
          <div className="mt-6 flex flex-wrap gap-3">
            <Button onClick={save} loading={pending} disabled={choicesMissing}>
              {p.status === "validated" ? "Save changes and check again" : "Save and check the file"}
            </Button>
            <ConfirmAction action={() => discardDataset(p.datasetId, p.brandId)} label="Discard this file" confirmLabel="Discard" variant="ghost">
              The file and everything read from it are removed.
            </ConfirmAction>
          </div>
          {choicesMissing ? <p className="mt-2 text-sm text-muted">Choose the date format and weight unit above first.</p> : null}
        </Card>
      ) : null}

      {p.status === "ready" ? (
        <Card>
          <CardTitle>How the file was read</CardTitle>
          <CardDescription>
            {FORMAT_LABEL[mapping.format]}
            {p.detected.filename ? ` · ${p.detected.filename}` : ""}. Dates read as {mapping.dateFormat === "iso" ? "year-month-day" : mapping.dateFormat === "mdy" ? "month/day/year" : "day/month/year"}; weights in {mapping.weightUnit} when not stated
            {mapping.useSkuProfiles ? "; missing weights derived from product weights" : ""}. This file is prepared, so how it is read can no longer be changed: to read it differently, upload the corrected file again.
          </CardDescription>
          {message ? (
            <Alert tone="danger" className="mt-4">
              {message}
            </Alert>
          ) : null}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <a href={p.uploadHref} className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
              Upload a corrected file
            </a>
            <ConfirmAction action={() => discardDataset(p.datasetId, p.brandId)} label="Discard this file" confirmLabel="Discard" variant="ghost">
              Removes the file and everything read from it; scenarios built on it must be archived first.
            </ConfirmAction>
          </div>
        </Card>
      ) : null}

      {p.status === "materialising" ? (
        <Card>
          <CardTitle>Preparation did not finish</CardTitle>
          <CardDescription>The file was being prepared when something interrupted it. Prepare it again, or discard it.</CardDescription>
          {message ? (
            <Alert tone="danger" className="mt-4">
              {message}
            </Alert>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-3">
            <Button onClick={prepare} loading={preparing}>
              Prepare again
            </Button>
            <ConfirmAction action={() => discardDataset(p.datasetId, p.brandId)} label="Discard this file" confirmLabel="Discard" variant="ghost">
              The file and everything read from it are removed.
            </ConfirmAction>
          </div>
        </Card>
      ) : null}
      {v ? <ValidationReport report={v} status={p.status} onPrepare={prepare} preparing={preparing} dirty={dirty} hasCards={p.hasCards} headingId={`${id}-report`} /> : null}
    </div>
  );
}

function ValidationReport({ report, status, onPrepare, preparing, dirty, hasCards, headingId }: { report: DatasetValidation; status: string; onPrepare: () => void; preparing: boolean; dirty: boolean; hasCards: boolean; headingId: string }) {
  const c = report.counts;
  const coverage = c.orders ? Math.floor((report.modelableOrders / c.orders) * 1000) / 10 : 0;
  const examplesFor = (code: string) => report.issues.filter((i) => i.code === code).slice(0, 5);
  return (
    <Card>
      <h2 id={headingId} tabIndex={-1} className="scroll-mt-4 text-lg font-semibold tracking-tight outline-none">
        Does this look right?
      </h2>
      {dirty ? (
        <Alert tone="warning" className="mt-3">
          You changed how the file is read. Save and check again to update these numbers; they describe the last saved choices.
        </Alert>
      ) : null}
      <CardDescription>
        {c.orders.toLocaleString("en-US")} orders · {c.shipments.toLocaleString("en-US")} shipments · {c.packages.toLocaleString("en-US")} packages · {c.lines.toLocaleString("en-US")} items from {c.rows.toLocaleString("en-US")} rows
        {report.dateRange.from ? ` · ${report.dateRange.from} to ${report.dateRange.to}` : ""}
      </CardDescription>
      <ul className="mt-3 space-y-1 text-sm text-muted">
        <li>Shipments: {report.derivation.shipments}.</li>
        <li>Packages: {report.derivation.packages}.</li>
        <li>Items: {report.derivation.lines}.</li>
      </ul>
      <p className="mt-4 font-medium">
        {report.modelableOrders.toLocaleString("en-US")} of {c.orders.toLocaleString("en-US")} orders can be priced ({coverage}%)
      </p>
      {report.issuesByCode.length ? (
        <div className="mt-3 overflow-x-auto" tabIndex={0} role="region" aria-label="Issues found in the file">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="py-1 pr-3 font-medium">Issue</th>
                <th className="py-1 pr-3 font-medium">Orders</th>
                <th className="py-1 font-medium">File rows</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {report.issuesByCode.map((i) => (
                <tr key={i.code}>
                  <td className="py-2 pr-3">
                    <Badge tone={i.severity === "error" ? "warning" : "neutral"} className="mr-2">
                      {i.severity === "error" ? "Not priced" : "Note"}
                    </Badge>
                    {i.message}
                    {examplesFor(i.code).length ? (
                      <details className="mt-1">
                        <summary className="inline-flex min-h-11 cursor-pointer items-center text-xs font-medium text-accent-text">Where</summary>
                        <ul className="mt-1 space-y-0.5 text-xs text-muted">
                          {examplesFor(i.code).map((ex, k) => (
                            <li key={k}>
                              {ex.orderId ? `Order ${ex.orderId}` : "File"}
                              {ex.row ? `, row ${ex.row}` : ""}: {ex.message}
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </td>
                  <td className="tabular py-2 pr-3">{i.orders.toLocaleString("en-US")}</td>
                  <td className="tabular py-2">{i.rows.toLocaleString("en-US")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {report.issuesTruncated ? <p className="mt-2 text-xs text-muted">Only the first 500 issues are listed.</p> : null}
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted">No problems found.</p>
      )}
      {report.sampleOrders?.length ? (
        <details className="mt-4">
          <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium text-accent-text">Show the first orders as we read them</summary>
          <ul className="mt-2 space-y-2 text-sm">
            {report.sampleOrders.slice(0, 3).map((o) => (
              <li key={o.externalOrderId} className="rounded-control bg-surface px-3 py-2">
                <span className="font-medium">Order {o.externalOrderId}</span>
                {o.orderDate ? ` · ${o.orderDate}` : ""} · to {o.destinationZip ?? "?"}
                <ul className="mt-1 pl-4 text-muted">
                  {o.shipments.map((s) => (
                    <li key={s.seq}>
                      Shipment {s.externalShipmentId ?? s.seq}: {s.serviceText ?? "no service"} · {s.packages.map((pk) => `${pk.weight ?? "?"} ${pk.weightUnit}${pk.weightDerived ? " (from product weights)" : ""}`).join(", ") || "no packages"}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {status === "validated" ? (
        <Button className="mt-5" onClick={onPrepare} loading={preparing} disabled={dirty}>
          Looks right — prepare for modeling
        </Button>
      ) : null}
      {status === "ready" ? <p className="mt-4 text-sm font-medium">{hasCards ? "Ready to model. Choose the rates below." : "Ready to model once a rate card is assigned to you."}</p> : null}
    </Card>
  );
}

function emptyMapping(sheet: string): OrderMapping {
  return {
    sheet,
    headerRow: 0,
    format: "generic",
    columns: { orderId: 0, shipmentId: null, packageId: null, orderDate: null, shipDate: null, originZip: null, destinationZip: null, country: null, residential: null, carrier: null, service: null, weight: null, weightUnit: null, length: null, width: null, height: null, declaredValue: null, sku: null, units: null, packaging: null, cancelled: null },
    grouping: { shipments: "one_per_order", packages: "one_per_shipment" },
    dateFormat: "iso",
    weightUnit: "lb",
    padShortZips: false,
    serviceMap: {},
    useSkuProfiles: false,
    defaults: { originZip: null, residential: null },
  };
}
