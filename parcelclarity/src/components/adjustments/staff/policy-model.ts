import { POLICY_CELLS, currentPolicyCells, type PolicyCellView, type PolicyRecord } from "@/lib/adjustments/action-schemas";
import type { Handling, PolicyComponent, PolicyType } from "@/engine/adjustments/types";
import { HANDLING_BADGES, HANDLING_CHOICES, POLICY_COMPONENT_LABELS, POLICY_TYPE_LABELS, type HandlingChoice } from "@/lib/adjustments/staff-copy";

/**
 * The model behind the Policies matrix: 4 rows (Reweigh, Remeasure, Both together, Other correction fee) by 2 columns (Shipping charge
 * difference, Separate adjustment fee), for all customers and then for one customer. Pure: no React, no I/O. The screen edits a DRAFT
 * (what each select shows), and `policyChanges` turns the difference between the draft and what is saved into the calls to make.
 *
 * Saved decisions are read from the rows the database holds, resolved for a date (`currentPolicyCells`); a cell with no decision reads
 * "Not decided" (all customers) or "Use the all-customers decision" (one customer). A decision applies from today: there are no dates here.
 */
export type { PolicyCellView, PolicyRecord };

export type PolicyScope = { kind: "account" } | { kind: "customer"; brandId: string; brandName: string };

/** "" is "Not decided" for all customers and "Use the all-customers decision" for one customer. */
export type DraftChoice = "" | HandlingChoice;
export type PolicyDraft = Record<string, DraftChoice>;

export const cellKey = (type: PolicyType, component: PolicyComponent): string => `${type}:${component}`;

export interface MatrixRow {
  type: PolicyType;
  label: string;
  /** The two columns in order; `applicable` is false for the shipping charge difference of a correction fee. */
  cells: { component: PolicyComponent; label: string; applicable: boolean }[];
}

const validPairs = new Set(POLICY_CELLS.map((c) => cellKey(c.type, c.component)));

/** The four rows in the order the screen lists them. */
export const MATRIX_ROWS: readonly MatrixRow[] = (["reweight", "remeasure", "combined", "correction"] as const).map((type) => ({
  type,
  label: POLICY_TYPE_LABELS[type],
  cells: (["postage_difference", "separate_fee"] as const).map((component) => ({ component, label: POLICY_COMPONENT_LABELS[component], applicable: validPairs.has(cellKey(type, component)) })),
}));

/** The accessible name of a decision's select: "Reweigh: Shipping charge difference (all customers)". */
export function decisionName(type: PolicyType, component: PolicyComponent, scopeLabel: string): string {
  return `${POLICY_TYPE_LABELS[type]}: ${POLICY_COMPONENT_LABELS[component]} (${scopeLabel})`;
}

export const scopeLabel = (scope: PolicyScope): string => (scope.kind === "account" ? "all customers" : scope.brandName);

const cellOf = (cells: readonly PolicyCellView[], type: PolicyType, component: PolicyComponent): PolicyCellView | undefined => cells.find((c) => c.type === type && c.component === component);

/** The decision saved for this scope in this cell, or null. */
export function savedRecord(cell: PolicyCellView | undefined, scope: PolicyScope): PolicyRecord | null {
  if (!cell) return null;
  return scope.kind === "account" ? cell.account : (cell.exceptions.find((e) => e.brandId === scope.brandId) ?? null);
}

export function savedChoice(cell: PolicyCellView | undefined, scope: PolicyScope): DraftChoice {
  return savedRecord(cell, scope)?.handling ?? "";
}

/** What the draft starts from: every applicable cell at its saved choice. */
export function draftFrom(cells: readonly PolicyCellView[], scope: PolicyScope): PolicyDraft {
  const draft: PolicyDraft = {};
  for (const { type, component } of POLICY_CELLS) draft[cellKey(type, component)] = savedChoice(cellOf(cells, type, component), scope);
  return draft;
}

export interface PolicyChange {
  type: PolicyType;
  component: PolicyComponent;
  /** `set` calls setPolicy; `end` calls endPolicy (it clears the decision: "Not decided", or "Use the all-customers decision"). */
  action: "set" | "end";
  handling?: HandlingChoice;
  policyId?: string;
}

/** The calls the draft needs, in screen order. Cells whose draft equals what is saved are not touched. */
export function policyChanges(cells: readonly PolicyCellView[], draft: PolicyDraft, scope: PolicyScope): PolicyChange[] {
  const out: PolicyChange[] = [];
  for (const { type, component } of POLICY_CELLS) {
    const saved = savedRecord(cellOf(cells, type, component), scope);
    const wanted = draft[cellKey(type, component)] ?? "";
    const current: DraftChoice = saved?.handling ?? "";
    if (wanted === current) continue;
    if (wanted === "") {
      if (saved) out.push({ type, component, action: "end", policyId: saved.id });
    } else {
      out.push({ type, component, action: "set", handling: wanted });
    }
  }
  return out;
}

/** "Use the same decisions as Reweigh": the draft of `to` takes the draft of `from` in every cell both rows have. */
export function copyRowDraft(draft: PolicyDraft, from: PolicyType, to: PolicyType): PolicyDraft {
  const next = { ...draft };
  for (const component of ["postage_difference", "separate_fee"] as const) {
    if (validPairs.has(cellKey(from, component)) && validPairs.has(cellKey(to, component))) next[cellKey(to, component)] = draft[cellKey(from, component)] ?? "";
  }
  return next;
}

export interface EffectiveDecision {
  handling: Handling;
  /** Where the decision comes from: this scope's own row, the all-customers decision, or nothing. */
  source: "own" | "all" | "none";
  validFrom: string | null;
}

/** What applies today for this scope in this cell (a customer's own decision beats the all-customers one, as the database resolves it). */
export function effectiveDecision(cell: PolicyCellView | undefined, scope: PolicyScope): EffectiveDecision {
  const own = savedRecord(cell, scope);
  if (own) return { handling: own.handling, source: "own", validFrom: own.validFrom };
  if (scope.kind === "customer" && cell?.account) return { handling: cell.account.handling, source: "all", validFrom: cell.account.validFrom };
  return { handling: "unconfigured", source: "none", validFrom: null };
}

export function badgeText(handling: Handling): string {
  return HANDLING_BADGES[handling];
}

export const isHandlingChoice = (v: string): v is HandlingChoice => (HANDLING_CHOICES as readonly string[]).includes(v);

export interface CustomerDecisions {
  brandId: string;
  brandName: string;
  decisions: { type: PolicyType; component: PolicyComponent; handling: HandlingChoice }[];
}

/** The customers with a decision of their own in effect on `today`, by customer name, with what they decided. */
export function exceptionSummary(policies: readonly PolicyRecord[], brands: readonly { id: string; name: string }[], today: string): CustomerDecisions[] {
  const cells = currentPolicyCells(policies, today);
  const names = new Map(brands.map((b) => [b.id, b.name] as const));
  const byBrand = new Map<string, CustomerDecisions>();
  for (const cell of cells) {
    for (const e of cell.exceptions) {
      if (!e.brandId) continue;
      const entry = byBrand.get(e.brandId) ?? { brandId: e.brandId, brandName: names.get(e.brandId) ?? "A customer that is no longer listed", decisions: [] };
      entry.decisions.push({ type: cell.type, component: cell.component, handling: e.handling as HandlingChoice });
      byBrand.set(e.brandId, entry);
    }
  }
  return [...byBrand.values()].sort((a, b) => a.brandName.localeCompare(b.brandName));
}

/** True when nothing is decided anywhere (the empty state). */
export function nothingDecided(policies: readonly PolicyRecord[], today: string): boolean {
  return currentPolicyCells(policies, today).every((c) => c.account === null && c.exceptions.length === 0);
}
