"use client";

import { useId, useState, useTransition } from "react";
import { tryFeeOrder } from "@/app/actions/fee-schedules";
import { Check, Text } from "@/components/fees/controls";
import { UNRESOLVED_REASON_LABELS, WARNING_LABELS, moneyE4 } from "@/components/fees/shared";
import { MONTHLY_TIER_LABELS, buildTryOrderInput, tryOrderShape } from "@/components/fees/try-order-model";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { FeeRule, OrderFeeResult } from "@/engine/fees/types";
import type { FieldErrors } from "@/lib/auth/validation";

/**
 * "Try an order": staff type one order and see exactly what the fee engine charges on this version,
 * draft or active. Nothing is stored. A quantity left blank is unknown, and a fee that needs it is
 * listed as not computed with the reason; it is never shown as $0. Priced by the `tryFeeOrder` action,
 * which runs the same engine the customer's models use.
 */

export interface Priced {
  result: OrderFeeResult;
  versionNumber: number;
}

export function TryOrderPanel({ versionId, rules, packagingTypes, rounding = null }: { versionId: string; rules: FeeRule[]; packagingTypes: string[]; rounding?: string | null }) {
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;
  const [units, setUnits] = useState("");
  const [lines, setLines] = useState("");
  const [products, setProducts] = useState("");
  const [packages, setPackages] = useState<{ key: number; type: string }[]>([{ key: 1, type: "" }]);
  const [nextPackage, setNextPackage] = useState(2);
  const [packagingDefault, setPackagingDefault] = useState("");
  const [shipments, setShipments] = useState("1");
  const [shipTotal, setShipTotal] = useState("");
  const [baseFreight, setBaseFreight] = useState("");
  const [estimated, setEstimated] = useState(false);
  const [shares, setShares] = useState<Record<string, { sharePct: string; count: string }>>({});
  const [monthly, setMonthly] = useState<Record<string, string>>({});
  const [ordinal, setOrdinal] = useState("1");
  const [pending, start] = useTransition();
  // The result is kept with the exact request it answered, so the panel can say when the form no longer matches it.
  const [priced, setPriced] = useState<{ outcome: Priced; request: string } | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);

  // What this version asks for, so the panel only shows fields that can change the answer.
  const { shareDrivers, tierBases } = tryOrderShape(rules);
  const namesByKey = new Map(rules.map((r) => [r.key, r.name]));
  const err = (path: string) => errors[path];

  const input = buildTryOrderInput({
    units,
    lines,
    products,
    packages,
    packagingDefault,
    shipments,
    shipTotal,
    baseFreight,
    estimated,
    shares,
    shareKeys: shareDrivers.map(([key]) => key),
    monthly,
    tierBases,
    ordinal,
  });
  // The rules and the rounding are part of the request: a rule saved above, or another rounding, changes what the same order is charged.
  const request = JSON.stringify([input, rules, rounding]);
  // Edited since it was priced: the amounts on screen belong to the earlier order or rules, not to what the page says now.
  const stale = priced !== null && priced.request !== request;

  const submit = () => {
    setMessage(null);
    setErrors({});
    start(async () => {
      const outcome = await tryFeeOrder(versionId, input);
      if (!outcome.ok) {
        setPriced(null);
        setErrors(outcome.errors ?? {});
        setMessage(outcome.message ?? (outcome.errors ? "Fix the highlighted fields and try again." : "Something went wrong. Please try again."));
        return;
      }
      setPriced({ outcome: { result: outcome.result, versionNumber: outcome.versionNumber }, request });
    });
  };

  // An empty version would otherwise read "every applicable fee was computed: $0.00", which says the order is free.
  if (!rules.length) return <p className="text-sm text-muted">This version has no rules yet, so there is nothing to price. Once it has a rule, you can try an order here.</p>;

  return (
    <div className="space-y-6">
      <datalist id={id("types")}>
        {packagingTypes.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <form
        noValidate
        className="space-y-6"
        aria-label="Try an order"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p className="text-sm text-muted">
          Describe one order and see what this version charges. Leave a box empty when you do not know it: a fee that needs it is listed as not computed, never as $0.
        </p>
        <fieldset className="space-y-4">
          <legend className="text-base font-semibold">What is in the order</legend>
          <div className="grid gap-4 sm:grid-cols-3">
            <Text id={id("units")} label="Items" value={units} onChange={setUnits} error={err("units")} inputMode="numeric" placeholder="e.g. 3" />
            <Text id={id("lines")} label="Order lines" value={lines} onChange={setLines} error={err("lines")} inputMode="numeric" placeholder="e.g. 2" hint="Lines with at least one item." />
            <Text id={id("products")} label="Different products" value={products} onChange={setProducts} error={err("distinctSkus")} inputMode="numeric" placeholder="e.g. 2" hint="Distinct SKUs." />
          </div>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-base font-semibold">Packages</legend>
          <ul className="space-y-3">
            {packages.map((p, i) => (
              <li key={p.key} className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                <Text
                  id={id(`pkg${p.key}`)}
                  label={`Package ${i + 1}: packaging type`}
                  value={p.type}
                  onChange={(type) => setPackages((prev) => prev.map((x) => (x.key === p.key ? { ...x, type } : x)))}
                  error={err(`packages.${i}.packagingType`)}
                  list={id("types")}
                  placeholder="e.g. poly mailer (optional)"
                />
                <Button variant="ghost" className="justify-self-start" onClick={() => setPackages((prev) => prev.filter((x) => x.key !== p.key))} aria-label={`Remove package ${i + 1}`}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              disabled={packages.length >= 50}
              onClick={() => {
                setPackages((prev) => [...prev, { key: nextPackage, type: "" }]);
                setNextPackage((n) => n + 1);
              }}
            >
              Add package
            </Button>
            {!packages.length ? <p className="text-sm text-muted">No packages: per-package fees have nothing to charge.</p> : null}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Text id={id("pkgDefault")} label="Packaging to assume when a package has no type (optional)" value={packagingDefault} onChange={setPackagingDefault} error={err("packagingDefault")} list={id("types")} hint="Fees priced on an assumed type are estimates." />
            <Text id={id("shipments")} label="Shipments" value={shipments} onChange={setShipments} error={err("shipments")} inputMode="numeric" hint="Usually 1." />
          </div>
        </fieldset>

        <fieldset className="space-y-4">
          <legend className="text-base font-semibold">Shipping (for percent-of-shipping fees)</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <Text id={id("shipTotal")} label="Shipping cost of the order (USD)" value={shipTotal} onChange={setShipTotal} error={err("shipping.total")} inputMode="decimal" placeholder="e.g. 8.40" hint="Leave empty if unknown: a percent-of-shipping fee is then not computed." />
            <Text id={id("baseFreight")} label="Base shipping rate (USD, optional)" value={baseFreight} onChange={setBaseFreight} error={err("shipping.baseFreight")} inputMode="decimal" placeholder="e.g. 7.10" hint="Needed only when a fee is a percent of the base rate." />
          </div>
          <Check id={id("estimated")} label="The shipping cost is an estimate" checked={estimated} onChange={setEstimated} />
        </fieldset>

        {shareDrivers.length ? (
          <fieldset className="space-y-4">
            <legend className="text-base font-semibold">Inserts, kits and labels</legend>
            <p className="text-sm text-muted">These apply to a share of orders. Which orders qualify depends on the order&apos;s position in the file.</p>
            {shareDrivers.map(([key, label]) => (
              <div key={key} className="space-y-2 rounded-control bg-surface p-3">
                <p className="text-sm font-medium">{label}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Text
                    id={id(`share-${key}`)}
                    label="Share of orders (%)"
                    value={shares[key]?.sharePct ?? ""}
                    onChange={(sharePct) => setShares((prev) => ({ ...prev, [key]: { sharePct, count: prev[key]?.count ?? "" } }))}
                    error={err(`orderShares.${key}`) ?? err(`orderShares.${key}.sharePct`)}
                    inputMode="decimal"
                    placeholder="e.g. 40"
                  />
                  <Text
                    id={id(`count-${key}`)}
                    label="Count for each order that gets one"
                    value={shares[key]?.count ?? ""}
                    onChange={(count) => setShares((prev) => ({ ...prev, [key]: { sharePct: prev[key]?.sharePct ?? "", count } }))}
                    error={err(`orderShares.${key}.countPerOrder`)}
                    inputMode="numeric"
                    placeholder="e.g. 2"
                  />
                </div>
              </div>
            ))}
            <Text id={id("ordinal")} label="Position of this order in the file (1 = first)" value={ordinal} onChange={setOrdinal} error={err("ordinal")} inputMode="numeric" className="sm:max-w-xs" />
          </fieldset>
        ) : null}

        {tierBases.length ? (
          <fieldset className="space-y-4">
            <legend className="text-base font-semibold">Monthly volume (for tiers read against it)</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              {tierBases.map((b) => (
                <Text
                  key={b}
                  id={id(`monthly-${b}`)}
                  label={MONTHLY_TIER_LABELS[b] ?? b}
                  value={monthly[b] ?? ""}
                  onChange={(value) => setMonthly((prev) => ({ ...prev, [b]: value }))}
                  error={err(`monthlyQuantities.${b}`)}
                  inputMode="decimal"
                  placeholder="e.g. 3000"
                  hint="Empty: a fee tiered on it is not computed."
                />
              ))}
            </div>
          </fieldset>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={pending}>
            {pending ? "Pricing…" : "Price this order"}
          </Button>
        </div>
      </form>

      {message ? <Alert tone="danger">{message}</Alert> : null}

      <div aria-live="polite">
        {priced ? <TryOrderOutcome priced={priced.outcome} namesByKey={namesByKey} stale={stale} /> : null}
      </div>
    </div>
  );
}

export function TryOrderOutcome({ priced, namesByKey, stale = false }: { priced: Priced; namesByKey: Map<string, string>; stale?: boolean }) {
  const { result, versionNumber } = priced;
  const blocking = result.unresolved.filter((u) => u.reason !== "replaced");
  const replaced = result.unresolved.filter((u) => u.reason === "replaced");
  const status =
    result.status === "ok" ? "Every applicable fee was computed." : result.status === "partial" ? "Some fees could not be computed. The amounts below are only what was computed." : "Nothing could be computed from what you entered.";
  // Nothing computed is not $0.00: the totals say so instead of printing zeros.
  const nothing = result.status === "no_content";
  const figure = (e4: number) => (nothing ? <span className="text-muted">Not computed</span> : moneyE4(e4));
  // Rates can carry four decimals. The product rounds an order's total to the cent once everywhere else, so say so when the figures here are finer than that.
  const fractionOfCent = !nothing && (result.definiteE4 % 100 !== 0 || result.estimatedE4 % 100 !== 0 || result.lines.some((l) => l.amountE4 % 100 !== 0));
  return (
    <section aria-labelledby="try-result-heading" className="space-y-4 rounded-card border border-line bg-surface p-4 sm:p-5">
      <div>
        <h3 id="try-result-heading" className="text-base font-semibold">
          What this order would be charged in order fees
        </h3>
        <p className="mt-0.5 text-sm text-muted">Priced on version {versionNumber}. {status}</p>
        <p className="mt-0.5 text-sm text-muted">
          Order fees only, and a trial rather than an invoice. Storage, receiving, returns, flat monthly fees and the account minimum are worked out per month, not per order, so they are not in these amounts.
        </p>
        {fractionOfCent ? (
          <p className="mt-0.5 text-sm text-muted">Some amounts are shown to a fraction of a cent, exactly as priced. A customer&apos;s model rounds an order&apos;s total to the cent once, from these exact amounts.</p>
        ) : null}
      </div>

      {stale ? <Alert tone="warning">You changed the order or the rules after pricing it, so the amounts below are for the earlier ones. Price it again to see what it is charged now.</Alert> : null}

      <dl className="grid gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-sm text-muted">Definite fees</dt>
          <dd className="tabular text-lg font-semibold">{figure(result.definiteE4)}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted">Estimated fees</dt>
          <dd className="tabular text-lg font-semibold">{figure(result.estimatedE4)}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted">{result.status === "ok" ? "Together" : "At least, with the fees not computed left out"}</dt>
          <dd className="tabular text-lg font-semibold">{figure(result.definiteE4 + result.estimatedE4)}</dd>
        </div>
      </dl>

      {result.lines.length ? (
        <ul className="divide-y divide-line overflow-hidden rounded-control border border-line bg-raised">
          {result.lines.map((line, i) => (
            <li key={`${line.ruleKey}-${i}`} className="flex flex-col gap-1 px-3 py-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 [overflow-wrap:anywhere]">
                <p className="font-medium">{line.name}</p>
                <p className="text-sm text-muted">{line.explanation}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2 sm:flex-col sm:items-end">
                <span className="tabular font-semibold">{moneyE4(line.amountE4)}</span>
                <Badge tone={line.chargeClass === "definite" ? "success" : "warning"}>{line.chargeClass === "definite" ? "Definite" : "Estimate"}</Badge>
              </div>
            </li>
          ))}
        </ul>
      ) : nothing ? null : (
        <p className="text-sm text-muted">No fee produced a charge for this order.</p>
      )}

      {blocking.length ? (
        <div className="space-y-1.5">
          <p className="text-sm font-semibold">Not computed</p>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {blocking.map((u, i) => (
              <li key={`${u.ruleKey}-${i}`} className="[overflow-wrap:anywhere]">
                <span className="font-medium">{u.name}</span>: {UNRESOLVED_REASON_LABELS[u.reason]}.
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted">These are left out of the amounts above, not counted as $0.</p>
        </div>
      ) : null}

      {replaced.length ? (
        <div className="space-y-1.5">
          <p className="text-sm font-semibold">Not charged: an alternative applies</p>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {replaced.map((u, i) => (
              <li key={`${u.ruleKey}-${i}`} className="[overflow-wrap:anywhere]">
                <span className="font-medium">{u.name}</span>
                {u.replacedBy ? `, instead of ${namesByKey.get(u.replacedBy) ?? "another rule"}` : ""}.
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {result.warnings.length ? (
        <ul className="space-y-1 text-sm text-muted">
          {result.warnings.map((w) => (
            <li key={w}>{WARNING_LABELS[w] ?? w}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
