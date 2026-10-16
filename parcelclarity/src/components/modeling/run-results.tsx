import Link from "next/link";
import type { BulkSummary } from "@/engine/modeling/types";
import { formatMoney } from "@/components/pricing/calculation-result";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { formatDate } from "@/lib/format/date";
import { formatVolume } from "@/lib/modeling/assumptions";
import {
  HEADLINE_VIEWS,
  VIEW_LABEL,
  VIEW_SENTENCE,
  feeStatusSentences,
  headlineFigures,
  minimumViews,
  monthlyCharges,
  notIncludedGroups,
  orderFeeRows,
  orderRowFigures,
  ruleNameIndex,
  toCents,
  usd,
  volumeSensitivity,
  type HeadlineAudience,
  type HeadlineFigures,
  type HeadlineView,
  type MinimumView,
} from "@/lib/modeling/headline";

/**
 * Customer-facing results of a bulk run. Every figure comes from the stored summary (decimal
 * strings); nothing is computed here except through the pure helpers of `headline.ts`. The headline
 * always carries its provenance and its caveats; exposure amounts are "up to" figures and are never
 * averaged; a figure that leaves something out says "At least" and names what; an amount that could not
 * be computed is "Not computed", never $0; monthly charges are never presented as per-order fees.
 */

const money = (v: string | null) => (v === null ? "—" : formatMoney({ amount: v, currency: "USD" }));
const n = (v: number) => v.toLocaleString("en-US");
/** "1 shipment", "12 shipments". */
const plural = (count: number, one: string, many = `${one}s`) => `${n(count)} ${count === 1 ? one : many}`;

const EXCLUSION_TEXT: Record<string, string> = {
  order_cancelled: "Cancelled orders",
  date_missing: "No order or ship date (needed to pick the rates of each date)",
  destination_missing: "No destination ZIP code",
  origin_missing: "No origin ZIP code",
  service_unmapped: "Shipping service not mapped to one of your services",
  weight_missing: "No package weight",
  order_inconsistent: "Rows of the order disagree with each other",
  package_inconsistent: "Rows of the same package disagree on weight or size",
  destination_invalid: "Destination ZIP could not be read",
  destination_not_us: "Destination outside the US",
  weight_invalid: "Weight could not be read",
  nothing_to_ship: "Nothing to ship (e.g. gift cards only)",
  sku_unknown: "A product has no weight on file",
  value_out_of_range: "A value was too long or too large to store",
  no_packages: "No packages",
  service_not_on_rate_card: "Service is not on your rate card",
  zone_unresolved: "Destination not covered by the zone chart",
  zone_ambiguous: "Zone could not be decided",
  no_rate_for_weight: "Heavier than the rate card's top bracket",
  no_rate_for_zone: "No rate for that zone",
  no_rate_for_origin: "No rate from that origin",
  rate_card_not_effective: "No rates in effect on that date",
  invalid_input: "A value could not be priced",
};

const WARNING_TEXT: Record<string, string> = {
  dimensions_missing: "No dimensions, so dimensional weight was not checked",
  dim_divisor_missing: "The rate card does not say how to compute dimensional weight for the service",
  zip_list_missing: "A surcharge could not be confirmed for the address and is shown as an estimate",
  unverified_rule_applied: "A surcharge whose source is still being confirmed was applied as an estimate",
  zone_chart_missing: "No zone chart for the carrier",
  rule_overridden: "A pricing exception agreed with your 3PL was applied",
  override_not_applicable: "A pricing exception did not fit the charge it was set for",
  assumed_inputs: "Priced on assumed inputs",
  rule_reference_cycle: "A surcharge could not be decided because of how it is configured",
  rate_card_not_effective: "No rates in effect on the date",
};

export interface RunProvenance {
  scenarioName: string;
  datasetName: string | null;
  rateCardName: string;
  pricingBasis: "ship_date" | "fixed_date";
  asOfDate: string | null;
  serviceOverrideName: string | null;
  /** The override covered every shipment (a what-if), not only the unmapped ones. */
  overrideAllServices: boolean;
  /** What was assumed where the file was silent (null = not applicable). */
  residentialDefault: boolean | null;
  originZipDefault: string | null;
  finishedAt: string | null;
  exportHref: string | null;
  /** Wording and links for the fee-aware parts. */
  audience: HeadlineAudience;
  ordersCsvHref: string | null;
  monthlyCsvHref: string | null;
  /** Where numbers are added: the "run again" section of this page; null when the viewer cannot rerun. */
  addHref: string | null;
  /** "{tenant} fee schedule 'Standard', in effect from Jan 1, 2026"; null when no schedule applied. */
  feeScheduleLine: string | null;
  /** "Fees have changed since this model was priced". */
  feesChanged: boolean;
  /** "Assumptions entered by you on Oct 14, 2026"; null when no fulfillment answers were entered. */
  assumptionsLine: string | null;
  /** A sentence about fee dates no schedule version covered (ship-date basis), or null. */
  uncoveredNote: string | null;
}

function ViewControl({ view, hrefFor }: { view: HeadlineView; hrefFor: (view: HeadlineView) => string }) {
  return (
    <div className="space-y-2">
      <p id="headline-view-label" className="text-sm font-medium">
        Show
      </p>
      <nav aria-labelledby="headline-view-label">
        <ul className="flex flex-wrap gap-2">
          {HEADLINE_VIEWS.map((v) => {
            const selected = v === view;
            return (
              <li key={v}>
                <Link
                  href={hrefFor(v)}
                  scroll={false}
                  aria-current={selected ? "true" : undefined}
                  className={`inline-flex min-h-11 items-center gap-1.5 rounded-control border px-4 text-sm ${selected ? "border-accent bg-accent-soft font-semibold text-accent-text" : "border-line text-fg hover:bg-surface"}`}
                >
                  {selected ? <span aria-hidden="true">✓</span> : null}
                  {VIEW_LABEL[v]}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <p className="text-sm text-muted">{VIEW_SENTENCE}</p>
    </div>
  );
}

function AddLink({ href, name }: { href: string; name: string }) {
  return (
    <Link href={href} className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
      Add<span className="sr-only"> numbers for {name}</span>
    </Link>
  );
}

function HeadlineCard({ h, labelId }: { h: HeadlineFigures; labelId: string }) {
  return (
    <Card className="space-y-4" role="group" aria-labelledby={labelId}>
      <div className="flex flex-col gap-1">
        <p id={labelId} className="text-sm font-medium text-muted">
          {h.label}
        </p>
        <p className="tabular text-4xl font-semibold tracking-tight">
          {h.amount === null ? (
            <span className="text-2xl">Not computed</span>
          ) : (
            <>
              {h.qualifier ? <span className="mr-2 text-base font-medium text-muted">{h.qualifier}</span> : null}
              {usd(h.amount)}
            </>
          )}
        </p>
        <p className="text-sm text-muted">{h.basisSentence}</p>
        {h.unavailable ? <p className="text-sm">{h.unavailable}</p> : null}
      </div>
      {h.parts.length ? (
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[1fr_auto]">
          {h.parts.map((part) => (
            <div key={part.label} className="contents">
              <dt className="text-muted">
                {part.label}
                {part.note ? <span className="text-xs"> ({part.note})</span> : null}
              </dt>
              <dd className="tabular sm:text-right">{part.amount === null ? "Not computed" : usd(part.amount)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {h.parts.length ? <p className="text-xs text-muted">Each figure is rounded to cents once, so the parts can differ from the total by a cent.</p> : null}
      {h.minimumCouldAdd ? <p className="text-sm">{h.minimumCouldAdd.sentence}</p> : null}
      {h.notIncluded.length ? (
        <div className="space-y-1 text-sm">
          <p className="font-medium">Not included, because no numbers were given</p>
          <ul className="space-y-1">
            {h.notIncluded.map((item) => (
              <li key={`${item.category}:${item.name}`} className="flex flex-wrap items-center gap-x-3">
                <span>
                  {item.name}: <span className="text-muted">{item.rate}</span>
                </span>
                {item.addHref ? <AddLink href={item.addHref} name={item.name} /> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

export function RunHeadline({ summary, provenance, view, viewHref }: { summary: BulkSummary; provenance: RunProvenance; view: HeadlineView; viewHref: (view: HeadlineView) => string }) {
  const h = headlineFigures(summary, view, { addHref: provenance.addHref }, provenance.audience);
  const caveats: string[] = [];
  const exposure = summary.exposure;
  if (exposure.unresolved.shipments > 0) caveats.push(`Up to ${money(exposure.unresolved.amount)} in surcharges across ${plural(exposure.unresolved.shipments, "shipment")} could not be decided and is not included.`);
  if (exposure.conditional.shipments > 0) caveats.push(`Up to ${money(exposure.conditional.amount)} across ${plural(exposure.conditional.shipments, "shipment")} may be added after shipping (address corrections and similar) and is not included.`);
  const noDims = summary.warnings.find((w) => w.code === "dimensions_missing")?.shipments ?? 0;
  if (noDims > 0) caveats.push(`${plural(noDims, "shipment")} had no package dimensions on a service that prices by dimensional weight, so it was not checked; those prices may be low.`);
  if (summary.assumptions.residential > 0) caveats.push(`${plural(summary.assumptions.residential, "shipment")} ${summary.assumptions.residential === 1 ? "was" : "were"} priced assuming ${provenance.residentialDefault === false ? "business" : "home"} deliveries (the file does not say).`);
  if (summary.assumptions.weight > 0) caveats.push(`${plural(summary.assumptions.weight, "shipment")} ${summary.assumptions.weight === 1 ? "was" : "were"} priced on weights derived from product weights.`);
  if (summary.assumptions.originZip > 0) caveats.push(`${plural(summary.assumptions.originZip, "shipment")} ${summary.assumptions.originZip === 1 ? "was" : "were"} priced assuming ${provenance.originZipDefault ? `they ship from ZIP ${provenance.originZipDefault}` : "an origin ZIP"} (the file does not say).`);
  if (summary.loadIssues.length) caveats.push(`${plural(summary.loadIssues.length, "surcharge rule")} could not be applied; totals omit ${summary.loadIssues.length === 1 ? "it" : "them"}.`);
  if (view !== "shipping") caveats.push(...h.caveats);
  const rates = provenance.pricingBasis === "fixed_date" ? `rates in effect on ${provenance.asOfDate ? formatDate(provenance.asOfDate) : "the chosen date"}` : "rates in effect on each ship date";
  return (
    <div className="space-y-4">
      <ViewControl view={view} hrefFor={viewHref} />
      <HeadlineCard h={h} labelId="run-headline-label" />
      {view === "shipping" ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <Stat label="Per package" value={money(summary.averages.expectedPerPackage)} note={`${plural(summary.modeled.packages, "package")} modeled`} />
          <Stat label="Projected shipping spend" value={summary.modeled.orders ? money(summary.totals.expected) : "—"} note={summary.modeled.orders ? `for the ${n(summary.modeled.orders)} orders that could be priced: ${money(summary.totals.definite)} from your rate card · ${money(summary.totals.estimated)} based on assumptions` : "no orders could be priced"} />
          <Stat label="Orders modeled" value={`${summary.coverage.ordersPct}%`} note={`${n(summary.modeled.orders)} of ${n(summary.imported.orders)} orders`} />
        </div>
      ) : null}
      <div className="space-y-1 text-sm text-muted">
        <p>
          {provenance.datasetName ? `${provenance.datasetName} · ` : ""}
          {provenance.rateCardName}, {rates}
          {provenance.serviceOverrideName ? ` · ${provenance.overrideAllServices ? "every shipment" : "shipments whose service was not mapped"} priced on ${provenance.serviceOverrideName}` : ""}
          {provenance.finishedAt ? ` · priced ${formatDate(provenance.finishedAt)}` : ""}. Estimates, not an invoice.
        </p>
        {provenance.feeScheduleLine ? <p>{provenance.feeScheduleLine}.</p> : null}
        {provenance.assumptionsLine ? <p>{provenance.assumptionsLine}.</p> : null}
        {provenance.uncoveredNote ? <p>{provenance.uncoveredNote}</p> : null}
      </div>
      {provenance.feesChanged ? (
        <Alert tone="info">
          <p>
            Fees have changed since this model was priced.
            {provenance.addHref ? (
              <>
                {" "}
                <Link href={provenance.addHref} className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
                  Run it again
                </Link>{" "}
                to price it with the current fee schedule.
              </>
            ) : null}
          </p>
        </Alert>
      ) : null}
      <div className="flex flex-wrap gap-x-6">
        {provenance.exportHref ? (
          <a href={provenance.exportHref} download className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
            Download the shipment-level CSV
          </a>
        ) : null}
        {provenance.ordersCsvHref ? (
          <a href={provenance.ordersCsvHref} download className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
            Download the per-order CSV
          </a>
        ) : null}
        {provenance.monthlyCsvHref ? (
          <a href={provenance.monthlyCsvHref} download className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
            Download the monthly charges CSV
          </a>
        ) : null}
      </div>
      {caveats.length ? (
        <Alert tone="info">
          <ul className="list-disc space-y-1 pl-5">
            {caveats.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
    </div>
  );
}

function Table<T>({ caption, columns, rows, keyOf }: { caption: string; columns: { label: string; cell: (r: T) => string; numeric?: boolean }[]; rows: T[]; keyOf: (r: T) => string }) {
  if (!rows.length) return null;
  return (
    <Card className="space-y-3">
      <CardTitle>{caption}</CardTitle>
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={caption}>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              {columns.map((c) => (
                <th key={c.label} className={`py-1 pr-3 font-medium ${c.numeric ? "text-right" : ""}`}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={keyOf(r)}>
                {columns.map((c) => (
                  <td key={c.label} className={`py-2 pr-3 ${c.numeric ? "tabular text-right whitespace-nowrap" : ""}`}>
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function RunBreakdowns({ summary }: { summary: BulkSummary }) {
  const countCols = [
    { label: "Orders", cell: (r: { orders: number }) => n(r.orders), numeric: true },
    { label: "Shipments", cell: (r: { shipments: number }) => n(r.shipments), numeric: true },
    { label: "Estimated cost", cell: (r: { expected: string }) => money(r.expected), numeric: true },
    { label: "Share", cell: (r: { sharePct: string }) => `${r.sharePct}%`, numeric: true },
  ];
  return (
    <div className="space-y-6">
      <Table caption="By service" rows={summary.byService} keyOf={(r) => r.serviceId} columns={[{ label: "Service", cell: (r) => r.name }, ...countCols]} />
      <Table caption="By zone" rows={summary.byZone} keyOf={(r) => r.zone} columns={[{ label: "Zone", cell: (r) => r.zone }, ...countCols]} />
      <Table
        caption="By billable weight"
        rows={summary.byWeightBracket}
        keyOf={(r) => r.bracket}
        columns={[{ label: "Bracket", cell: (r) => r.bracket }, { label: "Packages", cell: (r) => n(r.packages), numeric: true }, { label: "Estimated cost", cell: (r) => money(r.expected), numeric: true }, { label: "Share", cell: (r) => `${r.sharePct}%`, numeric: true }]}
      />
      {summary.shipmentLevel.shipments > 0 ? (
        <p className="text-sm text-muted">
          Shipment-level charges (not tied to one package): {money(summary.shipmentLevel.expected)} across {n(summary.shipmentLevel.shipments)} shipments.
        </p>
      ) : null}
      <Table
        caption="Surcharges"
        rows={summary.bySurcharge}
        keyOf={(r) => r.key}
        columns={[
          { label: "Surcharge", cell: (r) => `${r.name} (${r.scope === "carrier" ? "carrier published" : "your 3PL"})` },
          { label: "Shipments", cell: (r) => n(r.charged.shipments), numeric: true },
          { label: "From rate card", cell: (r) => money(r.charged.definite), numeric: true },
          { label: "Based on assumptions", cell: (r) => money(r.charged.estimated), numeric: true },
          { label: "Could not be decided", cell: (r) => (r.unknown.shipments ? `up to ${money(r.unknown.amount)} (${n(r.unknown.shipments)})` : "—"), numeric: true },
          { label: "May be added after shipping", cell: (r) => (r.conditional.shipments ? `up to ${money(r.conditional.amount)} (${n(r.conditional.shipments)})` : "—"), numeric: true },
          { label: "Waived / included", cell: (r) => (r.waived.shipments || r.included.shipments ? `${n(r.waived.shipments)} / ${n(r.included.shipments)}` : "—"), numeric: true },
        ]}
      />
      <Table caption="By month of order" rows={summary.byMonth} keyOf={(r) => r.month} columns={[{ label: "Month", cell: (r) => (r.month === "unknown" ? "No date" : r.month) }, ...countCols]} />
    </div>
  );
}

export function RunExclusions({ summary, fixHref, staff }: { summary: BulkSummary; fixHref: string | null; staff: boolean }) {
  if (!summary.exclusions.length && !summary.warnings.length && !summary.loadIssues.length) return null;
  return (
    <Card className="space-y-4">
      <div>
        <CardTitle>What was not priced, and why</CardTitle>
        <CardDescription>These orders stay in the total count but not in the averages.</CardDescription>
        {fixHref ? (
          <Link href={fixHref} className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
            Review how the file was read
          </Link>
        ) : null}
      </div>
      {summary.exclusions.length ? (
        <ul className="space-y-2 text-sm">
          {summary.exclusions.map((e) => (
            <li key={e.reason} className="flex flex-wrap items-baseline justify-between gap-2">
              <span>{EXCLUSION_TEXT[e.reason] ?? e.reason}</span>
              <span className="tabular text-muted">
                {plural(e.orders, "order")} ({e.ordersPct}%) · {plural(e.shipments, "shipment")}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {summary.pricedButExcluded.shipments > 0 ? (
        <p className="text-sm text-muted">
          {plural(summary.pricedButExcluded.shipments, "shipment")} priced fine ({money(summary.pricedButExcluded.expected)}) but belong to orders left out because another shipment of the same order could not be priced.
        </p>
      ) : null}
      {summary.warnings.length ? (
        <div className="space-y-1 text-sm">
          <p className="font-medium">Notes on priced shipments</p>
          <ul className="space-y-1 text-muted">
            {summary.warnings.map((w) => (
              <li key={`${w.code}:${w.ruleKey ?? ""}`}>
                {WARNING_TEXT[w.code] ?? w.code}: {plural(w.shipments, "shipment")}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {summary.loadIssues.length ? (
        <Alert tone="warning">
          <p className="font-medium">{plural(summary.loadIssues.length, "surcharge rule")} could not be applied, so these prices may be low</p>
          {staff ? (
            <ul className="mt-1 list-disc pl-5">
              {summary.loadIssues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-1">Ask your 3PL to confirm before relying on these figures.</p>
          )}
        </Alert>
      ) : null}
    </Card>
  );
}

export interface ShipmentRowView {
  rowNo: number;
  externalOrderId: string;
  externalShipmentId: string | null;
  /** The file's ship date (or order date); `pricedOn` is the date whose rates priced it. */
  shipDate: string | null;
  pricedOn: string | null;
  inTotals: boolean;
  destinationZip: string | null;
  zone: string | null;
  serviceName: string | null;
  billableLb: string[] | null;
  status: "ok" | "unavailable";
  reason: string | null;
  expected: string;
  definite: string;
  estimated: string;
  conditional: string;
  unresolved: string;
}

export function ShipmentsTable({ rows, page, pageSize, total, hrefFor, status, pricedButExcluded }: { rows: ShipmentRowView[]; page: number; pageSize: number; total: number; hrefFor: (page: number, status: string) => string; status: string; pricedButExcluded: number }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>Shipments</CardTitle>
        <div className="flex flex-wrap gap-2 text-sm">
          {[
            ["all", "All"],
            ["ok", "Priced"],
            ["unavailable", "Not priced"],
          ].map(([value, label]) => (
            <Link key={value} href={hrefFor(1, value!)} className={`inline-flex min-h-11 items-center rounded-control px-3 ${status === value ? "bg-accent-soft font-medium text-accent-text" : "text-muted hover:underline"}`} aria-current={status === value ? "page" : undefined}>
              {label}
            </Link>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Shipments">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              {["Order", "Shipment", "Ship date", "Rates of", "To", "Zone", "Service", "Billable weight (lb)", "Estimated", "Status"].map((h, i) => (
                <th key={h} className={`py-1 pr-3 font-medium whitespace-nowrap ${i === 0 ? "sticky left-0 bg-raised" : ""}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.rowNo}>
                <td className="sticky left-0 bg-raised py-2 pr-3 whitespace-nowrap">{r.externalOrderId}</td>
                <td className="py-2 pr-3 whitespace-nowrap text-muted">{r.externalShipmentId ?? "—"}</td>
                <td className="py-2 pr-3 whitespace-nowrap">{r.shipDate ?? "—"}</td>
                <td className="py-2 pr-3 whitespace-nowrap text-muted">{r.pricedOn ?? "—"}</td>
                <td className="py-2 pr-3">{r.destinationZip ?? "—"}</td>
                <td className="py-2 pr-3">{r.zone ?? "—"}</td>
                <td className="py-2 pr-3">{r.serviceName ?? "—"}</td>
                <td className="tabular py-2 pr-3 whitespace-nowrap">{r.billableLb?.join(" + ") ?? "—"}</td>
                <td className="tabular py-2 pr-3 whitespace-nowrap">{r.status === "ok" ? money(r.expected) : "—"}</td>
                <td className="py-2 pr-3">
                  {r.status === "ok" && r.inTotals ? (
                    <Badge tone="success">Priced</Badge>
                  ) : r.status === "ok" ? (
                    <span className="inline-flex flex-wrap items-center gap-1">
                      <Badge tone="neutral">Priced, not in totals</Badge>
                      <span className="text-xs text-muted">Another shipment of this order could not be priced</span>
                    </span>
                  ) : (
                    <span className="inline-flex flex-wrap items-center gap-1">
                      <Badge tone="warning">Not priced</Badge>
                      <span className="text-xs text-muted">{r.reason ? (EXCLUSION_TEXT[r.reason] ?? r.reason) : ""}</span>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length ? <p className="py-3 text-sm text-muted">No shipments match this filter.</p> : null}
      </div>
      {pricedButExcluded > 0 ? <p className="text-sm text-muted">{plural(pricedButExcluded, "shipment")} priced but not in the totals above: another shipment of the same order could not be priced. The CSV marks them with in_totals = no.</p> : null}
      {pages > 1 ? (
        <nav className="flex items-center justify-between text-sm" aria-label="Shipments pages">
          {page > 1 ? (
            <Link href={hrefFor(page - 1, status)} className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
              ← Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-muted">
            Page {page} of {pages}
          </span>
          {page < pages ? (
            <Link href={hrefFor(page + 1, status)} className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
              Next →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Fee cards: order fees, monthly charges, account minimum, not included
// ---------------------------------------------------------------------------
const CHARGE_CLASS_LABEL = { definite: "From your rate card", estimated: "Based on assumptions" } as const;

/** "Order fees": every order-scope charge of the schedule in effect, whether or not it was charged, and what could not be computed. */
export function OrderFeesCard({ summary, addHref }: { summary: BulkSummary; addHref: string | null }) {
  if (summary.fees.mode !== "modeled") return null;
  const rows = orderFeeRows(summary);
  const p = summary.fees.processing;
  const statuses = feeStatusSentences(summary.fees.statusCounts);
  return (
    <Card className="space-y-3">
      <div>
        <CardTitle>Order fees</CardTitle>
        <CardDescription>
          Charges that depend on each order.{" "}
          {p.orders > 0
            ? `Priced for ${n(p.orders)} of ${n(summary.modeled.orders)} orders that could be priced, an average of ${money(p.perOrder)} per order.`
            : "No order could be priced with fees."}
        </CardDescription>
      </div>
      {rows.length ? (
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Order fees by charge">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="py-1 pr-3 font-medium">Charge</th>
                <th className="py-1 pr-3 text-right font-medium">Orders charged</th>
                <th className="py-1 pr-3 text-right font-medium">{CHARGE_CLASS_LABEL.definite}</th>
                <th className="py-1 pr-3 text-right font-medium">{CHARGE_CLASS_LABEL.estimated}</th>
                <th className="py-1 font-medium">Not computed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={`${r.category}:${r.name}`}>
                  <td className="py-2 pr-3">
                    {r.name}
                    {r.rate ? <span className="block text-xs text-muted">{r.rate}</span> : null}
                  </td>
                  <td className="tabular py-2 pr-3 text-right whitespace-nowrap">{n(r.orders)}</td>
                  <td className="tabular py-2 pr-3 text-right whitespace-nowrap">{usd(r.definite)}</td>
                  <td className="tabular py-2 pr-3 text-right whitespace-nowrap">{usd(r.estimated)}</td>
                  <td className="py-2">
                    {r.notComputed ? (
                      <span className="inline-flex flex-wrap items-center gap-x-3">
                        <span>{r.notComputed}</span>
                        {r.addable && addHref ? <AddLink href={addHref} name={r.name} /> : null}
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                    {r.replacedOrders > 0 ? <span className="block text-xs text-muted">{plural(r.replacedOrders, "order")} charged under another fee instead</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
            {p.orders > 0 ? (
              <tfoot>
                <tr className="border-t border-line font-medium">
                  <th scope="row" className="py-2 pr-3 text-left font-medium">
                    All order fees
                  </th>
                  <td className="tabular py-2 pr-3 text-right whitespace-nowrap">{n(p.orders)} orders</td>
                  <td className="tabular py-2 pr-3 text-right whitespace-nowrap">{usd(toCents(p.definite))}</td>
                  <td className="tabular py-2 pr-3 text-right whitespace-nowrap">{usd(toCents(p.estimated))}</td>
                  <td />
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      ) : null}
      {statuses.length ? (
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          {statuses.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      ) : null}
      <p className="text-xs text-muted">Each amount is rounded to cents once, so rows can differ from the total by a cent.</p>
    </Card>
  );
}

/** "Monthly charges": leads with the dollars a month, never as a per-order fee; ends with how the all-in moves with volume. */
export function MonthlyChargesCard({ summary, addHref }: { summary: BulkSummary; addHref: string | null }) {
  const m = monthlyCharges(summary);
  if (!m) return null;
  const allIn = headlineFigures(summary, "allin");
  const points = allIn.amount === null ? [] : volumeSensitivity(summary);
  const volume = summary.period.monthlyOrders;
  return (
    <Card className="space-y-4">
      <div>
        <CardTitle>Monthly charges</CardTitle>
        {m.lines.length ? (
          <div className="mt-2 space-y-1">
            {m.fixedPerMonth !== null ? <p className="tabular text-2xl font-semibold tracking-tight">{usd(m.fixedPerMonth)} a month, whatever you ship</p> : null}
            {m.volumeLinkedPerMonth !== null ? (
              <p className={m.fixedPerMonth !== null ? "text-sm" : "tabular text-2xl font-semibold tracking-tight"}>
                {m.fixedPerMonth !== null ? "plus " : ""}
                {usd(m.volumeLinkedPerMonth)} a month in charges that grow with your orders
              </p>
            ) : null}
          </div>
        ) : (
          <CardDescription>No monthly charge could be priced yet.</CardDescription>
        )}
        <p className="mt-2 text-sm text-muted">
          {m.perOrder !== null && volume ? `Spread over your orders, that is about ${usd(m.perOrder)} per order at ${formatVolume(volume)} orders a month. This is monthly charges shared across orders, not a per-order fee. Basis: ${m.basisSentence}.` : m.basisSentence}
        </p>
      </div>
      {m.lines.length ? (
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Monthly charges">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="py-1 pr-3 font-medium">Charge</th>
                <th className="py-1 pr-3 font-medium">Based on</th>
                <th className="py-1 text-right font-medium">A month</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {m.lines.map((l) => (
                <tr key={`${l.category}:${l.name}`}>
                  <td className="py-2 pr-3">
                    {l.name}
                    <span className="block text-xs text-muted">{l.explanation}</span>
                  </td>
                  <td className="py-2 pr-3">
                    <Badge tone={l.chargeClass === "definite" ? "success" : "neutral"}>{CHARGE_CLASS_LABEL[l.chargeClass]}</Badge>
                  </td>
                  <td className="tabular py-2 text-right whitespace-nowrap">{usd(l.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {m.notModeled.length ? (
        <div className="space-y-1 text-sm">
          <p className="font-medium">Not modeled, because no number was given</p>
          <ul className="space-y-1">
            {m.notModeled.map((x) => (
              <li key={`${x.category}:${x.name}`} className="flex flex-wrap items-center gap-x-3">
                <span>
                  {x.name}: <span className="text-muted">{x.rate}. Not computed, not $0.</span>
                </span>
                {x.addable && addHref ? <AddLink href={addHref} name={x.name} /> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {points.length ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">The all-in cost per order at other volumes</p>
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="All-in cost per order at other volumes">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="py-1 pr-3 font-medium">Volume</th>
                  <th className="py-1 pr-3 text-right font-medium">Orders a month</th>
                  <th className="py-1 pr-3 text-right font-medium">All-in per order</th>
                  <th className="py-1 text-right font-medium">All-in a month</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {points.map((pt) => {
                  const prefix = allIn.qualifier ? `${allIn.qualifier} ` : "";
                  return (
                    <tr key={pt.multiplier}>
                      <td className="py-2 pr-3">{pt.multiplier === "1" ? "Your volume" : `${pt.multiplier}× your volume`}</td>
                      <td className="tabular py-2 pr-3 text-right whitespace-nowrap">{formatVolume(pt.monthlyOrders)}</td>
                      <td className="tabular py-2 pr-3 text-right whitespace-nowrap">{pt.known && pt.allInPerOrder !== null ? `${prefix}${usd(pt.allInPerOrder)}` : "Depends on your account minimum"}</td>
                      <td className="tabular py-2 text-right whitespace-nowrap">{pt.known && pt.monthlyTotal !== null ? `${prefix}${usd(pt.monthlyTotal)}` : "Depends on your account minimum"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted">Shipping and order fees per order are held the same; only monthly charges that follow volume (such as returns) change with it, and price breaks that depend on volume are not re-read.</p>
        </div>
      ) : null}
    </Card>
  );
}

function MinimumBlock({ v }: { v: MinimumView }) {
  const status = v.status === "exact" ? { tone: "success" as const, label: "Worked out" } : v.status === "upper_bound" ? { tone: "warning" as const, label: "Up to" } : { tone: "warning" as const, label: "Not worked out" };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold">{v.name}</h3>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      {v.oneLine ? <p className="text-sm">{v.oneLine}</p> : null}
      {v.buckets.length > 1 ? (
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={`${v.name} by month`}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="py-1 pr-3 font-medium">Month</th>
                <th className="py-1 pr-3 text-right font-medium">{v.includesShipping ? "Fees and shipping counted" : "Fees counted"}</th>
                <th className="py-1 pr-3 text-right font-medium">Minimum</th>
                <th className="py-1 text-right font-medium">Added</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {v.buckets.map((b) => (
                <tr key={b.label}>
                  <td className="py-2 pr-3">
                    {b.label}
                    {b.prorated ? <span className="block text-xs text-muted">part of the month, minimum prorated</span> : null}
                  </td>
                  <td className="tabular py-2 pr-3 text-right whitespace-nowrap">{usd(b.counted)}</td>
                  <td className="tabular py-2 pr-3 text-right whitespace-nowrap">{usd(b.minimum)}</td>
                  <td className="tabular py-2 text-right whitespace-nowrap">{usd(b.added)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {v.buckets.length > 1 && v.averageAdded !== null ? <p className="text-sm">On average the minimum adds {usd(v.averageAdded)} a month.</p> : null}
      {v.couldAdd ? <p className="text-sm">{v.couldAdd}</p> : null}
      {v.members.length ? (
        <div className="space-y-1 text-sm">
          <p className="font-medium">What counts toward it</p>
          <ul className="space-y-1">
            {v.members.map((m, i) => (
              <li key={`${i}:${m.name}`} className="flex flex-wrap items-center gap-2">
                <span>{m.name}</span>
                <Badge tone={m.state === "priced" ? "success" : "warning"}>{m.label}</Badge>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** "Account minimum": what counts toward it (each charge marked), and either the month-by-month figures or why they could not be worked out. */
export function MinimumCard({ summary }: { summary: BulkSummary }) {
  const views = minimumViews(summary);
  if (!views.length) return null;
  return (
    <Card className="space-y-5">
      <div>
        <CardTitle>Account minimum</CardTitle>
        <CardDescription>When the charges counted toward a minimum fall short of it in a month, the difference is added to that month.</CardDescription>
      </div>
      {views.map((v, i) => (
        <MinimumBlock key={`${i}:${v.name}`} v={v} />
      ))}
    </Card>
  );
}

/** "Not included", in three groups: no numbers given (with the rate and an Add link), not on the fee schedule, never included. */
export function NotIncludedCard({ summary, addHref, audience }: { summary: BulkSummary; addHref: string | null; audience: HeadlineAudience }) {
  const g = notIncludedGroups(summary, { addHref }, audience);
  const schedule = audience === "staff" ? "this customer's fee schedule" : "your fee schedule";
  return (
    <Card className="space-y-4">
      <CardTitle>Not included</CardTitle>
      {g.needNumbers.length ? (
        <div className="space-y-1 text-sm">
          <h3 className="font-medium">Left out because no numbers were given</h3>
          <ul className="space-y-1">
            {g.needNumbers.map((item) => (
              <li key={`${item.category}:${item.name}`} className="flex flex-wrap items-center gap-x-3">
                <span>
                  {item.name}: <span className="text-muted">{item.rate}</span>
                </span>
                {item.addHref ? <AddLink href={item.addHref} name={item.name} /> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {g.notOnSchedule.length ? (
        <div className="space-y-1 text-sm">
          <h3 className="font-medium">Not on {schedule}</h3>
          <ul className="space-y-1">
            {g.notOnSchedule.map((item) => (
              <li key={`${item.label}:${item.detail}`}>
                {item.label}: <span className="text-muted">{item.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="space-y-1 text-sm">
        <h3 className="font-medium">Never included</h3>
        <ul className="list-disc space-y-1 pl-5 text-muted">
          {g.neverIncluded.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Orders table
// ---------------------------------------------------------------------------
export interface OrderRowView {
  orderId: string;
  externalOrderId: string;
  units: number | null;
  lines: number | null;
  packages: number;
  assumed: { units?: boolean; lines?: boolean; skus?: boolean; packaging?: boolean };
  feeStatus: string;
  definiteE4: number;
  estimatedE4: number;
  unresolved: { ruleKey: string; reason: string }[];
  /** Σ expected shipping when every shipment of the order priced, else null. */
  shippingExpected: string | null;
}

/**
 * One row per order: item and line counts (unknown is a dash, never 0), packages, shipping, order fees and
 * shipping + order fees. There is deliberately no per-order column for monthly charges or the all-in: monthly
 * charges are spread over the customer's volume, never charged per order.
 */
export function OrdersTable({ summary, rows, page, pageSize, total, hrefFor, loadError }: { summary: BulkSummary; rows: OrderRowView[]; page: number; pageSize: number; total: number; hrefFor: (page: number) => string; loadError: boolean }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const names = ruleNameIndex(summary);
  const count = (v: number | null, assumed: boolean | undefined) => (v === null ? "—" : `${n(v)}${assumed ? " (assumed)" : ""}`);
  return (
    <Card className="space-y-3">
      <div>
        <CardTitle>Orders</CardTitle>
        <CardDescription>Shipping and order fees for each order. Monthly charges are not per-order fees and are not shown here.</CardDescription>
      </div>
      {loadError ? <Alert tone="warning">The orders could not be loaded just now. Reload the page to try again.</Alert> : null}
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Orders">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="sticky left-0 bg-raised py-1 pr-3 font-medium whitespace-nowrap">Order</th>
              <th className="py-1 pr-3 text-right font-medium">Units</th>
              <th className="py-1 pr-3 text-right font-medium">Lines</th>
              <th className="py-1 pr-3 text-right font-medium">Packages</th>
              <th className="py-1 pr-3 text-right font-medium">Shipping</th>
              <th className="py-1 pr-3 text-right font-medium">Order fees</th>
              <th className="py-1 pr-3 text-right font-medium whitespace-nowrap">Shipping + order fees</th>
              <th className="py-1 font-medium">Fees</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => {
              const f = orderRowFigures({ feeStatus: r.feeStatus, definiteE4: r.definiteE4, estimatedE4: r.estimatedE4, shippingExpected: r.shippingExpected, unresolved: r.unresolved }, names);
              const prefix = f.feesAtLeast ? "At least " : "";
              return (
                <tr key={r.orderId}>
                  <td className="sticky left-0 bg-raised py-2 pr-3 whitespace-nowrap">{r.externalOrderId}</td>
                  <td className="tabular py-2 pr-3 text-right whitespace-nowrap">{count(r.units, r.assumed.units)}</td>
                  <td className="tabular py-2 pr-3 text-right whitespace-nowrap">{count(r.lines, r.assumed.lines)}</td>
                  <td className="tabular py-2 pr-3 text-right whitespace-nowrap">{n(r.packages)}</td>
                  <td className="tabular py-2 pr-3 text-right whitespace-nowrap">{f.shipping === null ? "Not priced" : usd(f.shipping)}</td>
                  <td className="tabular py-2 pr-3 text-right whitespace-nowrap">{f.fees === null ? "Not computed" : `${prefix}${usd(f.fees)}`}</td>
                  <td className="tabular py-2 pr-3 text-right whitespace-nowrap">{f.combined === null ? "Not computed" : `${prefix}${usd(f.combined)}`}</td>
                  <td className="py-2">
                    <span className="inline-flex flex-wrap items-center gap-1">
                      <Badge tone={f.feeStatus === "priced" ? "success" : f.feeStatus === "partly priced" ? "warning" : "neutral"}>{f.feeStatus === "priced" ? "Priced" : f.feeStatus === "partly priced" ? "Partly priced" : "Not computed"}</Badge>
                      {f.notComputed ? <span className="text-xs text-muted">{f.feeStatus === "partly priced" ? `Not computed: ${f.notComputed}` : f.notComputed}</span> : null}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && !loadError ? <p className="py-3 text-sm text-muted">No orders to show.</p> : null}
      </div>
      {pages > 1 ? (
        <nav className="flex items-center justify-between text-sm" aria-label="Orders pages">
          {page > 1 ? (
            <Link href={hrefFor(page - 1)} className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
              ← Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-muted">
            Page {page} of {pages}
          </span>
          {page < pages ? (
            <Link href={hrefFor(page + 1)} className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
              Next →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </Card>
  );
}
