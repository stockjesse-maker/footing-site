import { useId, type ReactNode } from "react";
import { VerificationBadge } from "@/components/pricing/rule-form";
import { formatDate } from "@/lib/format/date";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import type { BoxFieldRef, OrderFeeLineView, OrderFeeNotComputedView, OrderFeesView } from "@/lib/pricing/calculator-schema";
import type { ChargeClass, ChargeLine, LineStatus, Money, PackageWeightResult, RuleReference, ShipmentCalculation, UnavailableReason, WarningCode } from "@/engine/types";

/**
 * Read-only view of one engine result. Server-safe (no hooks, no browser APIs) so pages and the
 * client-side calculator can both render it. Every figure is labelled with how certain it is:
 * definite, estimated or conditional. Nothing here is an invoice.
 */

export const ESTIMATE_NOTICE = "Estimates are based on the published rate card and rules in force on the ship date; they are not an invoice.";

/** "$12.34". Money amounts are decimal strings already rounded to 2 places; no float arithmetic happens here. */
export function formatMoney(m: Money): string {
  const raw = m.amount.trim();
  const negative = raw.startsWith("-");
  const [intPart = "0", fracPart = ""] = raw.replace(/^[-+]/, "").split(".");
  const digits = intPart.replace(/\D/g, "") || "0";
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = `${fracPart}00`.slice(0, 2);
  const symbol = m.currency === "USD" ? "$" : `${m.currency} `;
  return `${negative ? "−" : ""}${symbol}${grouped}.${frac}`;
}

/** Shows a decimal string as given, minus trailing zeros ("12.5000" → "12.5", "3.00" → "3"). */
export function formatDecimal(value: string): string {
  const trimmed = value.trim();
  if (!/^-?\d+\.\d+$/.test(trimmed)) return trimmed;
  return trimmed.replace(/0+$/, "").replace(/\.$/, "");
}

const isPositive = (m: Money) => Number(m.amount) > 0;

/** A saved single result carries the order fees that were shown with it (customer-safe: no rule keys). */
export type StoredShipmentResult = ShipmentCalculation & { orderFees?: OrderFeesView };

const dollars = (amount: string) => formatMoney({ amount, currency: "USD" });

/**
 * "Shipping + order fees" as one cell: the figure, "At least" figure when some fee was left out, "Not
 * computed" when none could be; a fee left out is never printed as $0.
 */
export function feesTotalText(fees: OrderFeesView | null | undefined): string {
  if (!fees) return "—";
  if (fees.combined === null) return "Not computed";
  return fees.status === "ok" ? dollars(fees.combined) : `At least ${dollars(fees.combined)}`;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const CHARGE_CLASS: Record<ChargeClass, { label: string; tone: "success" | "warning" | "neutral" }> = {
  definite: { label: "Definite", tone: "success" },
  estimated: { label: "Estimated", tone: "warning" },
  conditional: { label: "Conditional", tone: "neutral" },
};

/** Customers read the same classes in the vocabulary the model results use. */
const BRAND_CHARGE_CLASS: Record<ChargeClass, { label: string; tone: "success" | "warning" | "neutral" }> = {
  definite: { label: "From your rate card", tone: "success" },
  estimated: { label: "Based on assumptions", tone: "warning" },
  conditional: { label: "May be added after shipping", tone: "neutral" },
};

/**
 * Customer-facing notes: plain words, no codes or keys. Codes absent here are configuration
 * matters for the 3PL (a rule chain, a missing divisor or zone chart) that a customer cannot act
 * on; they are summarised in one line instead.
 */
const BRAND_WARNING: Partial<Record<WarningCode, { title: string; text: string }>> = {
  assumed_inputs: { title: "Some inputs were assumed", text: "Parts of this price rest on assumed inputs and are shown as estimates." },
  dimensions_missing: { title: "No dimensions given", text: "Dimensional weight was not checked, so this price may be low for a large, light package." },
  rule_overridden: { title: "Pricing exception applied", text: "A pricing exception agreed with your 3PL was applied to this shipment." },
  zip_list_missing: { title: "A surcharge could not be confirmed", text: "One surcharge could not be confirmed for this address and is shown as an estimate." },
  rate_card_not_effective: { title: "No rates for this date", text: "Your rate card has no rates in effect on this ship date." },
};

const NOT_COUNTED: Record<LineStatus, string> = {
  charged: "Not charged",
  unknown: "Could not be decided from the inputs",
  included: "Included in the base rate",
  waived: "Waived for this customer",
  conditional: "Only if it occurs after shipping",
};

const WEIGHT_BASIS: Record<PackageWeightResult["basis"], string> = {
  dim: "Dimensional weight",
  actual: "Actual weight",
  minimum: "Minimum billable weight",
  rule_minimum: "Surcharge rule minimum",
  exempt: "Exempt from dimensional weight",
  no_dimensions: "No dimensions given",
  no_divisor: "No DIM divisor on the rate card",
};

const ZONE_SOURCE: Record<NonNullable<ShipmentCalculation["zone"]>["source"], string> = {
  input: "Zone as entered",
  zone_chart: "From the rate card zone chart",
  zone_independent: "Not priced by zone",
};

const UNAVAILABLE: Record<UnavailableReason, string> = {
  service_not_on_rate_card: "Service not on the rate card",
  zone_unresolved: "Zone could not be resolved",
  zone_ambiguous: "Zone is ambiguous",
  no_rate_for_weight: "No rate for this weight",
  no_rate_for_zone: "No rate for this zone",
  no_rate_for_origin: "No rate for this origin",
  rate_card_not_effective: "Rate card not in effect on the ship date",
  invalid_input: "Invalid input",
};

const WARNING: Record<WarningCode, string> = {
  dim_divisor_missing: "No DIM divisor",
  zip_list_missing: "ZIP list missing",
  unverified_rule_applied: "Unverified rule applied",
  dimensions_missing: "Dimensions missing",
  zone_chart_missing: "Zone chart missing",
  rate_card_not_effective: "Rate card not in effect",
  rule_overridden: "Customer exception applied",
  rule_reference_cycle: "Rule reference cycle",
  override_not_applicable: "Customer exception did not fit the rule",
  assumed_inputs: "Priced on assumed inputs",
};

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function SectionHeading({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h3 id={id} className="text-base font-semibold tracking-tight">
      {children}
    </h3>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="tabular font-medium break-words">{children}</dd>
    </div>
  );
}

export type ResultAudience = "staff" | "brand";

/** Customers see where a rule comes from in plain words, never its key, notes or verification state. */
function RuleLine({ rule, audience }: { rule: RuleReference; audience: ResultAudience }) {
  if (audience === "brand") {
    return <span className="text-xs text-muted">{rule.scope === "platform" ? "Published carrier surcharge" : "Your 3PL's pricing"}</span>;
  }
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
      <span className="font-mono">
        {rule.key}@v{rule.version}
      </span>
      <span aria-hidden="true">·</span>
      <span className="break-words">{rule.sourceReference}</span>
      <span aria-hidden="true">·</span>
      <VerificationBadge status={rule.verificationStatus} />
    </span>
  );
}

function packageLabel(index: number | null): string {
  return index === null ? "Shipment" : `Package ${index + 1}`;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function TotalsRow({ totals, audience }: { totals: ShipmentCalculation["totals"]; audience: ResultAudience }) {
  if (audience === "brand") {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Estimated total" value={formatMoney(totals.expected)} note="What your rate card says plus charges based on assumptions. An estimate, not an invoice." />
        <Stat label="From your rate card" value={formatMoney(totals.definite)} note="Follows directly from your rate card and its published terms." />
        <Stat label="Based on assumptions" value={formatMoney(totals.estimated)} note="Rests on something assumed, for example missing dimensions." />
        <Stat label="May be added after shipping (up to)" value={formatMoney(totals.conditionalExposure)} note="Adjustments that may or may not occur (address corrections and similar). Not in the total." />
      </div>
    );
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Stat label="Expected shipping cost" value={formatMoney(totals.expected)} note="Definite plus estimated charges. Best single estimate, not an invoice." />
      <Stat label="Definite" value={formatMoney(totals.definite)} note="Follows from the rate card and the published terms." />
      <Stat label="Estimated" value={formatMoney(totals.estimated)} note="Rests on an assumption, for example missing dimensions or an unverified source." />
      <Stat label="Possible adjustments" value={formatMoney(totals.conditionalExposure)} note="Post-shipment adjustments that may or may not occur. Not in the expected cost." />
    </div>
  );
}

function BillableWeights({ result, uid }: { result: ShipmentCalculation; uid: string }) {
  return (
    <section aria-labelledby={`${uid}-weights`} className="space-y-3">
      <SectionHeading id={`${uid}-weights`}>Billable weight</SectionHeading>
      <Card className="divide-y divide-line p-0 sm:p-0">
        {result.packages.map((p) => {
          const input = result.input.packages[p.packageIndex];
          const asEntered = input ? `${formatDecimal(input.weight)} ${input.weightUnit}` : null;
          return (
            <div key={p.packageIndex} className="space-y-3 px-5 py-4 sm:px-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="font-medium">{packageLabel(p.packageIndex)}</h4>
                <Badge tone={p.basis === "no_divisor" || p.basis === "no_dimensions" ? "warning" : "neutral"}>{WEIGHT_BASIS[p.basis]}</Badge>
              </div>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-5">
                <Detail label="Actual">
                  {formatDecimal(p.actualLb)} lb{asEntered && input?.weightUnit !== "lb" ? <span className="block text-xs font-normal text-muted">entered as {asEntered}</span> : null}
                </Detail>
                <Detail label="Dimensions (rounded, in)">{p.roundedDimensionsIn ? p.roundedDimensionsIn.map(formatDecimal).join(" × ") : "—"}</Detail>
                <Detail label="Cubic in">{p.cubicIn ? formatDecimal(p.cubicIn) : "—"}</Detail>
                <Detail label="DIM weight">{p.dimLb ? `${formatDecimal(p.dimLb)} lb` : "—"}</Detail>
                <Detail label="Billable">
                  <span className="text-base font-semibold">{formatDecimal(p.billableLb)} lb</span>
                </Detail>
              </dl>
              <p className="text-sm text-muted">{p.explanation}</p>
            </div>
          );
        })}
      </Card>
    </section>
  );
}

function ZoneLine({ zone }: { zone: NonNullable<ShipmentCalculation["zone"]> }) {
  return (
    <Card className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="font-medium">
          Zone <span className="tabular">{zone.zone}</span>
        </p>
        <p className="text-sm text-muted">{zone.explanation}</p>
      </div>
      <Badge tone={zone.source === "input" ? "neutral" : "accent"} className="shrink-0 self-start sm:self-center">
        {ZONE_SOURCE[zone.source]}
      </Badge>
    </Card>
  );
}

function ChargeLineRow({ line, audience }: { line: ChargeLine; audience: ResultAudience }) {
  const cls = (audience === "brand" ? BRAND_CHARGE_CLASS : CHARGE_CLASS)[line.chargeClass];
  const struck = !line.counted && (line.status === "included" || line.status === "waived");
  return (
    <li className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={line.counted ? "font-medium" : "font-medium text-muted"}>{line.label}</span>
          <Badge tone={cls.tone}>{cls.label}</Badge>
          {!line.counted ? <Badge tone="neutral">{NOT_COUNTED[line.status]}</Badge> : null}
        </div>
        <p className="text-sm text-muted">{line.explanation}</p>
        {line.rule ? <RuleLine rule={line.rule} audience={audience} /> : null}
      </div>
      <span className={`tabular shrink-0 pt-0.5 font-medium ${struck ? "text-muted line-through" : line.counted ? "" : "text-muted"}`}>
        {formatMoney(line.amount)}
        {!line.counted ? <span className="sr-only"> (not counted)</span> : null}
      </span>
    </li>
  );
}

function ItemizedCharges({ result, audience, uid }: { result: ShipmentCalculation; audience: ResultAudience; uid: string }) {
  const packageCount = Math.max(result.packages.length, result.input.packages.length);
  const groups: { index: number | null; lines: ChargeLine[] }[] = [];
  for (let i = 0; i < packageCount; i++) {
    const lines = result.lines.filter((l) => l.packageIndex === i);
    if (lines.length) groups.push({ index: i, lines });
  }
  const shipmentLines = result.lines.filter((l) => l.packageIndex === null);
  if (shipmentLines.length) groups.push({ index: null, lines: shipmentLines });

  return (
    <section aria-labelledby={`${uid}-lines`} className="space-y-3">
      <SectionHeading id={`${uid}-lines`}>Itemized charges</SectionHeading>
      <Card className="divide-y divide-line p-0 sm:p-0">
        {groups.map((g) => (
          <div key={g.index ?? "shipment"} className="px-5 py-4 sm:px-6">
            <h4 className="font-medium">{packageLabel(g.index)}</h4>
            <ul className="mt-1 divide-y divide-line">
              {g.lines.map((line, i) => (
                <ChargeLineRow key={`${g.index ?? "s"}-${i}-${line.basis}`} line={line} audience={audience} />
              ))}
            </ul>
          </div>
        ))}
      </Card>
    </section>
  );
}

function Warnings({ warnings, audience, uid }: { warnings: ShipmentCalculation["warnings"]; audience: ResultAudience; uid: string }) {
  if (audience === "brand") {
    const seen = new Set<WarningCode>();
    const shown = warnings.filter((w) => BRAND_WARNING[w.code] && !seen.has(w.code) && seen.add(w.code));
    const other = warnings.some((w) => !BRAND_WARNING[w.code]);
    if (!shown.length && !other) return null;
    return (
      <section aria-labelledby={`${uid}-warnings`} className="space-y-3">
        <SectionHeading id={`${uid}-warnings`}>Notes</SectionHeading>
        <ul className="space-y-2">
          {shown.map((w) => (
            <li key={w.code}>
              <Alert tone="warning" title={BRAND_WARNING[w.code]!.title}>
                {BRAND_WARNING[w.code]!.text}
              </Alert>
            </li>
          ))}
          {other ? (
            <li>
              <Alert tone="info">Some charges are estimates because part of the pricing configuration could not be applied; ask your 3PL to confirm them.</Alert>
            </li>
          ) : null}
        </ul>
      </section>
    );
  }
  return (
    <section aria-labelledby={`${uid}-warnings`} className="space-y-3">
      <SectionHeading id={`${uid}-warnings`}>Warnings</SectionHeading>
      <ul className="space-y-2">
        {warnings.map((w, i) => (
          <li key={`${w.code}-${w.ruleKey ?? ""}-${i}`}>
            <Alert tone={w.code === "unverified_rule_applied" ? "danger" : "warning"} title={WARNING[w.code]}>
              {w.message}
              <span className="mt-1 block text-xs text-muted">
                {w.code}
                {w.ruleKey ? ` · ${w.ruleKey}` : ""}
              </span>
            </Alert>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** For customers: the plain provenance line (rate card name and dates come from the caller, never ids). */
function BrandReferences({ cardName, effectiveDate, shipDate }: { cardName: string; effectiveDate: string | null; shipDate: string | null }) {
  return (
    <p className="text-sm text-muted">
      Priced on your rate card <span className="font-medium text-fg">{cardName}</span>
      {effectiveDate ? ` (rates effective ${formatDate(effectiveDate)})` : ""}
      {shipDate ? ` for a ship date of ${formatDate(shipDate)}` : ""}.
    </p>
  );
}

function References({ references, uid }: { references: ShipmentCalculation["references"]; uid: string }) {
  return (
    <section aria-labelledby={`${uid}-refs`} className="space-y-3">
      <SectionHeading id={`${uid}-refs`}>References</SectionHeading>
      <Card className="space-y-5 text-sm">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
          <Detail label="Rate card">
            <span className="font-mono text-xs break-all">{references.rateCardId}</span>
          </Detail>
          <Detail label="Rate card version">
            Version {references.rateCardVersionNumber}
            <span className="block font-mono text-xs font-normal break-all text-muted">{references.rateCardVersionId}</span>
          </Detail>
          <Detail label="Terms version">{references.termsVersion ? <span className="font-mono text-xs break-all">{references.termsVersion}</span> : "—"}</Detail>
          <Detail label="Engine">{references.engineVersion}</Detail>
        </dl>
        <div>
          <p className="text-xs font-medium text-muted">Rules evaluated</p>
          {references.rules.length ? (
            <ul className="mt-1 space-y-1.5">
              {references.rules.map((r) => (
                <li key={`${r.key}@${r.version}`}>
                  <RuleLine rule={r} audience="staff" />
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-muted">No surcharge rules applied to this shipment.</p>
          )}
        </div>
        {references.zipLists.length ? (
          <div>
            <p className="text-xs font-medium text-muted">ZIP lists</p>
            <ul className="mt-1 space-y-1 text-xs text-muted">
              {references.zipLists.map((l) => (
                <li key={`${l.key}@${l.version}`}>
                  <span className="font-mono">
                    {l.key}@v{l.version}
                  </span>{" "}
                  · {l.sourceReference}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {references.overrides.length ? (
          <div>
            <p className="text-xs font-medium text-muted">Customer exceptions</p>
            <ul className="mt-1 space-y-1 text-xs text-muted">
              {references.overrides.map((o) => (
                <li key={`${o.ruleKey}-${o.mode}`}>
                  <span className="font-mono">{o.ruleKey}</span> · {o.mode.replace(/_/g, " ")} · {o.reference}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Order fees ("What's in the box")
// ---------------------------------------------------------------------------

/** Fee lines come from the customer's fee schedule, not from the rate card the shipping lines are read from. */
const BRAND_FEE_CLASS: Record<OrderFeeLineView["chargeClass"], { label: string; tone: "success" | "warning" }> = {
  definite: { label: "From your fee schedule", tone: "success" },
  estimated: { label: "Based on assumptions", tone: "warning" },
};

function FeeLineRow({ line, audience }: { line: OrderFeeLineView; audience: ResultAudience }) {
  const cls = audience === "brand" ? BRAND_FEE_CLASS[line.chargeClass] : CHARGE_CLASS[line.chargeClass];
  return (
    <li className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium break-words">{line.name}</span>
          <Badge tone={cls.tone}>{cls.label}</Badge>
        </div>
        <p className="text-sm text-muted">{line.explanation}</p>
        {audience === "staff" && line.ruleKey ? <span className="font-mono text-xs text-muted">{line.ruleKey}</span> : null}
      </div>
      <span className="tabular shrink-0 pt-0.5 font-medium">{dollars(line.amount)}</span>
    </li>
  );
}

function NotComputedRow({ item, audience, onAdd }: { item: OrderFeeNotComputedView; audience: ResultAudience; onAdd?: (field: BoxFieldRef) => void }) {
  const add = item.add;
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium break-words">{item.name}</span>
          <Badge tone="neutral">Not computed</Badge>
        </div>
        <p className="text-sm text-muted">{item.reason}</p>
        {item.rate ? <p className="text-sm text-muted">Rate: {item.rate}</p> : null}
        {audience === "staff" && item.ruleKey ? <span className="font-mono text-xs text-muted">{item.ruleKey}</span> : null}
      </div>
      {add && onAdd ? (
        // Several fees can ask for the same thing (three packaging fees, one "Choose packaging" each): the name says which fee it is for.
        <Button type="button" size="md" variant="secondary" className="self-start" aria-label={`${add.label} (${item.name})`} onClick={() => onAdd(add.field)}>
          {add.label}
        </Button>
      ) : null}
    </li>
  );
}

/**
 * The order fees of one result: shipping, order fees and their sum for this order under the heading that
 * says monthly charges are not included, every fee with its explanation, and every fee that could not be
 * computed with the reason, the rate and what to add. A fee left out is never shown as $0 and a figure that
 * leaves some out reads "At least". Staff additionally see the rule key of each line.
 */
export function OrderFeesSection({ fees, audience, uid, onAdd }: { fees: OrderFeesView; audience: ResultAudience; uid: string; onAdd?: (field: BoxFieldRef) => void }) {
  const partial = fees.status !== "ok";
  const left = fees.notComputed.length;
  // "Add what is missing" only when something can be added; a fee that depends on the monthly volume cannot be.
  const addable = fees.notComputed.some((n) => n.add !== null);
  const atLeast = partial && fees.orderFees !== null ? " (at least)" : "";
  return (
    <section aria-labelledby={`${uid}-fees`} className="space-y-3">
      <SectionHeading id={`${uid}-fees`}>Shipping + order fees for this order (monthly charges not included)</SectionHeading>
      <p className="text-sm text-muted">
        In the box: {fees.box}. Fee schedule <span className="font-medium text-fg">{fees.schedule.name}</span>, in effect from {formatDate(fees.schedule.effectiveDate)}
        {audience === "staff" && fees.schedule.versionNumber !== undefined ? ` (version ${fees.schedule.versionNumber})` : ""}.
      </p>
      {/* Two columns from sm and three from lg: a text-4xl figure such as "$1,234.56" or "Not computed" does not fit three narrow columns. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Stat label="Shipping" value={dollars(fees.shipping)} note={`${audience === "brand" ? "Estimated" : "Expected"} shipping cost of this shipment.`} />
        <Stat
          label={`Order fees${atLeast}`}
          value={fees.orderFees === null ? "Not computed" : dollars(fees.orderFees)}
          note={
            fees.orderFees === null
              ? addable
                ? "Add what is missing to see them."
                : "They depend on information this calculator does not ask for."
              : left
                ? `${left === 1 ? "1 fee is" : `${left} fees are`} left out below.`
                : fees.lines.length
                  ? "Every fee that applies to this box is counted. An estimate, not an invoice."
                  : "No fee applies to this box."
          }
        />
        <Stat
          label={`Shipping + order fees${atLeast}`}
          value={fees.combined === null ? "Not computed" : dollars(fees.combined)}
          note={partial ? "Leaves out the fees listed below; an estimate, not an invoice." : "An estimate, not an invoice."}
        />
      </div>
      {fees.lines.length ? (
        <Card className="px-5 py-4 sm:px-6">
          <h4 className="font-medium">Order fees</h4>
          <ul className="mt-1 divide-y divide-line">
            {fees.lines.map((line, i) => (
              <FeeLineRow key={`${i}-${line.name}`} line={line} audience={audience} />
            ))}
          </ul>
        </Card>
      ) : fees.status === "ok" ? (
        <p className="text-sm text-muted">No order fees apply to what is in the box.</p>
      ) : null}
      {left ? (
        <Card className="px-5 py-4 sm:px-6">
          <h4 className="font-medium">Not computed</h4>
          <p className="text-sm text-muted">These fees are left out of the totals above, not counted as $0.</p>
          <ul className="mt-1 divide-y divide-line">
            {fees.notComputed.map((item, i) => (
              <NotComputedRow key={`${i}-${item.name}`} item={item} audience={audience} onAdd={onAdd} />
            ))}
          </ul>
        </Card>
      ) : null}
      {fees.notes.map((note) => (
        <p key={note} className="text-sm text-muted">
          {note}
        </p>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export function CalculationResult({
  result,
  audience = "staff",
  cardName,
  effectiveDate,
  shipDate,
  fees,
  onAddFeeInput,
}: {
  result: ShipmentCalculation;
  audience?: ResultAudience;
  cardName?: string;
  effectiveDate?: string | null;
  shipDate?: string | null;
  /** Order fees of this result; when omitted, the ones stored with a saved result (if any). null = none to show. */
  fees?: OrderFeesView | null;
  /** Calculator only: focuses the box field a not-computed fee needs. */
  onAddFeeInput?: (field: BoxFieldRef) => void;
}) {
  const unavailable = result.status === "unavailable";
  const orderFees = fees === undefined ? ((result as StoredShipmentResult).orderFees ?? null) : fees;
  // Section ids are unique per result, so several results on one page (the comparison) stay distinct for assistive technology.
  const uid = useId();
  return (
    <div className="space-y-6">
      {unavailable ? (
        <Alert tone="warning" title="No price available">
          {audience === "brand"
            ? `${result.unavailableReason ? UNAVAILABLE[result.unavailableReason] : "This shipment could not be priced"}. This combination is not available on your rate card; contact your 3PL if you expected a price.`
            : (result.unavailableMessage ?? "The engine could not price this shipment from the rate card.")}
          {result.unavailableReason && audience === "staff" ? (
            <span className="mt-1 block text-xs text-muted">
              {UNAVAILABLE[result.unavailableReason]} · {result.unavailableReason}
            </span>
          ) : null}
        </Alert>
      ) : (
        <TotalsRow totals={result.totals} audience={audience} />
      )}
      {!unavailable && isPositive(result.totals.unresolved) ? (
        <Alert>
          Surcharges worth {formatMoney(result.totals.unresolved)} could not be decided from the inputs and are not part of the expected cost. They are listed below as estimates.
        </Alert>
      ) : null}
      <p className="text-sm text-muted">{ESTIMATE_NOTICE}</p>

      {!unavailable && orderFees ? <OrderFeesSection fees={orderFees} audience={audience} uid={uid} onAdd={onAddFeeInput} /> : null}
      {result.packages.length ? <BillableWeights result={result} uid={uid} /> : null}
      {result.zone ? <ZoneLine zone={result.zone} /> : null}
      {result.lines.length ? <ItemizedCharges result={result} audience={audience} uid={uid} /> : null}
      {result.warnings.length ? <Warnings warnings={result.warnings} audience={audience} uid={uid} /> : null}
      {audience === "brand" ? <BrandReferences cardName={cardName ?? "your rate card"} effectiveDate={effectiveDate ?? null} shipDate={shipDate ?? null} /> : <References references={result.references} uid={uid} />}
    </div>
  );
}
