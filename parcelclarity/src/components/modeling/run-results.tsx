import Link from "next/link";
import type { BulkSummary } from "@/engine/modeling/types";
import { formatMoney } from "@/components/pricing/calculation-result";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { formatDate } from "@/lib/format/date";

/**
 * Customer-facing results of a bulk run. Every figure comes from the stored summary (decimal
 * strings); nothing is computed here. The headline always carries its provenance and its caveats;
 * exposure amounts are "up to" figures and are never averaged.
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
}

export function RunHeadline({ summary, provenance }: { summary: BulkSummary; provenance: RunProvenance }) {
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
  const basedOn = `Based on ${n(summary.modeled.orders)} of ${n(summary.imported.orders)} orders (${summary.coverage.ordersPct}%)`;
  const rates = provenance.pricingBasis === "fixed_date" ? `rates in effect on ${provenance.asOfDate ? formatDate(provenance.asOfDate) : "the chosen date"}` : "rates in effect on each ship date";
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Estimated shipping cost per order" value={money(summary.averages.expectedPerOrder)} note={basedOn} />
        <Stat label="Per package" value={money(summary.averages.expectedPerPackage)} note={`${plural(summary.modeled.packages, "package")} modeled`} />
        <Stat label="Projected shipping spend" value={summary.modeled.orders ? money(summary.totals.expected) : "—"} note={summary.modeled.orders ? `for the ${n(summary.modeled.orders)} orders that could be priced: ${money(summary.totals.definite)} from your rate card · ${money(summary.totals.estimated)} based on assumptions` : "no orders could be priced"} />
        <Stat label="Orders modeled" value={`${summary.coverage.ordersPct}%`} note={`${n(summary.modeled.orders)} of ${n(summary.imported.orders)} orders`} />
      </div>
      <p className="text-sm text-muted">
        {provenance.datasetName ? `${provenance.datasetName} · ` : ""}
        {provenance.rateCardName}, {rates}
        {provenance.serviceOverrideName ? ` · ${provenance.overrideAllServices ? "every shipment" : "shipments whose service was not mapped"} priced on ${provenance.serviceOverrideName}` : ""}
        {provenance.finishedAt ? ` · priced ${formatDate(provenance.finishedAt)}` : ""}. Estimates, not an invoice.
      </p>
      {provenance.exportHref ? (
        <a href={provenance.exportHref} download className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
          Download the shipment-level CSV
        </a>
      ) : null}
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
