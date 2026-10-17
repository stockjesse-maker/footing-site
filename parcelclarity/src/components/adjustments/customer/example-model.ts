import type { BrandExamplePayload } from "@/lib/adjustments/queries";
import {
  GROUP_CASE_BY_CASE,
  GROUP_CHARGED,
  HEADING_FALLBACK,
  SUBTOTAL_LABEL,
  addMoney,
  componentExplanation,
  componentLabel,
  contextSizeStays,
  contextWeightStays,
  formatDimensionsIn,
  formatDollars,
  formatWeightLb,
  headingShipment,
  headingSize,
  headingSizeNotGiven,
  headingWeight,
  headingWeightAndSize,
  headingWeightAndSizeNotGiven,
  normalizeDecimal,
  packageBothChange,
  packageSizeChange,
  packageUnchanged,
  packageWeightChange,
  provenanceLine,
  serviceLabel,
  type ComponentHandling,
  type ComponentKind,
} from "@/lib/adjustments/customer-copy";

/**
 * What one example says, worked out from the published payload alone. Pure and framework-free: the view prints it, the tests read it.
 * Everything comes from the projection the database returns (`brand_adjustment_examples`): the declared and corrected package(s), the
 * delivery type and zone, and the charges the 3PL passes on or decides case by case. Nothing here is looked up, computed from
 * the customer's orders or derived from history.
 *
 * Returns null when any part of the payload cannot be written in words (a weight or an amount that is not a plain number). The view then
 * shows the neutral "updating this example" state instead of a half-written example; a figure is never guessed.
 */

export interface ComponentLineModel {
  kind: ComponentKind;
  handling: ComponentHandling;
  /** "Shipping charge difference" or "Separate adjustment fee". */
  label: string;
  /** "$5.30". */
  amount: string;
  /** "if charged" for a charge the 3PL decides on case by case. */
  qualifier: string | null;
  /** The sentences under the amount. */
  explanation: string;
}

export interface GroupModel {
  key: "charged" | "case_by_case";
  title: string;
  lines: ComponentLineModel[];
  /** Only inside "Charged to you", and only when the group has more than one line. A charged amount is never added to an if-charged one. */
  subtotal: { label: string; amount: string } | null;
}

export interface ExampleModel {
  /** "If a 5 lb package is corrected to 20 lb". */
  heading: string;
  /** What did not change ("Weight stays 5 lb."), or null. */
  context: string | null;
  provenance: string;
  /** One line per package when the example has more than one package; otherwise null. */
  packages: string[] | null;
  groups: GroupModel[];
  hasCaseByCase: boolean;
}

type Pkg = BrandExamplePayload["input"]["declared"]["packages"][number];

interface PackageFacts {
  weight: string;
  size: string | null;
  weightValue: string;
  sizeValue: string | null;
}

function facts(p: Pkg): PackageFacts | null {
  const weight = formatWeightLb(p.weightLb);
  const weightValue = normalizeDecimal(p.weightLb);
  if (weight === null || weightValue === null) return null;
  const has = p.lengthIn !== undefined && p.widthIn !== undefined && p.heightIn !== undefined;
  if (!has) {
    if (p.lengthIn !== undefined || p.widthIn !== undefined || p.heightIn !== undefined) return null;
    return { weight, size: null, weightValue, sizeValue: null };
  }
  const size = formatDimensionsIn(p.lengthIn!, p.widthIn!, p.heightIn!);
  return size === null ? null : { weight, size, weightValue, sizeValue: size };
}

/** The sentence an example is headed by, from its declared and corrected package(s). Null when the payload cannot be read. */
export function exampleHeading(payload: BrandExamplePayload): string | null {
  return buildExampleModel(payload, null)?.heading ?? null;
}

export function buildExampleModel(payload: BrandExamplePayload, tenantName: string | null | undefined): ExampleModel | null {
  const declared = payload.input.declared.packages.map(facts);
  const corrected = payload.input.corrected.packages.map(facts);
  if (declared.length !== corrected.length || declared.length < 1) return null;
  const pairs: { from: PackageFacts; to: PackageFacts }[] = [];
  for (let i = 0; i < declared.length; i++) {
    const from = declared[i];
    const to = corrected[i];
    if (!from || !to) return null;
    pairs.push({ from, to });
  }
  const weightChanged = (p: { from: PackageFacts; to: PackageFacts }) => p.from.weightValue !== p.to.weightValue;
  const sizeChanged = (p: { from: PackageFacts; to: PackageFacts }) => p.from.sizeValue !== p.to.sizeValue;

  let heading = HEADING_FALLBACK;
  let context: string | null = null;
  let packages: string[] | null = null;

  if (pairs.length === 1) {
    const { from, to } = pairs[0]!;
    const w = weightChanged(pairs[0]!);
    const s = sizeChanged(pairs[0]!) && to.size !== null;
    if (w && s) heading = from.size ? headingWeightAndSize(from.weight, from.size, to.weight, to.size!) : headingWeightAndSizeNotGiven(from.weight, to.weight, to.size!);
    else if (w) {
      heading = headingWeight(from.weight, to.weight);
      context = to.size ? contextSizeStays(to.size) : null;
    } else if (s) {
      heading = from.size ? headingSize(from.size, to.size!) : headingSizeNotGiven(to.size!);
      context = contextWeightStays(to.weight);
    }
  } else {
    const changed = pairs.filter((p) => weightChanged(p) || (sizeChanged(p) && p.to.size !== null)).length;
    if (changed > 0) heading = headingShipment(changed, pairs.length);
    packages = pairs.map((p, i) => {
      const n = i + 1;
      const w = weightChanged(p);
      const s = sizeChanged(p) && p.to.size !== null;
      if (w && s) return packageBothChange(n, p.from.weight, p.to.weight, p.from.size, p.to.size!);
      if (w) return packageWeightChange(n, p.from.weight, p.to.weight);
      if (s) return packageSizeChange(n, p.from.size, p.to.size!);
      return packageUnchanged(n, p.to.weight, p.to.size);
    });
  }

  // The charges, postage difference first. Each is the 3PL's own: passed on, or decided case by case. Nothing else exists in a payload.
  const shipment = pairs.length > 1;
  const order: Record<ComponentKind, number> = { postage_difference: 0, separate_fee: 1 };
  const lines: ComponentLineModel[] = [];
  for (const c of [...payload.components].sort((a, b) => order[a.kind] - order[b.kind])) {
    const amount = formatDollars(c.amount);
    if (amount === null) return null;
    lines.push({
      kind: c.kind,
      handling: c.handling,
      label: componentLabel(c.kind),
      amount,
      qualifier: c.handling === "manual_approval" ? "if charged" : null,
      explanation: componentExplanation({ kind: c.kind, handling: c.handling, tenantName, declaredTotal: c.declaredTotal, correctedTotal: c.correctedTotal, shipment }),
    });
  }
  if (lines.length === 0) return null;

  const charged = payload.components.filter((c) => c.handling === "pass_through");
  const chargedLines = lines.filter((l) => l.handling === "pass_through");
  const caseLines = lines.filter((l) => l.handling === "manual_approval");
  const groups: GroupModel[] = [];
  if (chargedLines.length) {
    // The only sum: the charges passed on, added together, inside their own group. An if-charged amount never joins it.
    const sum = chargedLines.length > 1 ? addMoney(charged.map((c) => c.amount)) : null;
    groups.push({ key: "charged", title: GROUP_CHARGED, lines: chargedLines, subtotal: sum === null ? null : { label: SUBTOTAL_LABEL, amount: formatDollars(sum)! } });
  }
  if (caseLines.length) groups.push({ key: "case_by_case", title: GROUP_CASE_BY_CASE, lines: caseLines, subtotal: null });

  const service = serviceLabel(payload.input.service.carrier, payload.input.service.service);
  return {
    heading,
    context,
    provenance: provenanceLine({ service, zone: payload.input.zone, residential: payload.input.residential, tenantName, shipment }),
    packages,
    groups,
    hasCaseByCase: caseLines.length > 0,
  };
}
