import type { ReactNode } from "react";
import { VerificationBadge } from "@/components/pricing/rule-form";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
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

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const CHARGE_CLASS: Record<ChargeClass, { label: string; tone: "success" | "warning" | "neutral" }> = {
  definite: { label: "Definite", tone: "success" },
  estimated: { label: "Estimated", tone: "warning" },
  conditional: { label: "Conditional", tone: "neutral" },
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

function RuleLine({ rule }: { rule: RuleReference }) {
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

function TotalsRow({ totals }: { totals: ShipmentCalculation["totals"] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Stat label="Expected shipping cost" value={formatMoney(totals.expected)} note="Definite plus estimated charges. Best single estimate, not an invoice." />
      <Stat label="Definite" value={formatMoney(totals.definite)} note="Follows from the rate card and the published terms." />
      <Stat label="Estimated" value={formatMoney(totals.estimated)} note="Rests on an assumption, for example missing dimensions or an unverified source." />
      <Stat label="Possible adjustments" value={formatMoney(totals.conditionalExposure)} note="Post-shipment adjustments that may or may not occur. Not in the expected cost." />
    </div>
  );
}

function BillableWeights({ result }: { result: ShipmentCalculation }) {
  return (
    <section aria-labelledby="calc-weights-heading" className="space-y-3">
      <SectionHeading id="calc-weights-heading">Billable weight</SectionHeading>
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

function ChargeLineRow({ line }: { line: ChargeLine }) {
  const cls = CHARGE_CLASS[line.chargeClass];
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
        {line.rule ? <RuleLine rule={line.rule} /> : null}
      </div>
      <span className={`tabular shrink-0 pt-0.5 font-medium ${struck ? "text-muted line-through" : line.counted ? "" : "text-muted"}`}>
        {formatMoney(line.amount)}
        {!line.counted ? <span className="sr-only"> (not counted)</span> : null}
      </span>
    </li>
  );
}

function ItemizedCharges({ result }: { result: ShipmentCalculation }) {
  const packageCount = Math.max(result.packages.length, result.input.packages.length);
  const groups: { index: number | null; lines: ChargeLine[] }[] = [];
  for (let i = 0; i < packageCount; i++) {
    const lines = result.lines.filter((l) => l.packageIndex === i);
    if (lines.length) groups.push({ index: i, lines });
  }
  const shipmentLines = result.lines.filter((l) => l.packageIndex === null);
  if (shipmentLines.length) groups.push({ index: null, lines: shipmentLines });

  return (
    <section aria-labelledby="calc-lines-heading" className="space-y-3">
      <SectionHeading id="calc-lines-heading">Itemized charges</SectionHeading>
      <Card className="divide-y divide-line p-0 sm:p-0">
        {groups.map((g) => (
          <div key={g.index ?? "shipment"} className="px-5 py-4 sm:px-6">
            <h4 className="font-medium">{packageLabel(g.index)}</h4>
            <ul className="mt-1 divide-y divide-line">
              {g.lines.map((line, i) => (
                <ChargeLineRow key={`${g.index ?? "s"}-${i}-${line.basis}`} line={line} />
              ))}
            </ul>
          </div>
        ))}
      </Card>
    </section>
  );
}

function Warnings({ warnings }: { warnings: ShipmentCalculation["warnings"] }) {
  return (
    <section aria-labelledby="calc-warnings-heading" className="space-y-3">
      <SectionHeading id="calc-warnings-heading">Warnings</SectionHeading>
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

function References({ references }: { references: ShipmentCalculation["references"] }) {
  return (
    <section aria-labelledby="calc-refs-heading" className="space-y-3">
      <SectionHeading id="calc-refs-heading">References</SectionHeading>
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
                  <RuleLine rule={r} />
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
// Result
// ---------------------------------------------------------------------------

export function CalculationResult({ result }: { result: ShipmentCalculation }) {
  const unavailable = result.status === "unavailable";
  return (
    <div className="space-y-6">
      {unavailable ? (
        <Alert tone="warning" title="No price available">
          {result.unavailableMessage ?? "The engine could not price this shipment from the rate card."}
          {result.unavailableReason ? (
            <span className="mt-1 block text-xs text-muted">
              {UNAVAILABLE[result.unavailableReason]} · {result.unavailableReason}
            </span>
          ) : null}
        </Alert>
      ) : (
        <TotalsRow totals={result.totals} />
      )}
      {!unavailable && isPositive(result.totals.unresolved) ? (
        <Alert>
          Surcharges worth {formatMoney(result.totals.unresolved)} could not be decided from the inputs and are not part of the expected cost. They are listed below as estimates.
        </Alert>
      ) : null}
      <p className="text-sm text-muted">{ESTIMATE_NOTICE}</p>

      {result.packages.length ? <BillableWeights result={result} /> : null}
      {result.zone ? <ZoneLine zone={result.zone} /> : null}
      {result.lines.length ? <ItemizedCharges result={result} /> : null}
      {result.warnings.length ? <Warnings warnings={result.warnings} /> : null}
      <References references={result.references} />
    </div>
  );
}
