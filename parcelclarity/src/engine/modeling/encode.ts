import { dec } from "../money";
import type { ChargeClass, ChargeLine, DecimalString, LineStatus, RuleReference, ShipmentCalculation, SurchargeCategory } from "../types";
import type { CompactLine, CompactLineClass, CompactLineStatus, CompactResult, LineDictionaryEntry } from "./types";

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
