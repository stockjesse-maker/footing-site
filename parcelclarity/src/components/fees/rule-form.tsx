"use client";

import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import { saveFeeRule, saveRuleSource } from "@/app/actions/fee-schedules";
import { BASIS_LABELS, CATEGORY_LABELS, SCOPE_LABELS, resolveMinimumMembers, slugify } from "@/components/fees/shared";
import { Area, Check, GroupErrors, Pick, Text } from "@/components/fees/controls";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { describeFeeRule } from "@/engine/fees";
import { FEE_CATEGORIES, MONTHLY_BASES, ORDER_BASES, type BillingPeriod, type FeeBasis, type FeeCategory, type FeeMethod, type FeeRule, type FeeScope, type IncludedPer } from "@/engine/fees/types";
import { ALLOWANCE_BASES, MONTHLY_TIER_BASES, NO_MINIMUM_CHARGE_BASES, PRESETS, TOP_LABELS, blank, buildInput, friendly, isDriverBasis, nounOf, previewOf, splitTypes, valuesFromRule, withBasis, type Values } from "@/components/fees/rule-model";
import type { FieldErrors } from "@/lib/auth/validation";
import { feeRuleInputSchema, ruleFieldErrors } from "@/lib/fees/schema";

/**
 * The rule editor of a draft fee schedule version.
 *
 * Fields appear exactly as `feeRuleInputSchema` (src/lib/fees/schema.ts) allows for the chosen scope,
 * basis and method, and the same schema validates the form live, so the problems shown inline are the
 * ones the server action and the database would raise. A field that does not apply is never sent. The
 * "What your customer will read" panel is `describeFeeRule`, the text the customer's fee schedule uses.
 *
 * Everything the staff type here is customer-visible except the rule key and the "where this number
 * comes from" note, which are labelled as staff-only. Amounts are the 3PL's own fees: no carrier buy
 * rate is asked for or stored.
 */

const toggle = <T,>(list: T[], item: T, on: boolean): T[] => (on ? (list.includes(item) ? list : [...list, item]) : list.filter((x) => x !== item));

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------
export interface RuleFormProps {
  versionId: string;
  /** The rule being edited; null adds a new rule. */
  rule: FeeRule | null;
  /** The staff-only note on where the rule's number comes from (edit only). */
  source: string | null;
  /** Every other rule of the version: for key collisions, pickers and long-term references. */
  otherRules: FeeRule[];
  onSaved: (message: string) => void;
  onCancel: () => void;
}

export function RuleForm({ versionId, rule, source, otherRules: siblingRules, onSaved, onCancel }: RuleFormProps) {
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;
  const creating = rule === null;
  const [values, setValues] = useState<Values>(() => (rule ? valuesFromRule(rule, source) : blank()));
  const [presetId, setPresetId] = useState("");
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // Once this form has saved the rule, it is no longer "another rule" that could collide with the key.
  const otherRules = useMemo(() => siblingRules.filter((r) => r.id === undefined || r.id !== savedId), [siblingRules, savedId]);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    headingRef.current?.scrollIntoView({ block: "start" });
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  const existingKeys = useMemo(() => new Set(otherRules.map((r) => r.key)), [otherRules]);
  const driverRules = useMemo(() => otherRules.filter((r) => r.driver !== undefined && r.driver !== null && r.basis === "driver"), [otherRules]);
  const standardQuantityRules = useMemo(() => driverRules.filter((r) => r.driver?.kind === "monthly_quantity" && !r.driver.longTerm), [driverRules]);
  const driverKeys = useMemo(() => [...new Set(otherRules.map((r) => r.driver?.key).filter((k): k is string => !!k))], [otherRules]);
  const countable = useMemo(() => otherRules.filter((r) => r.basis !== "minimum" && r.basis !== "month"), [otherRules]);

  const set = (patch: Partial<Values>) => {
    setValues((prev) => ({ ...prev, ...patch }));
    setServerErrors({});
    setMessage(null);
  };
  const update = (fn: (prev: Values) => Values) => {
    setValues(fn);
    setServerErrors({});
    setMessage(null);
  };
  const touch = (path: string) => setTouched((prev) => (prev.has(path) ? prev : new Set(prev).add(path)));

  const uniqueKey = (base: string): string => {
    if (!base) return "";
    let key = base.slice(0, 55);
    let n = 2;
    while (existingKeys.has(key)) key = `${base.slice(0, 55)}_${n++}`;
    return key;
  };

  // --- validation: the same schema the server action runs -------------------------------------
  const input = buildInput(values);
  const parsed = feeRuleInputSchema.safeParse(input);
  const clientErrors: FieldErrors = parsed.success ? {} : ruleFieldErrors(parsed.error);
  for (const [k, m] of Object.entries(clientErrors)) clientErrors[k] = friendly(m);
  if (!("key" in clientErrors) && values.key !== "" && existingKeys.has(values.key)) clientErrors.key = "Another rule of this version already uses this key.";
  const visible = (path: string) => submitted || touched.has(path) || [...touched].some((t) => t.startsWith(`${path}.`));
  const errors: FieldErrors = {};
  for (const [k, m] of Object.entries(clientErrors)) if (visible(k)) errors[k] = m;
  for (const [k, m] of Object.entries(serverErrors)) errors[k] = friendly(m);
  const err = (path: string) => errors[path];
  const groupErrors = (prefix: string, handled?: RegExp) => Object.entries(errors).filter(([k]) => (k === prefix || k.startsWith(`${prefix}.`)) && !(handled && handled.test(k))).map(([, m]) => m);

  // --- the rule as the customer will read it ---------------------------------------------------
  const previewRule: FeeRule | null = parsed.success ? previewOf(parsed.data, rule?.position ?? 0) : null;

  const minimumDraft = values.basis === "minimum" ? { amount: values.minAmount || "0", appliesTo: { categories: values.minCategories, includeRuleKeys: values.minInclude, excludeRuleKeys: values.minExclude }, includesShipping: values.minShipping } : null;
  const minimumMembers = minimumDraft ? resolveMinimumMembers(otherRules, minimumDraft) : [];

  // --- handlers --------------------------------------------------------------------------------
  const changeName = (name: string) =>
    update((prev) => {
      const next = { ...prev, name };
      if (creating && !prev.keyTouched) {
        next.key = uniqueKey(slugify(name));
        if (!prev.driverKeyTouched && isDriverBasis(prev.basis)) next.driverKey = next.key;
      }
      return next;
    });

  const changeScope = (scope: FeeScope) =>
    update((prev) => {
      const basis: FeeBasis = scope === "order" ? "order" : "driver";
      const next = withBasis({ ...prev, scope, method: "flat", tiersOn: scope === "monthly" ? "monthly_quantity" : "order_quantity" }, basis);
      if (scope === "monthly") {
        next.exclusiveGroup = "";
        next.priority = "";
      }
      return next;
    });

  const changeBasis = (basis: FeeBasis) => update((prev) => withBasis(prev, basis));

  const changeDriverKey = (driverKey: string) =>
    update((prev) => {
      const next = { ...prev, driverKey, driverKeyTouched: true };
      const same = driverRules.find((r) => r.driver?.key === driverKey);
      // Rules that share a key ask one question, so a known key brings its wording along.
      if (same?.driver && prev.driverLabel.trim() === "" && prev.driverUnit.trim() === "") {
        next.driverLabel = same.driver.label;
        next.driverUnit = same.driver.unit;
        next.driverKind = same.driver.kind === "returns_rate" ? "returns_rate" : "monthly_quantity";
        next.billingPeriod = same.driver.billingPeriod ?? "";
      }
      return next;
    });

  const changeReplaces = (ltReplaces: string) =>
    update((prev) => {
      const next = { ...prev, ltReplaces };
      const standard = standardQuantityRules.find((r) => r.key === ltReplaces);
      // Long-term storage must use the unit and billing period of the rule it replaces.
      if (standard?.driver) {
        next.driverUnit = standard.driver.unit;
        next.billingPeriod = standard.driver.billingPeriod ?? "";
      }
      return next;
    });

  const applyPreset = (presetKey: string) => {
    setPresetId(presetKey);
    const p = PRESETS.find((x) => x.id === presetKey);
    update((prev) => {
      const kept = { description: prev.description, helpText: prev.helpText, source: prev.source };
      if (!p) return { ...blank(), ...kept };
      const next: Values = { ...blank(), ...kept, ...p.values };
      next.key = uniqueKey(slugify(next.name));
      if (next.driverKey === "" && isDriverBasis(next.basis)) next.driverKey = next.key;
      if (p.id === "long_term") {
        const standard = standardQuantityRules.find((r) => r.driver?.unit === "pallets") ?? standardQuantityRules[0];
        if (standard) {
          next.ltReplaces = standard.key;
          next.driverUnit = standard.driver?.unit ?? next.driverUnit;
          next.billingPeriod = standard.driver?.billingPeriod ?? "";
        }
      }
      return next;
    });
    setTouched(new Set());
    setSubmitted(false);
  };

  const submit = () => {
    setSubmitted(true);
    setMessage(null);
    if (!parsed.success || clientErrors.key) {
      setTimeout(() => summaryRef.current?.focus(), 0);
      return;
    }
    start(async () => {
      const result = await saveFeeRule(versionId, savedId ?? rule?.id ?? null, input);
      if (!result.ok) {
        setServerErrors(result.errors ?? {});
        setMessage(result.message ?? null);
        setTimeout(() => summaryRef.current?.focus(), 0);
        return;
      }
      const ruleId = result.ruleId ?? rule?.id ?? null;
      if (ruleId) setSavedId(ruleId);
      const note = values.source.trim() === "" ? null : values.source.trim();
      if (ruleId && note !== (source?.trim() || null)) {
        const noted = await saveRuleSource(ruleId, note);
        if (!noted.ok) {
          // The rule itself is saved: another submit updates it instead of adding a duplicate.
          setMessage(`The rule was saved, but its source note was not: ${noted.errors?.source ?? noted.message ?? "please try again"}`);
          return;
        }
      }
      onSaved(result.message ?? "Rule saved.");
    });
  };

  // --- derived display values ------------------------------------------------------------------
  const noun = nounOf(values);
  const period = values.driverKind === "monthly_quantity" && values.basis === "driver" ? (values.billingPeriod === "week" ? " per week" : values.billingPeriod === "day" ? " per day" : " per month") : "";
  const bases = values.scope === "order" ? ORDER_BASES : MONTHLY_BASES;
  const methodFixed = values.basis === "shipping_percent" || values.basis === "minimum" || values.basis === "month";
  const tiered = values.method === "tiered";
  const showAllowance = values.scope === "order" && ALLOWANCE_BASES.includes(values.basis) && !tiered;
  const showMinCharge = !NO_MINIMUM_CHARGE_BASES.includes(values.basis);
  const monthlyTierAllowed = values.scope === "order" && MONTHLY_TIER_BASES.includes(values.basis);
  const pricingLocked = values.tiersMode === "graduated" || (values.scope === "order" && values.tiersOn === "monthly_quantity");
  const order = values.scope === "order";
  const preset = PRESETS.find((p) => p.id === presetId);
  const hasConditions = [values.minUnits, values.maxUnits, values.minLines, values.maxLines, values.minPackages, values.maxPackages, values.packagingTypes].some((x) => x.trim() !== "");
  const conditionsInvalid = Object.keys(errors).some((k) => k === "conditions" || k.startsWith("conditions."));
  const groupInvalid = Object.keys(errors).some((k) => k === "exclusiveGroup" || k === "priority");
  const [conditionsOpen] = useState(hasConditions);
  const [groupOpen] = useState(values.exclusiveGroup.trim() !== "");
  const rateLabel = values.basis === "month" ? "Amount per month (USD)" : values.basis === "order" ? "Amount per order (USD)" : `Amount per ${noun.singular}${period} (USD)`;
  const methodOptions: { value: FeeMethod; label: string }[] = [
    { value: "flat", label: "The same rate for every unit" },
    { value: "tiered", label: "A rate that depends on the quantity (tiers)" },
  ];
  const summary = Object.entries(errors).map(([path, m]) => ({ path, label: TOP_LABELS[path.split(".")[0] ?? ""] ?? path, message: m }));
  const showSummary = (submitted || Object.keys(serverErrors).length > 0) && (summary.length > 0 || message !== null);

  const legend = "text-base font-semibold";

  return (
    <form
      noValidate
      aria-labelledby={id("heading")}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="space-y-8"
    >
      <datalist id={id("driverKeys")}>
        {driverKeys.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>

      <h3 id={id("heading")} ref={headingRef} tabIndex={-1} className="text-lg font-semibold tracking-tight outline-none">
        {creating ? "Add a rule" : `Edit rule: ${rule.name}`}
      </h3>

      {creating ? (
        <fieldset className="space-y-3">
          <legend className={legend}>Start from</legend>
          <Pick
            id={id("preset")}
            label="Preset"
            value={presetId}
            onChange={applyPreset}
            options={[{ value: "", label: "Start from scratch" }, ...PRESETS.map((p) => ({ value: p.id, label: p.label }))]}
            hint={preset ? preset.hint : "A preset fills in the structure of a common charge. You still enter the amount, and you can change anything it sets."}
          />
        </fieldset>
      ) : null}

      <fieldset className="space-y-4">
        <legend className={legend}>The charge</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Text id={id("name")} label="Name" value={values.name} onChange={changeName} onBlur={() => touch("name")} error={err("name")} placeholder="e.g. Pick & pack, per order" hint="Customers read this name." maxLength={120} />
          <Pick<FeeCategory>
            id={id("category")}
            label="Category"
            value={values.category}
            onChange={(category) => set({ category })}
            options={FEE_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))}
            error={err("category")}
            hint="Groups the charge on the customer's fee schedule and in an account minimum."
          />
          <Text
            id={id("key")}
            label="Key (staff only)"
            value={values.key}
            onChange={(key) => set({ key, keyTouched: true })}
            onBlur={() => touch("key")}
            error={err("key")}
            readOnly={!creating}
            maxLength={61}
            hint={creating ? "An internal identifier other rules refer to: lower-case letters, digits and underscores. Customers never see it. It cannot change once saved." : "The key is fixed once the rule exists; other rules may refer to it."}
          />
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className={legend}>How it is priced</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Pick<FeeScope>
            id={id("scope")}
            label="Charged"
            value={values.scope}
            onChange={changeScope}
            options={[
              { value: "order", label: `${SCOPE_LABELS.order}: worked out for each order from what is in it` },
              { value: "monthly", label: `${SCOPE_LABELS.monthly}: worked out from quantities your customer states` },
            ]}
            error={err("scope")}
          />
          <Pick<FeeBasis> id={id("basis")} label="Charged per" value={values.basis} onChange={changeBasis} options={bases.map((b) => ({ value: b, label: BASIS_LABELS[b] }))} error={err("basis")} />
          {!methodFixed ? <Pick<FeeMethod> id={id("method")} label="Pricing" value={values.method} onChange={(method) => set({ method })} options={methodOptions} error={err("method")} /> : null}
        </div>

        {values.method === "flat" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Text id={id("amount")} label={rateLabel} value={values.amount} onChange={(amount) => set({ amount })} onBlur={() => touch("amount")} error={err("amount")} inputMode="decimal" placeholder="e.g. 2.50" hint="Up to 4 decimals, for example 0.0125." />
          </div>
        ) : null}

        {values.method === "percent" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Text id={id("percent")} label="Percentage" value={values.percent} onChange={(percent) => set({ percent })} onBlur={() => touch("percent")} error={err("percent")} inputMode="decimal" placeholder="e.g. 5" hint="Enter 5 for 5%." />
            <Pick
              id={id("percentBase")}
              label="Taken of"
              value={values.percentBase}
              onChange={(percentBase) => set({ percentBase })}
              options={[
                { value: "shipping_total", label: "The order's shipping cost (base rate plus counted surcharges)" },
                { value: "base_freight", label: "The base shipping rate only" },
              ]}
              error={err("percentBase")}
            />
          </div>
        ) : null}

        {values.method === "minimum" ? <p className="text-sm text-muted">An account minimum is set below. It is charged only when the fees counted toward it fall short.</p> : null}
        {values.basis === "month" ? <p className="text-sm text-muted">A flat monthly fee is the same every month, whatever the customer ships.</p> : null}

        {tiered ? (
          <div className="space-y-4 rounded-control border border-line p-4">
            <p className="text-sm font-semibold">Tiers</p>
            <div className="grid gap-4 sm:grid-cols-2">
              {order ? (
                <Pick
                  id={id("tiersOn")}
                  label="Brackets are read against"
                  value={values.tiersOn}
                  onChange={(tiersOn) => set({ tiersOn })}
                  options={[
                    { value: "order_quantity", label: `This order's number of ${noun.plural}` },
                    ...(monthlyTierAllowed ? [{ value: "monthly_quantity" as const, label: `Your customer's monthly volume of ${noun.plural}` }] : []),
                  ]}
                  error={err("tiers.on")}
                  hint={values.tiersOn === "monthly_quantity" ? "Worked out once for a whole model from how many the customer ships in a month, so the more they ship, the lower the rate. Always priced per unit." : undefined}
                />
              ) : (
                <p className="self-end text-sm text-muted">Brackets are read against the quantity your customer states for the month.</p>
              )}
              <Pick
                id={id("tiersMode")}
                label="How brackets add up"
                value={values.tiersMode}
                onChange={(tiersMode) => set({ tiersMode })}
                options={[
                  { value: "graduated", label: "Graduated: each unit at the rate of its own bracket" },
                  { value: "volume", label: "Volume: the whole quantity at the rate of the bracket it falls in" },
                ]}
                error={err("tiers.mode")}
              />
              {values.tiersMode === "volume" ? (
                <Pick
                  id={id("tiersPricing")}
                  label="Each bracket sets"
                  value={pricingLocked ? "rate" : values.tiersPricing}
                  disabled={pricingLocked}
                  onChange={(tiersPricing) => set({ tiersPricing })}
                  options={[
                    { value: "rate", label: `A rate per ${noun.singular}` },
                    { value: "flat", label: "One price for the whole bracket" },
                  ]}
                  error={err("tiers.pricing")}
                />
              ) : null}
            </div>
            <ul className="space-y-3">
              {values.brackets.map((b, i) => {
                const last = i === values.brackets.length - 1;
                const previous = i > 0 ? values.brackets[i - 1]?.upTo.trim() : "";
                const flat = values.tiersMode === "volume" && !pricingLocked && values.tiersPricing === "flat";
                return (
                  <li key={i} className="grid gap-3 rounded-control bg-surface p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                    {last ? (
                      <p className="text-sm sm:pb-3">
                        <span className="font-medium">Bracket {i + 1}</span>
                        <span className="block text-muted">{i === 0 ? `Every quantity` : `Above ${previous || "…"} ${noun.plural}`}, no upper limit</span>
                      </p>
                    ) : (
                      <Text
                        id={id(`upTo${i}`)}
                        label={`Bracket ${i + 1}: up to (${noun.plural}, inclusive)`}
                        value={b.upTo}
                        onChange={(upTo) => update((prev) => ({ ...prev, brackets: prev.brackets.map((x, j) => (j === i ? { ...x, upTo } : x)) }))}
                        onBlur={() => touch(`tiers.brackets.${i}.upTo`)}
                        error={err(`tiers.brackets.${i}.upTo`)}
                        inputMode="decimal"
                        placeholder="e.g. 10"
                      />
                    )}
                    <Text
                      id={id(`bracketAmount${i}`)}
                      label={`Bracket ${i + 1}: ${flat ? "price for the whole bracket" : `rate per ${noun.singular}`} (USD)`}
                      value={b.amount}
                      onChange={(amount) => update((prev) => ({ ...prev, brackets: prev.brackets.map((x, j) => (j === i ? { ...x, amount } : x)) }))}
                      onBlur={() => touch(`tiers.brackets.${i}.amount`)}
                      error={err(`tiers.brackets.${i}.amount`)}
                      inputMode="decimal"
                      placeholder="e.g. 0.40"
                    />
                    {values.brackets.length > 1 ? (
                      <Button variant="ghost" className="justify-self-start" onClick={() => update((prev) => ({ ...prev, brackets: prev.brackets.filter((_, j) => j !== i) }))} aria-label={`Remove bracket ${i + 1}`}>
                        Remove
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <GroupErrors messages={groupErrors("tiers", /^tiers\.(on|mode|pricing|brackets\.\d+\.(upTo|amount))$/)} />
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="secondary"
                disabled={values.brackets.length >= 50}
                onClick={() =>
                  update((prev) => {
                    const tail = prev.brackets[prev.brackets.length - 1];
                    return { ...prev, brackets: [...prev.brackets.slice(0, -1), { upTo: "", amount: "" }, ...(tail ? [tail] : [])] };
                  })
                }
              >
                Add bracket
              </Button>
              <p className="text-sm text-muted">Brackets run in ascending order. For a free allowance, make the first bracket $0.00.</p>
            </div>
          </div>
        ) : null}

        {showAllowance ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Text
              id={id("includedQuantity")}
              label="Free allowance (quantity)"
              value={values.includedQuantity}
              onChange={(includedQuantity) => set({ includedQuantity })}
              onBlur={() => touch("includedQuantity")}
              error={err("includedQuantity")}
              inputMode="decimal"
              placeholder="e.g. 1"
              hint={`Subtracted from the quantity before pricing: 1 makes the first ${noun.singular} free.`}
            />
            {values.includedQuantity.trim() !== "" ? (
              <Pick<IncludedPer>
                id={id("includedPer")}
                label="Free allowance applies to each"
                value={values.includedPer}
                onChange={(includedPer) => set({ includedPer })}
                options={[
                  { value: "order", label: "Order" },
                  { value: "line", label: "Order line" },
                  { value: "sku", label: "Product" },
                  { value: "shipment", label: "Shipment" },
                ]}
                error={err("includedPer")}
              />
            ) : null}
          </div>
        ) : null}

        {showMinCharge ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Text
              id={id("minimumCharge")}
              label={`Minimum charge per ${order ? "order" : "month"} (USD, optional)`}
              value={values.minimumCharge}
              onChange={(minimumCharge) => set({ minimumCharge })}
              onBlur={() => touch("minimumCharge")}
              error={err("minimumCharge")}
              inputMode="decimal"
              placeholder="None"
              hint="Charged instead of the computed amount when that is lower, but only when something is chargeable."
            />
          </div>
        ) : null}
      </fieldset>

      {isDriverBasis(values.basis) ? (
        <fieldset className="space-y-4">
          <legend className={legend}>The question your customer answers</legend>
          <p className="text-sm text-muted">
            {values.basis === "order_driver"
              ? "Your customer says what share of their orders get this, and how many each qualifying order gets."
              : values.driverKind === "returns_rate"
                ? "Your customer says how many of every 100 orders come back. The count scales with their order volume."
                : "Your customer states a quantity for a month. It is never filled in from what they ship, and a blank answer is left out of the model rather than treated as zero."}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Text
              id={id("driverKey")}
              label="Question key (staff only)"
              value={values.driverKey}
              onChange={changeDriverKey}
              onBlur={() => touch("driver.key")}
              error={err("driver.key")}
              list={id("driverKeys")}
              maxLength={61}
              hint="Rules that give the same key ask the customer one question, answered once."
            />
            {values.basis === "driver" ? (
              <Pick<"monthly_quantity" | "returns_rate">
                id={id("driverKind")}
                label="The answer is"
                value={values.driverKind}
                onChange={(driverKind) => set({ driverKind, longTerm: driverKind === "returns_rate" ? false : values.longTerm })}
                options={[
                  { value: "monthly_quantity", label: "A quantity for the month" },
                  { value: "returns_rate", label: "A percent of orders (returns)" },
                ]}
                error={err("driver.kind")}
              />
            ) : null}
            <Text
              id={id("driverLabel")}
              label="The question"
              value={values.driverLabel}
              onChange={(driverLabel) => set({ driverLabel })}
              onBlur={() => touch("driver.label")}
              error={err("driver.label")}
              maxLength={200}
              placeholder="e.g. Pallets of your products stored, on average"
              hint="Customers read this exactly, in your words."
              className="sm:col-span-2"
            />
            <Text id={id("driverUnit")} label="Unit word" value={values.driverUnit} onChange={(driverUnit) => set({ driverUnit })} onBlur={() => touch("driver.unit")} error={err("driver.unit")} maxLength={40} placeholder="e.g. pallets" hint="Plural, as in 12 pallets." />
            {values.basis === "driver" && values.driverKind === "monthly_quantity" ? (
              <Pick<"" | BillingPeriod>
                id={id("billingPeriod")}
                label="Rate is billed per"
                value={values.billingPeriod}
                onChange={(billingPeriod) => set({ billingPeriod })}
                options={[
                  { value: values.billingPeriod === "month" ? "month" : "", label: "Month" },
                  { value: "week", label: "Week" },
                  { value: "day", label: "Day" },
                ]}
                error={err("driver.billingPeriod")}
                hint="A weekly or daily rate is converted to a month at 30.4375 days."
              />
            ) : null}
          </div>
          {values.basis === "driver" && values.driverKind === "monthly_quantity" ? (
            <div className="space-y-3">
              <Check
                id={id("longTerm")}
                label="This is long-term storage: part of a standard storage quantity held longer than a number of days"
                checked={values.longTerm}
                onChange={(longTerm) => set({ longTerm })}
              />
              {values.longTerm ? (
                <div className="grid gap-4 rounded-control border border-line p-4 sm:grid-cols-3">
                  <Pick<"replace" | "surcharge">
                    id={id("ltMode")}
                    label="Long-term units are billed"
                    value={values.ltMode}
                    onChange={(ltMode) => set({ ltMode })}
                    options={[
                      { value: "replace", label: "At this rate instead of the standard rate" },
                      { value: "surcharge", label: "At this rate on top of the standard rate" },
                    ]}
                    error={err("driver.longTerm.mode")}
                  />
                  <Pick
                    id={id("ltReplaces")}
                    label="Part of the standard rule"
                    value={values.ltReplaces}
                    onChange={changeReplaces}
                    options={[{ value: "", label: standardQuantityRules.length ? "Choose a rule…" : "Add the standard storage rule first" }, ...standardQuantityRules.map((r) => ({ value: r.key, label: r.name }))]}
                    error={err("driver.longTerm.replacesRuleKey")}
                    hint="It must use the same unit and billing period."
                  />
                  <Text id={id("ltDays")} label="Held longer than (days)" value={values.ltDays} onChange={(ltDays) => set({ ltDays })} onBlur={() => touch("driver.longTerm.thresholdDays")} error={err("driver.longTerm.thresholdDays")} inputMode="numeric" />
                </div>
              ) : null}
            </div>
          ) : null}
          <GroupErrors messages={groupErrors("driver", /^driver\./)} />
        </fieldset>
      ) : null}

      {values.basis === "minimum" ? (
        <fieldset className="space-y-4">
          <legend className={legend}>The account minimum</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <Text id={id("minAmount")} label="Minimum per month (USD)" value={values.minAmount} onChange={(minAmount) => set({ minAmount })} onBlur={() => touch("minimum.amount")} error={err("minimum.amount")} inputMode="decimal" placeholder="e.g. 500" />
          </div>
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">Fees in these categories count toward it</legend>
            <p className="text-sm text-muted">Tick none to count every fee except flat monthly fees and other minimums.</p>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3">
              {FEE_CATEGORIES.map((c) => (
                <Check key={c} id={id(`mincat-${c}`)} label={CATEGORY_LABELS[c]} checked={values.minCategories.includes(c)} onChange={(on) => set({ minCategories: toggle(values.minCategories, c, on) })} />
              ))}
            </div>
          </fieldset>
          {countable.length ? (
            <>
              <fieldset className="space-y-1">
                <legend className="text-sm font-medium">Also count these fees (optional)</legend>
                <div className="grid sm:grid-cols-2">
                  {countable.map((r) => (
                    <Check key={r.key} id={id(`mininc-${r.key}`)} label={r.name} checked={values.minInclude.includes(r.key)} onChange={(on) => set({ minInclude: toggle(values.minInclude, r.key, on) })} />
                  ))}
                </div>
              </fieldset>
              <fieldset className="space-y-1">
                <legend className="text-sm font-medium">Never count these fees (optional)</legend>
                <div className="grid sm:grid-cols-2">
                  {countable.map((r) => (
                    <Check key={r.key} id={id(`minexc-${r.key}`)} label={r.name} checked={values.minExclude.includes(r.key)} onChange={(on) => set({ minExclude: toggle(values.minExclude, r.key, on) })} />
                  ))}
                </div>
              </fieldset>
            </>
          ) : null}
          <Check id={id("minShipping")} label="Shipping charges count toward the minimum too" checked={values.minShipping} onChange={(minShipping) => set({ minShipping })} />
          <div className="rounded-control bg-surface p-3 text-sm" aria-live="polite">
            {minimumMembers.length ? (
              <p>
                <span className="font-medium">Counts {minimumMembers.length === 1 ? "1 fee" : `${minimumMembers.length} fees`}: </span>
                {minimumMembers.map((m) => m.name).join(", ")}.
              </p>
            ) : (
              <p className="font-medium text-warning">No fee counts toward this minimum yet. Activation is refused for a minimum that counts nothing.</p>
            )}
            <p className="mt-1 text-muted">A version can have up to three minimums, and no fee may count toward two of them. Which fees count is fixed when the version is activated.</p>
          </div>
          <GroupErrors messages={groupErrors("minimum", /^minimum\.amount$/)} />
        </fieldset>
      ) : null}

      {order ? (
        <details className="rounded-control border border-line" open={conditionsOpen || conditionsInvalid}>
          <summary className="flex min-h-11 cursor-pointer items-center px-4 text-base font-semibold">Only some orders (optional)</summary>
          <div className="space-y-4 border-t border-line p-4">
            <p className="text-sm text-muted">The charge applies only to orders that fall inside every range you fill in. Leave a box empty for no limit.</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Text id={id("minUnits")} label="Fewest items" value={values.minUnits} onChange={(minUnits) => set({ minUnits })} onBlur={() => touch("conditions.minUnits")} error={err("conditions.minUnits")} inputMode="numeric" />
              <Text id={id("maxUnits")} label="Most items" value={values.maxUnits} onChange={(maxUnits) => set({ maxUnits })} onBlur={() => touch("conditions.maxUnits")} error={err("conditions.maxUnits")} inputMode="numeric" />
              <Text id={id("minLines")} label="Fewest order lines" value={values.minLines} onChange={(minLines) => set({ minLines })} onBlur={() => touch("conditions.minLines")} error={err("conditions.minLines")} inputMode="numeric" />
              <Text id={id("maxLines")} label="Most order lines" value={values.maxLines} onChange={(maxLines) => set({ maxLines })} onBlur={() => touch("conditions.maxLines")} error={err("conditions.maxLines")} inputMode="numeric" />
              <Text id={id("minPackages")} label="Fewest packages" value={values.minPackages} onChange={(minPackages) => set({ minPackages })} onBlur={() => touch("conditions.minPackages")} error={err("conditions.minPackages")} inputMode="numeric" />
              <Text id={id("maxPackages")} label="Most packages" value={values.maxPackages} onChange={(maxPackages) => set({ maxPackages })} onBlur={() => touch("conditions.maxPackages")} error={err("conditions.maxPackages")} inputMode="numeric" />
            </div>
            {values.basis === "package" ? (
              <Text
                id={id("packagingTypes")}
                label="Packaging types this applies to"
                value={values.packagingTypes}
                onChange={(packagingTypes) => set({ packagingTypes })}
                onBlur={() => touch("conditions.packagingTypes")}
                error={err("conditions.packagingTypes")}
                placeholder="e.g. poly mailer, box"
                hint={
                  <>
                    Separate types with commas. Matching ignores case and extra spaces; use * for any other packaging.
                    {splitTypes(values.packagingTypes).length ? <span className="mt-1 block">Matches: {splitTypes(values.packagingTypes).join(", ")}</span> : null}
                  </>
                }
              />
            ) : null}
            <GroupErrors messages={groupErrors("conditions", /^conditions\./)} />
          </div>
        </details>
      ) : null}

      {order ? (
        <details className="rounded-control border border-line" open={groupOpen || groupInvalid}>
          <summary className="flex min-h-11 cursor-pointer items-center px-4 text-base font-semibold">Alternatives (optional)</summary>
          <div className="space-y-4 border-t border-line p-4">
            <p className="text-sm text-muted">
              Rules in the same group compete: only the one with the lowest priority number that applies is charged, and the others are listed as replaced. Rules in a group must be priced per the same thing and
              have different priorities.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Text id={id("exclusiveGroup")} label="Group name (staff only)" value={values.exclusiveGroup} onChange={(exclusiveGroup) => set({ exclusiveGroup })} onBlur={() => touch("exclusiveGroup")} error={err("exclusiveGroup")} placeholder="e.g. packaging" maxLength={41} />
              <Text id={id("priority")} label="Priority (lowest number wins)" value={values.priority} onChange={(priority) => set({ priority })} onBlur={() => touch("priority")} error={err("priority")} inputMode="numeric" placeholder="e.g. 1" />
            </div>
          </div>
        </details>
      ) : null}

      <fieldset className="space-y-4">
        <legend className={legend}>What your customer will read</legend>
        <Area
          id={id("description")}
          label="Description (optional)"
          value={values.description}
          onChange={(description) => set({ description })}
          onBlur={() => touch("description")}
          error={err("description")}
          maxLength={2000}
          hint="Shown under the charge on the customer's fee schedule. The rate itself is written for you below."
        />
        <Area
          id={id("helpText")}
          label={isDriverBasis(values.basis) ? "Help with the question (optional)" : "Extra note (optional)"}
          value={values.helpText}
          onChange={(helpText) => set({ helpText })}
          onBlur={() => touch("helpText")}
          error={err("helpText")}
          rows={2}
          maxLength={1000}
          hint={isDriverBasis(values.basis) ? "Shown while your customer answers the question, for example how to count pallets." : "Shown with the charge."}
        />
        <div className="rounded-control border border-line bg-surface p-4">
          <p className="text-sm font-semibold">Preview</p>
          {previewRule ? (
            <div className="mt-2 space-y-1.5 [overflow-wrap:anywhere]">
              <p className="font-medium">{previewRule.name}</p>
              <p className="text-[15px]">{describeFeeRule(previewRule)}</p>
              {previewRule.description ? <p className="text-sm text-muted">{previewRule.description}</p> : null}
              {previewRule.driver ? <p className="text-sm text-muted">Depends on what you tell us: {previewRule.driver.label}</p> : null}
              {previewRule.helpText ? <p className="text-sm text-muted">{previewRule.helpText}</p> : null}
              {minimumDraft ? (
                <p className="text-sm text-muted">
                  Fees counted toward this minimum: {minimumMembers.length ? minimumMembers.map((m) => m.name).join(", ") : "none yet"}.
                </p>
              ) : null}
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted">Fill in the fields above to see the wording your customer will read.</p>
          )}
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className={legend}>Staff only</legend>
        <Area
          id={id("source")}
          label="Where this number comes from (optional)"
          value={values.source}
          onChange={(source) => set({ source })}
          maxLength={1000}
          rows={2}
          hint="For example the contract clause or pricing sheet. Only your team can read this; customers never see it."
        />
      </fieldset>

      {showSummary ? (
        <div ref={summaryRef} tabIndex={-1} role="alert" className="rounded-control border border-danger/30 bg-danger-soft px-4 py-3 text-sm outline-none">
          <p className="font-semibold">This rule cannot be saved yet</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {message ? <li>{message}</li> : null}
            {summary.map((s) => (
              <li key={s.path}>
                {s.label}: {s.message}
              </li>
            ))}
          </ul>
        </div>
      ) : message ? (
        <Alert tone="warning">{message}</Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={pending}>
          {pending ? "Saving…" : "Save rule"}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={pending}>
          {savedId ? "Close" : "Cancel"}
        </Button>
        <p className="text-sm text-muted">Saved to the draft. Customers see nothing until you activate the version.</p>
      </div>
    </form>
  );
}
