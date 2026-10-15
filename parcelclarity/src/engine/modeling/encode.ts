import type { FeeBasis, FeeCategory, FeeRule, FeeScope, OrderFeeResult } from "../fees/types";
import { dec } from "../money";
import type { ChargeClass, ChargeLine, DecimalString, LineStatus, RuleReference, ShipmentCalculation, SurchargeCategory } from "../types";
import type { CompactFeeLine, CompactLine, CompactLineClass, CompactLineStatus, CompactResult, FeeDictionaryEntry, FeeStatus, FoldOrderFees, LineDictionaryEntry } from "./types";

/**
 * Dictionary encoding of engine results for bulk runs. A run stores roughly 300 bytes per shipment:
 * each line becomes `[dictionaryIndex, amountCents, status, class, packageIndex]` and one dictionary,
 * shared by the whole run, says what every index stands for. The dictionary is brand-safe by
 * construction: an entry carries the rule key, version, name, category and scope, never the 3PL's
 * source notes or verification state.
 */

const STATUS_CODES: Record<LineStatus, CompactLineStatus> = { charged: "c", included: "i", waived: "w", conditional: "n", unknown: "u" };
const CLASS_CODES: Record<ChargeClass, CompactLineClass> = { definite: "d", estimated: "e", conditional: "c" };
const STATUS_NAMES: Record<CompactLineStatus, LineStatus> = { c: "charged", i: "included", w: "waived", n: "conditional", u: "unknown" };
const CLASS_NAMES: Record<CompactLineClass, ChargeClass> = { d: "definite", e: "estimated", c: "conditional" };

/**
 * A fresh dictionary. Entry 0 is always the base rate and entry 1 the minimum-charge adjustment, so
 * those two indexes mean the same thing in every run whatever order rules were first seen in.
 */
export function createDictionary(): LineDictionaryEntry[] {
  return [
    { kind: "base", key: null, version: null, versionId: null, name: "Base rate", category: "base", scope: null },
    { kind: "minimum", key: null, version: null, versionId: null, name: "Minimum charge adjustment", category: "base", scope: null },
  ];
}

/** Exact integer cents of a money string. The engine rounds every line to cents, so a fraction here is a bug, not a value to round. */
export function moneyToCents(amount: DecimalString): number {
  const cents = dec(amount).times(100);
  if (!cents.isInteger()) throw new RangeError(`amount "${amount}" is not a whole number of cents`);
  return cents.toNumber();
}

export function centsToMoney(cents: number): DecimalString {
  if (!Number.isSafeInteger(cents)) throw new RangeError(`not an integer number of cents: ${cents}`);
  return dec(cents).div(100).toFixed(2);
}

/**
 * Compacts one engine result. Rule lines are looked up by key@version and appended to `dictionary`
 * (mutated in place: it is the run's live dictionary) the first time they are seen. `meta.serviceId`
 * is the service the shipment was priced as, which the engine result does not carry as an id.
 */
export function encodeResult(calc: ShipmentCalculation, dictionary: LineDictionaryEntry[], meta: { serviceId: string | null }): CompactResult {
  if (dictionary[0]?.kind !== "base" || dictionary[1]?.kind !== "minimum") throw new RangeError("the dictionary must start with the base and minimum entries (see createDictionary)");
  const lines: CompactLine[] = calc.lines.map((line) => [lineIndex(dictionary, line), moneyToCents(line.amount.amount), STATUS_CODES[line.status], CLASS_CODES[line.chargeClass], line.packageIndex]);
  return {
    status: calc.status,
    unavailableReason: calc.unavailableReason,
    rateCardVersionId: calc.references.rateCardVersionId,
    shipDate: calc.input.shipDate,
    zone: calc.zone?.zone ?? null,
    serviceId: meta.serviceId,
    billableLb: calc.packages.map((p) => p.billableLb),
    definite: calc.totals.definite.amount,
    estimated: calc.totals.estimated.amount,
    expected: calc.totals.expected.amount,
    conditionalExposure: calc.totals.conditionalExposure.amount,
    unresolved: calc.totals.unresolved.amount,
    lines,
    // The engine may repeat a warning per package or per candidate; one code per shipment is what the fold counts.
    warningCodes: [...new Set(calc.warnings.map((w) => (w.ruleKey ? `${w.code}:${w.ruleKey}` : w.code)))],
  };
}

function lineIndex(dictionary: LineDictionaryEntry[], line: ChargeLine): number {
  if (line.kind === "base") return 0;
  if (line.kind === "minimum_charge") return 1;
  if (!line.rule) throw new RangeError(`line "${line.label}" has no rule reference and cannot be encoded`);
  return ruleIndex(dictionary, line, line.rule);
}

function ruleIndex(dictionary: LineDictionaryEntry[], line: ChargeLine, rule: RuleReference): number {
  const existing = dictionary.findIndex((e) => e.kind === "rule" && e.key === rule.key && e.version === rule.version);
  if (existing >= 0) return existing;
  dictionary.push({
    kind: "rule",
    key: rule.key,
    version: rule.version,
    versionId: versionIdOf(rule),
    name: line.label,
    category: line.category,
    scope: rule.scope === "platform" ? "carrier" : "3pl",
  });
  return dictionary.length - 1;
}

/**
 * The engine's `RuleReference` does not carry the rule version's row id today; when a later engine
 * adds one it is kept, otherwise the pinned ids in `simulation_run_contexts` remain the source.
 */
function versionIdOf(rule: RuleReference): string | null {
  const candidate: unknown = (rule as { versionId?: unknown }).versionId;
  return typeof candidate === "string" ? candidate : null;
}

/** A compact line made readable again: what to show, never how it was configured. */
export interface DecodedLine {
  name: string;
  category: SurchargeCategory | "base";
  scope: "carrier" | "3pl" | null;
  key: string | null;
  version: number | null;
  amount: DecimalString;
  status: LineStatus;
  chargeClass: ChargeClass;
  packageIndex: number | null;
}

export function decodeLines(lines: CompactLine[], dictionary: LineDictionaryEntry[]): DecodedLine[] {
  return lines.map(([index, cents, status, cls, packageIndex]) => {
    const entry = dictionary[index];
    if (!entry) throw new RangeError(`line refers to dictionary entry ${index}, which does not exist`);
    return {
      name: entry.name,
      category: entry.category,
      scope: entry.scope,
      key: entry.key,
      version: entry.version,
      amount: centsToMoney(cents),
      status: STATUS_NAMES[status],
      chargeClass: CLASS_NAMES[cls],
      packageIndex,
    };
  });
}

// ---------------------------------------------------------------------------
// Fees (Milestone 4): one dictionary per run keyed by rule id, lines as [index, amountE4, class]
// ---------------------------------------------------------------------------

/** What identifies a fee rule in the dictionary: the database id plus the customer-visible fields the fold reports by. */
export interface FeeRuleIdentity {
  id: string;
  key: string;
  name: string;
  category: FeeCategory;
  basis: FeeBasis;
  scope: FeeScope;
}

/**
 * The index of a rule in the run's fee dictionary, appending it on first sight. Entries are keyed by
 * rule id, so the same key priced under two versions (ship-date basis) gets two entries and the fold
 * reports both ids under one key. The dictionary is the run's live array and is mutated in place.
 */
export function feeDictionaryIndex(feeDictionary: FeeDictionaryEntry[], rule: FeeRuleIdentity): number {
  const existing = feeDictionary.findIndex((e) => e.ruleId === rule.id);
  if (existing >= 0) return existing;
  feeDictionary.push({ ruleId: rule.id, key: rule.key, name: rule.name, category: rule.category, basis: rule.basis, scope: rule.scope });
  return feeDictionary.length - 1;
}

/**
 * Compacts one order's fee result. Every rule that produced a line or was left unresolved gets a
 * dictionary entry, so the fold can name an unresolved rule even when it never produced a line.
 * Unresolved entries that are not rules (`packaging:<type>`, a packaging type no rule prices) stay
 * as they are; the fold names those from the key.
 */
export function encodeOrderFees(result: OrderFeeResult, rulesByKey: ReadonlyMap<string, FeeRule>, feeDictionary: FeeDictionaryEntry[], status: FeeStatus = result.status, assumed: FoldOrderFees["assumed"] = {}): FoldOrderFees {
  const identity = (key: string): FeeRuleIdentity | null => {
    const rule = rulesByKey.get(key);
    if (!rule) return null;
    if (!rule.id) throw new RangeError(`fee rule "${key}" has no id and cannot be encoded`);
    return { id: rule.id, key: rule.key, name: rule.name, category: rule.category, basis: rule.basis, scope: rule.scope };
  };
  const lines: CompactFeeLine[] = result.lines.map((line) => {
    const rule = identity(line.ruleKey);
    if (!rule) throw new RangeError(`fee line "${line.ruleKey}" names a rule that is not in the schedule`);
    return [feeDictionaryIndex(feeDictionary, rule), line.amountE4, line.chargeClass === "definite" ? "d" : "e"];
  });
  for (const u of result.unresolved) {
    const rule = identity(u.ruleKey);
    if (rule) feeDictionaryIndex(feeDictionary, rule);
  }
  const flags: FoldOrderFees["assumed"] = {};
  if (assumed.units) flags.units = true;
  if (assumed.lines) flags.lines = true;
  if (assumed.skus) flags.skus = true;
  if (assumed.packaging) flags.packaging = true;
  return {
    status,
    lines,
    unresolved: result.unresolved.map((u) => ({ ruleKey: u.ruleKey, reason: u.reason, ...(u.replacedBy ? { replacedBy: u.replacedBy } : {}) })),
    warnings: [...new Set(result.warnings)].sort(),
    definiteE4: result.definiteE4,
    estimatedE4: result.estimatedE4,
    assumed: flags,
  };
}
