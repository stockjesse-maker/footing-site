import type { ReactNode } from "react";
import { PACKAGING_OTHER } from "@/lib/pricing/calculator-schema";
import { formatDecimal } from "@/components/pricing/calculation-result";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { e4ToCents } from "@/engine/fees/tiers";
import type { ForecastMinimum, ForecastProcessing, ForecastSummary, ForecastUnpriceable, ForecastVolumePoint } from "@/engine/forecast/types";
import { assumptionLines, CATEGORY_LABEL, groupDigits, notComputedReason, unpriceableReason, usd, type AddTarget, type Audience, type ForecastHeadline, type ForecastResultData, type NotIncludedItem } from "@/components/forecast/result-model";

/**
 * Presentation of a forecast from assumptions (Milestone 4, design §7). Server-safe: no hooks, no
 * browser APIs, so the preview inside the client form and the saved page render the same thing. Every
 * figure is a string the engine produced; nothing is computed here. A fee that could not be computed
 * is "not computed" with its rate and an "Add" prompt, never $0, and every allocated monthly figure
 * says how many orders a month it is spread over. Nothing here names a rule key, an id, a version
 * number, a 3PL note or a source.
 */

export interface ForecastResultProps {
  data: ForecastResultData;
  audience: Audience;
  /** In the form: "Add" takes the person to the field. On the saved page it links to `editHref` instead. */
  onAdd?: (target: AddTarget) => void;
  editHref?: string;
}

const CLASS_LABEL: Record<Audience, { definite: string; estimated: string }> = {
  brand: { definite: "From your rate card", estimated: "Based on assumptions" },
  staff: { definite: "Definite", estimated: "Estimated" },
};

const FEE_WARNING: Record<string, string> = {
  fee_base_excludes_exposure: "A fee that is a percentage of shipping is worked out on shipping without the surcharges that could not be decided.",
  packaging_defaulted: "Packaging fees assume the packaging you chose for parcels that name none.",
};

const SHIPPING_WARNING: Record<string, string> = {
  dimensions_missing: "No dimensions were given for some parcels on a service that prices by size, so size was not checked and those prices may be low.",
  dim_divisor_missing: "The rate card does not say how a service prices by size, so size was not checked for it.",
  zone_chart_missing: "A zone chart is missing for a carrier.",
  assumed_inputs: "Parts of the shipping price rest on assumed inputs.",
};

/** A figure, or "not computed" when none of the fees behind it could be (never $0). */
const notComputed = (value: string | null): string => (value === null ? "not computed" : usd(value));

const anchorFor = (target: AddTarget): string => (target.kind === "content" ? "forecast-content" : target.kind === "packaging" ? "forecast-parcels" : "forecast-fulfillment");

function packagingLabel(type: string | null): string {
  if (type === null) return "Not given";
  if (type === PACKAGING_OTHER) return "Another type";
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function AddControl({ item, onAdd, editHref }: { item: { name: string; target: AddTarget }; onAdd?: (target: AddTarget) => void; editHref?: string }) {
  const className = "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control px-3 font-medium text-accent-text hover:bg-accent-soft hover:underline";
  const label = (
    <>
      Add<span className="sr-only"> numbers for {item.name}</span>
    </>
  );
  if (onAdd) {
    return (
      <button type="button" className={className} onClick={() => onAdd(item.target)}>
        {label}
      </button>
    );
  }
  if (editHref) {
    return (
      <a className={className} href={`${editHref}#${anchorFor(item.target)}`}>
        {label}
      </a>
    );
  }
  return null;
}

function Table<T>({ caption, columns, rows, keyOf, note }: { caption: string; columns: { label: string; cell: (r: T) => ReactNode; numeric?: boolean }[]; rows: T[]; keyOf: (r: T, i: number) => string; note?: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={caption}>
        <table className="w-full text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="text-left text-xs text-muted">
              {columns.map((c) => (
                <th key={c.label} scope="col" className={`py-1 pr-3 font-medium ${c.numeric ? "text-right" : ""}`}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r, i) => (
              <tr key={keyOf(r, i)}>
                {columns.map((c) => (
                  <td key={c.label} className={`py-2 pr-3 align-top ${c.numeric ? "tabular text-right whitespace-nowrap" : ""}`}>
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Headline
// ---------------------------------------------------------------------------
function NotIncluded({ items, onAdd, editHref }: { items: NotIncludedItem[]; onAdd?: (t: AddTarget) => void; editHref?: string }) {
  if (!items.length) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">Not included: not computed from what you gave</h3>
      <ul className="divide-y divide-line rounded-control border border-line">
        {items.map((item, i) => (
          <li key={`${item.category}-${i}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-sm">
            <div className="min-w-0">
              <p className="font-medium">
                {item.name} <span className="font-normal text-muted">({item.categoryLabel.toLowerCase()})</span>
              </p>
              <p className="text-muted">
                {item.rate} Not computed: {item.reason}
                {item.orders > 0 ? ` (${groupDigits(String(item.orders))} orders a month)` : ""}.
              </p>
            </div>
            <AddControl item={item} onAdd={onAdd} editHref={editHref} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Headline({ headline, summary, audience, onAdd, editHref }: { headline: ForecastHeadline; summary: ForecastSummary; audience: Audience; onAdd?: (t: AddTarget) => void; editHref?: string }) {
  const orders = groupDigits(summary.monthlyOrders);
  const heading = (
    <h2 id="forecast-headline-heading" className="sr-only">
      Forecast headline
    </h2>
  );
  if (headline.kind === "partial" || headline.kind === "shipping_only") {
    // Only the priced share of the volume is in the monthly figure: "at N orders a month" would put it on all of them.
    const partialVolume = summary.unpriceable.length > 0;
    const monthlyNote = partialVolume ? `about ${usd(headline.monthly)} a month over the ${summary.pricedSharePct}% of orders that could be priced` : `about ${usd(headline.monthly)} a month at ${orders} orders a month`;
    return (
      <section aria-labelledby="forecast-headline-heading" className="space-y-4">
        {heading}
        <div className="grid gap-4 sm:grid-cols-2">
          <Stat label={headline.kind === "partial" ? "Shipping per order (priced orders only)" : headline.label} value={usd(headline.parts.shipping)} note={headline.kind === "shipping_only" ? monthlyNote : undefined} />
          {headline.parts.orderFees !== null ? <Stat label="Order fees per order (priced orders only)" value={usd(headline.parts.orderFees)} /> : null}
        </div>
        {headline.note ? <Alert tone="info">{headline.note}</Alert> : null}
        <NotIncluded items={headline.notIncluded} onAdd={onAdd} editHref={editHref} />
      </section>
    );
  }
  const atLeast = headline.kind === "at_least";
  return (
    <section aria-labelledby="forecast-headline-heading">
      <Card className="space-y-4">
        {heading}
        <div>
          <p className="text-sm font-medium text-muted">{headline.label}</p>
          <p className="tabular text-4xl font-semibold tracking-tight">
            {atLeast ? <span className="mr-2 text-2xl font-medium text-muted">At least</span> : null}
            {usd(headline.perOrder)}
            <span className="ml-2 text-base font-normal text-muted">per order</span>
          </p>
          <p className="mt-1 text-sm text-muted">
            {atLeast ? "At least " : "About "}
            {usd(headline.monthly)} a month, {usd(headline.annual)} a year if every month looked like this.
          </p>
        </div>
        <p className="text-sm">
          {atLeast ? "Counted so far: shipping" : "Shipping"} {usd(headline.parts.shipping)} + order fees {notComputed(headline.parts.orderFees)} + monthly charges {notComputed(headline.parts.monthlyCharges)}
          {headline.parts.monthlyCharges !== null ? ` (spread over ${orders} orders a month, the volume you gave)` : ""}.
        </p>
        <p className="text-xs text-muted">Each figure is rounded to cents once, so the parts can differ from the total by a cent.</p>
        <p className="text-sm text-muted">{CLASS_LABEL[audience].estimated}: every figure rests on the mix you described.</p>
        {headline.minimumUpTo ? <Alert tone="warning">The account minimum could add up to {usd(headline.minimumUpTo)} a month on top of this; it is not included.</Alert> : null}
        <NotIncluded items={headline.notIncluded} onAdd={onAdd} editHref={editHref} />
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Order fees
// ---------------------------------------------------------------------------
function OrderFees({ processing, summary }: { processing: ForecastProcessing; summary: ForecastSummary }) {
  const partial = summary.unpriceable.length > 0;
  const none = processing.byRule.length === 0;
  const unresolved = processing.unresolved;
  // When no order fee could be computed there is no sum to show: "$0.00 a month" would read as "these orders pay nothing".
  const allUnresolved = none && unresolved.length > 0;
  return (
    <Card className="space-y-3">
      <div>
        <CardTitle>Order fees</CardTitle>
        <CardDescription>
          {allUnresolved
            ? "None of the order fees could be computed from what you gave. Each is listed with its rate under Not included above; none is counted as $0."
            : `${usd(processing.expected)} a month, ${usd(processing.perOrder)} per order on average${partial ? ` (over the ${summary.pricedSharePct}% of orders that could be priced)` : ""}${unresolved.length ? ", not counting the fees listed below" : ""}. Fees charged per order only; monthly charges are below.`}
        </CardDescription>
      </div>
      {processing.byRule.length ? (
        <Table
          caption="Order fees"
          rows={processing.byRule}
          keyOf={(r, i) => `${i}-${r.name}`}
          columns={[
            {
              label: "Fee",
              cell: (r) => (
                <>
                  <span className="font-medium">{r.name}</span>
                  <span className="block text-xs text-muted">{CATEGORY_LABEL[r.category]}</span>
                </>
              ),
            },
            { label: "Orders charged", cell: (r) => `${r.ordersSharePct}%`, numeric: true },
            { label: "Per order", cell: (r) => usd(r.perOrder), numeric: true },
            { label: "A month", cell: (r) => usd(r.expected), numeric: true },
          ]}
        />
      ) : allUnresolved ? null : (
        <p className="text-sm text-muted">No order fee applied to the orders you described.</p>
      )}
      {unresolved.length ? (
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {unresolved.map((u, i) => (
            <li key={`${i}-${u.name}`}>
              <span className="font-medium">{u.name}</span>: not computed for {u.sharePct}% of orders, because {notComputedReason(u.reason)}.
            </li>
          ))}
        </ul>
      ) : null}
      {processing.warnings.length ? (
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          {processing.warnings.map((w) => (
            <li key={w.code}>
              {FEE_WARNING[w.code] ?? "A note applies to part of the fees."} ({w.sharePct}% of orders)
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Monthly charges and the minimum
// ---------------------------------------------------------------------------
function MonthlyCharges({ summary, audience }: { summary: ForecastSummary; audience: Audience }) {
  const monthly = summary.monthly;
  if (!monthly || (!monthly.lines.length && !monthly.notModeled.length)) return null;
  const orders = groupDigits(summary.monthlyOrders);
  const followsVolume = monthly.lines.some((l) => l.scalesWithVolume);
  const classes = CLASS_LABEL[audience];
  return (
    <Card className="space-y-3">
      <div>
        <CardTitle>Monthly charges</CardTitle>
        <CardDescription>
          {monthly.lines.length ? (followsVolume ? `${usd(monthly.total)} a month at ${orders} orders a month.` : `${usd(monthly.total)} a month, whatever you ship.`) : "None could be computed from what you gave."}
          {summary.allocated?.perOrder ? ` Spread over ${orders} orders a month (the volume you gave), that adds ${usd(summary.allocated.perOrder)} to each order's all-in cost; it is not a fee on each order.` : ""}
        </CardDescription>
      </div>
      {monthly.lines.length ? (
        <Table
          caption="Monthly charges"
          rows={monthly.lines}
          keyOf={(l, i) => `${i}-${l.name}`}
          columns={[
            {
              label: "Charge",
              cell: (l) => (
                <>
                  <span className="font-medium">{l.name}</span>
                  <span className="block text-xs text-muted">{l.explanation}</span>
                </>
              ),
            },
            { label: "Basis", cell: (l) => <Badge tone={l.chargeClass === "definite" ? "success" : "warning"}>{l.chargeClass === "definite" ? classes.definite : classes.estimated}</Badge> },
            { label: "A month", cell: (l) => usd(e4ToCents(l.amountE4)), numeric: true },
          ]}
        />
      ) : null}
      {monthly.notModeled.length ? (
        <p className="text-sm text-muted">
          Not computed from what you gave: {monthly.notModeled.map((n) => n.name).join(", ")}. Each is listed with its rate and an Add prompt in the headline above; none is counted as $0.
        </p>
      ) : null}
    </Card>
  );
}

const MEMBER_STATE: Record<string, string> = { priced: "Priced", not_modeled: "Not computed", not_in_schedule: "Not on your fee schedule" };

/** The engine's reason a minimum is only an upper bound, in this screen's words ("not computed", never the internal "not modeled"). */
function minimumReason(reason: string): string {
  const notModeled = /^(.+) not modeled$/.exec(reason);
  if (notModeled) return `${notModeled[1]} is not computed`;
  const priced = /^shipping priced for ([0-9.]+)% of orders$/.exec(reason);
  if (priced) return `only ${priced[1]}% of orders could be priced`;
  return "something it counts could not be worked out";
}

function MinimumCard({ m }: { m: ForecastMinimum }) {
  const dollars = (e4: number) => usd(e4ToCents(e4));
  // `countedE4` holds the expected shipping too when shipping counts toward the minimum: "fees counted" would understate what is in it.
  const counted = m.includesShipping ? "Fees and shipping counted" : "Fees counted";
  const because = m.reasons.length ? ` (${[...new Set(m.reasons.map(minimumReason))].join("; ")})` : "";
  return (
    <div className="space-y-2 rounded-control border border-line p-3">
      <p className="font-medium">{m.name}</p>
      {m.status === "exact" ? (
        <p className="text-sm">
          {counted} toward the minimum: {dollars(m.countedE4)} · Minimum: {dollars(m.minimumE4)} · Added: {dollars(m.topUpE4)}
        </p>
      ) : m.status === "upper_bound" ? (
        m.topUpE4 > 0 ? (
          <p className="text-sm">
            Minimum: {dollars(m.minimumE4)} · {counted} so far: {dollars(m.countedE4)}. The minimum could add up to {dollars(m.topUpE4)} a month; that is not included in the all-in figure{because}.
          </p>
        ) : (
          <p className="text-sm">
            Minimum: {dollars(m.minimumE4)} · {counted} so far: {dollars(m.countedE4)}. They already meet the minimum, so it adds nothing, whatever the fees that could not be computed come to{because}.
          </p>
        )
      ) : (
        <p className="text-sm">Minimum: {dollars(m.minimumE4)}. Whether it adds anything could not be worked out.</p>
      )}
      {m.includesShipping ? <p className="text-xs text-muted">Shipping charges count toward this minimum.</p> : null}
      {m.members.length ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          {m.members.map((member, i) => (
            <li key={`${i}-${member.name}`}>
              {member.name}: {MEMBER_STATE[member.state] ?? member.state}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sensitivity, unpriceable, assumptions, profile
// ---------------------------------------------------------------------------
function Sensitivity({ points, atLeast, orderFeesNotComputed, monthlyNotComputed }: { points: ForecastVolumePoint[]; atLeast: boolean; orderFeesNotComputed: boolean; monthlyNotComputed: boolean }) {
  if (!points.length) return null;
  const label = (p: ForecastVolumePoint) => (p.multiplier === "1" ? "Your forecast" : `${p.multiplier}× your volume`);
  return (
    <Card className="space-y-3">
      <div>
        <CardTitle>If your volume were different</CardTitle>
        <CardDescription>Shipping and order fees scale with orders; monthly charges mostly do not, so the cost per order falls as volume grows.</CardDescription>
      </div>
      <Table
        caption="Cost per order at other volumes"
        rows={points}
        keyOf={(p) => p.multiplier}
        columns={[
          { label: "Volume", cell: (p) => (p.multiplier === "1" ? <strong>{label(p)}</strong> : label(p)) },
          { label: "Orders a month", cell: (p) => groupDigits(p.monthlyOrders), numeric: true },
          { label: "Shipping", cell: (p) => usd(p.perOrder.shipping), numeric: true },
          { label: "Order fees", cell: (p) => (orderFeesNotComputed ? "not computed" : usd(p.perOrder.processing)), numeric: true },
          { label: "Monthly charges spread", cell: (p) => (monthlyNotComputed ? "not computed" : usd(p.perOrder.allocated)), numeric: true },
          { label: atLeast ? "All-in, at least" : "All-in", cell: (p) => usd(p.perOrder.allIn), numeric: true },
        ]}
        note={
          <p className="text-xs text-muted">
            Shipping and order fees per order are held the same; only monthly charges that follow volume (such as returns) change with it. The account minimum is worked out again at each volume. Price breaks that depend on your monthly volume are not read again, so a fee with one can cost more or less per order than shown at the other volumes; run a new forecast at that volume to see it.
          </p>
        }
      />
    </Card>
  );
}

/** `sharePct` is the engine's total share of volume that cannot be priced, when it reports one (a blocked forecast); the rows carry their own shares. */
export function UnpriceableTable({ rows, sharePct, audience }: { rows: ForecastUnpriceable[]; sharePct: string | null; audience: Audience }) {
  return (
    <div className="space-y-2">
      <p className="text-sm">
        {sharePct ? `${sharePct}% of the orders you described cannot` : "Some of the orders you described cannot"} be priced from your rate card. Nothing is estimated for them.
      </p>
      <Table
        caption="Combinations the rate card cannot price"
        rows={rows}
        keyOf={(r, i) => `${i}-${r.serviceName}-${r.zone}-${r.reason}`}
        columns={[
          { label: "Service", cell: (r) => r.serviceName },
          { label: "Zone", cell: (r) => (r.zone === "ALL" ? "Any" : r.zone) },
          { label: "Share of orders", cell: (r) => `${r.sharePct}%`, numeric: true },
          { label: "Why", cell: (r) => <span>{unpriceableReason(r.reason).replace(/^./, (c) => c.toUpperCase())}{audience === "staff" && r.message ? <span className="block text-xs text-muted">{r.message}</span> : null}</span> },
        ]}
      />
    </div>
  );
}

function Assumes({ summary }: { summary: ForecastSummary }) {
  const lines = assumptionLines(summary);
  return (
    <Card className="space-y-2">
      <CardTitle>What this forecast assumes</CardTitle>
      <ul className="list-disc space-y-1.5 pl-5 text-sm">
        {lines.map((l, i) => (
          <li key={`${l.id}-${i}`}>{l.text}</li>
        ))}
      </ul>
    </Card>
  );
}

function contentMatters(summary: ForecastSummary): boolean {
  const c = summary.profile.content;
  const isDefault = c.source === "rows" && c.rows.length === 1 && c.rows[0]!.units === 1 && c.rows[0]!.lines === 1;
  return !isDefault || (summary.processing?.byRule.some((r) => r.basis === "unit" || r.basis === "line" || r.basis === "sku") ?? false);
}

function Described({ summary }: { summary: ForecastSummary }) {
  const p = summary.profile;
  const multi = /[1-9]/.test(p.multiPackage.pct);
  return (
    <details className="rounded-card border border-line bg-raised p-5 shadow-card sm:p-6">
      <summary className="min-h-11 cursor-pointer text-lg font-semibold tracking-tight">What you described</summary>
      <div className="mt-3 space-y-5">
        <p className="text-sm">
          {groupDigits(p.monthlyOrders)} orders a month, shipping from ZIP code {p.originZip}. {groupDigits(p.residentialPct)}% of orders go to homes
          {multi ? `; ${groupDigits(p.multiPackage.pct)}% ship as ${p.multiPackage.packagesPerOrder} packages` : "; every order ships as one package"}.
        </p>
        <Table
          caption="Parcels"
          rows={p.parcels}
          keyOf={(r, i) => `${i}-${r.weightLb}`}
          columns={[
            { label: "Weight (lb)", cell: (r) => formatDecimal(r.weightLb), numeric: true },
            { label: "Size (in)", cell: (r) => (r.lengthIn ? `${formatDecimal(r.lengthIn)} × ${formatDecimal(r.widthIn ?? "")} × ${formatDecimal(r.heightIn ?? "")}` : r.unknownSize ? "Not known" : "Not given") },
            { label: "Packaging", cell: (r) => packagingLabel(r.packagingType) },
            { label: "Share of orders", cell: (r) => `${r.sharePct}%`, numeric: true },
          ]}
        />
        {p.zones.some((z) => z.zone !== "ALL") ? (
          <Table caption="Zones" rows={p.zones} keyOf={(r) => r.zone} columns={[{ label: "Zone", cell: (r) => r.zone }, { label: "Share of orders", cell: (r) => `${r.sharePct}%`, numeric: true }]} />
        ) : null}
        <Table caption="Services" rows={p.services} keyOf={(r, i) => `${i}-${r.name}`} columns={[{ label: "Service", cell: (r) => r.name }, { label: "Share of orders", cell: (r) => `${r.sharePct}%`, numeric: true }]} />
        {contentMatters(summary) ? (
          <div className="space-y-2">
            {p.content.source === "averages" ? (
              <p className="text-sm text-muted">
                You gave averages of {p.content.averageUnits} items on {p.content.averageLines} lines per order; they are priced as these orders, which reproduce both averages exactly.
              </p>
            ) : null}
            <Table
              caption="A typical order"
              rows={p.content.rows}
              keyOf={(r, i) => `${i}-${r.units}-${r.lines}`}
              columns={[
                { label: "Items", cell: (r) => String(r.units), numeric: true },
                { label: "Order lines", cell: (r) => String(r.lines), numeric: true },
                { label: "Share of orders", cell: (r) => `${r.sharePct}%`, numeric: true },
              ]}
            />
          </div>
        ) : null}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------
export function ForecastResult({ data, audience, onAdd, editHref }: ForecastResultProps) {
  const { summary, headline, sensitivity } = data;
  const shippingWarnings = summary.shipping.warnings.filter((w) => SHIPPING_WARNING[w.code]);
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-[15px]">
        Forecast from your assumptions at {groupDigits(summary.monthlyOrders)} orders a month. Each figure is the expected value over the mix you described; not a prediction for any month and not an invoice.
      </p>
      <Headline headline={headline} summary={summary} audience={audience} onAdd={onAdd} editHref={editHref} />
      <Card className="space-y-2">
        <CardTitle>Shipping</CardTitle>
        <CardDescription>
          {usd(summary.shipping.expected)} a month, {usd(summary.shipping.perOrder)} per order on average{summary.unpriceable.length ? ` (over the ${summary.pricedSharePct}% of orders that could be priced)` : ""}, from your rate card. {CLASS_LABEL[audience].estimated} on the mix you described, never an invoice.
        </CardDescription>
        {shippingWarnings.length ? (
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
            {shippingWarnings.map((w) => (
              <li key={w.code}>
                {SHIPPING_WARNING[w.code]} ({w.sharePct}% of orders)
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
      {summary.processing ? <OrderFees processing={summary.processing} summary={summary} /> : null}
      <MonthlyCharges summary={summary} audience={audience} />
      {summary.minimums.length ? (
        <Card className="space-y-3">
          <CardTitle>Account minimum</CardTitle>
          {summary.minimums.map((m, i) => (
            <MinimumCard key={`${i}-${m.name}`} m={m} />
          ))}
        </Card>
      ) : null}
      <Sensitivity points={sensitivity} atLeast={headline.kind !== "all_in"} orderFeesNotComputed={headline.parts.orderFees === null} monthlyNotComputed={headline.parts.monthlyCharges === null} />
      {summary.unpriceable.length ? (
        <Card className="space-y-3">
          <CardTitle>Not priced</CardTitle>
          <UnpriceableTable rows={summary.unpriceable} sharePct={null} audience={audience} />
        </Card>
      ) : null}
      <Assumes summary={summary} />
      <Described summary={summary} />
    </div>
  );
}
