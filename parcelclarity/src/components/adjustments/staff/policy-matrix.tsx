"use client";

import { useRouter } from "next/navigation";
import { useId, useMemo, useState, useTransition } from "react";
import { endPolicy, setPolicy } from "@/app/actions/adjustments";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { GENERIC_FAILURE, currentPolicyCells, type PolicyRecord } from "@/lib/adjustments/action-schemas";
import {
  HANDLING_CHOICES,
  HANDLING_HELP,
  HANDLING_LABELS,
  INHERIT_LABEL,
  NOT_APPLICABLE_FEE_ONLY,
  NO_CHANGES,
  POLICY_TYPE_HELP,
  POLICY_TYPE_LABELS,
  SAVE_DECISIONS,
  UNDECIDED_HELP,
  UNDECIDED_TEXT,
  formatIsoDate,
  pluralize,
} from "@/lib/adjustments/staff-copy";
import { FocusAlert } from "./focus-alert";
import {
  MATRIX_ROWS,
  badgeText,
  cellKey,
  copyRowDraft,
  decisionName,
  draftFrom,
  effectiveDecision,
  isHandlingChoice,
  policyChanges,
  scopeLabel,
  type DraftChoice,
  type PolicyDraft,
  type PolicyScope,
} from "./policy-model";

/**
 * One matrix of decisions: for all customers, or for one customer. Below 640px each row is one card with labelled 16px selects; from 640px
 * it is a table (the same controls, so nothing is duplicated). A decision is chosen with a select and saved with ONE button for the whole
 * matrix, so a change of a select never saves by itself. For an administrator only: a read-only member sees the decisions as text and a badge.
 */
type Outcome = { kind: "idle" } | { kind: "saved"; count: number } | { kind: "failed"; saved: number; failures: { label: string; message: string }[]; attempt: number };

function toneOf(handling: string): "warning" | "accent" | "neutral" {
  return handling === "unconfigured" ? "warning" : handling === "pass_through" ? "accent" : "neutral";
}

export function PolicyMatrix({ scope, policies, today, canManage }: { scope: PolicyScope; policies: readonly PolicyRecord[]; today: string; canManage: boolean }) {
  const router = useRouter();
  const id = useId();
  const cells = useMemo(() => currentPolicyCells(policies, today), [policies, today]);
  const [draft, setDraft] = useState<PolicyDraft>(() => draftFrom(cells, scope));
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const [pending, startTransition] = useTransition();
  const label = scopeLabel(scope);
  const changes = policyChanges(cells, draft, scope);
  const inherit = scope.kind === "customer";

  const choose = (key: string, value: string) => {
    setOutcome({ kind: "idle" });
    setDraft((d) => ({ ...d, [key]: value === "" ? "" : isHandlingChoice(value) ? value : "" }));
  };
  const copyFrom = (from: "reweight" | "remeasure") => {
    setOutcome({ kind: "idle" });
    setDraft((d) => copyRowDraft(d, from, "combined"));
  };

  const save = () =>
    startTransition(async () => {
      const failures: { label: string; message: string }[] = [];
      let saved = 0;
      for (const ch of changes) {
        const name = `${POLICY_TYPE_LABELS[ch.type]}: ${ch.component === "postage_difference" ? "Shipping charge difference" : "Separate adjustment fee"}`;
        const result =
          ch.action === "set"
            ? await setPolicy({ brandId: scope.kind === "customer" ? scope.brandId : null, adjustmentType: ch.type, component: ch.component, handling: ch.handling })
            : await endPolicy(ch.policyId ?? "");
        if (result.ok) saved++;
        else failures.push({ label: name, message: result.message ?? Object.values(result.errors ?? {})[0] ?? GENERIC_FAILURE });
      }
      router.refresh();
      setOutcome(failures.length ? { kind: "failed", saved, failures, attempt: Date.now() } : { kind: "saved", count: saved });
    });

  return (
    <div className="space-y-4" data-testid={`policy-matrix-${scope.kind}`}>
      <table className="block w-full sm:table">
        <caption className="sr-only">{`Who pays, ${label}`}</caption>
        <thead className="hidden sm:table-header-group">
          <tr className="text-left text-sm text-muted">
            <th scope="col" className="px-4 py-2 font-medium">
              Kind of adjustment
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              {MATRIX_ROWS[0]!.cells[0]!.label}
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              {MATRIX_ROWS[0]!.cells[1]!.label}
            </th>
          </tr>
        </thead>
        <tbody className="block space-y-3 sm:table-row-group sm:space-y-0 sm:divide-y sm:divide-line sm:border-y sm:border-line">
          {MATRIX_ROWS.map((row) => (
            <tr key={row.type} className="block rounded-card border border-line bg-raised p-4 shadow-card sm:table-row sm:rounded-none sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none">
              <th scope="row" className="block text-left font-normal sm:table-cell sm:w-64 sm:px-4 sm:py-4 sm:align-top">
                <span className="block font-semibold">{row.label}</span>
                <span className="mt-0.5 block text-sm text-muted">{POLICY_TYPE_HELP[row.type]}</span>
                {row.type === "combined" && canManage ? (
                  <span className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" className="min-h-11 sm:min-h-9" onClick={() => copyFrom("reweight")}>
                      Use the same decisions as Reweigh
                    </Button>
                    <Button size="sm" variant="secondary" className="min-h-11 sm:min-h-9" onClick={() => copyFrom("remeasure")}>
                      Use the same decisions as Remeasure
                    </Button>
                  </span>
                ) : null}
              </th>
              {row.cells.map((c) => {
                const key = cellKey(row.type, c.component);
                const cell = cells.find((x) => x.type === row.type && x.component === c.component);
                const fieldId = `${id}-${key.replace(":", "-")}`;
                const effective = effectiveDecision(cell, scope);
                const value: DraftChoice = draft[key] ?? "";
                const dirty = c.applicable && value !== (effective.source === "own" ? (effective.handling as DraftChoice) : "");
                return (
                  <td key={c.component} className="mt-3 block sm:mt-0 sm:table-cell sm:px-4 sm:py-4 sm:align-top">
                    {c.applicable ? (
                      <div className="space-y-2">
                        {canManage ? (
                          <label htmlFor={fieldId} className="block text-sm font-medium sm:sr-only">
                            {c.label}
                          </label>
                        ) : (
                          <span className="block text-sm font-medium sm:sr-only">{c.label}</span>
                        )}
                        {canManage ? (
                          <Select id={fieldId} aria-label={decisionName(row.type, c.component, label)} value={value} onChange={(e) => choose(key, e.target.value)} disabled={pending}>
                            <option value="">{inherit ? INHERIT_LABEL : UNDECIDED_TEXT}</option>
                            {HANDLING_CHOICES.map((h) => (
                              <option key={h} value={h}>
                                {HANDLING_LABELS[h]}
                              </option>
                            ))}
                          </Select>
                        ) : (
                          <p className="text-[15px]">
                            {effective.handling === "unconfigured" ? UNDECIDED_TEXT : HANDLING_LABELS[effective.handling]}
                          </p>
                        )}
                        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                          <Badge tone={toneOf(effective.handling)}>{badgeText(effective.handling)}</Badge>
                          <span className="text-muted">
                            {effective.source === "own"
                              ? inherit
                                ? `Set for ${label}, from ${formatIsoDate(effective.validFrom ?? today)}`
                                : `From ${formatIsoDate(effective.validFrom ?? today)}`
                              : effective.source === "all"
                                ? "Same as all customers"
                                : inherit
                                  ? "All customers: Not decided"
                                  : null}
                          </span>
                          {dirty ? <span className="font-medium">Changed, not saved</span> : null}
                        </p>
                        {effective.handling === "unconfigured" && value === "" ? <p className="text-sm text-muted">{UNDECIDED_HELP}</p> : null}
                        {canManage && value !== "" ? <p className="text-sm text-muted">{HANDLING_HELP[value]}</p> : null}
                        {!canManage && effective.handling !== "unconfigured" ? <p className="text-sm text-muted">{HANDLING_HELP[effective.handling]}</p> : null}
                      </div>
                    ) : (
                      <div>
                        <span className="block text-sm font-medium sm:sr-only">{c.label}</span>
                        <p className="text-sm text-muted">{NOT_APPLICABLE_FEE_ONLY}</p>
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {canManage ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={save} loading={pending} disabled={changes.length === 0}>
            {pending ? "Saving…" : SAVE_DECISIONS}
          </Button>
          {changes.length === 0 && outcome.kind === "idle" ? <p className="text-sm text-muted">{NO_CHANGES}</p> : null}
          {changes.length > 0 && outcome.kind === "idle" ? <p className="text-sm text-muted">{pluralize(changes.length, "decision")} changed, not saved. A decision applies from today.</p> : null}
        </div>
      ) : null}
      <div aria-live="polite">
        {outcome.kind === "saved" ? <Alert tone="success">{outcome.count === 1 ? "Saved 1 decision. It applies from today." : `Saved ${outcome.count} decisions. They apply from today.`}</Alert> : null}
      </div>
      {outcome.kind === "failed" ? (
        <FocusAlert key={outcome.attempt} title={outcome.saved > 0 ? `Saved ${pluralize(outcome.saved, "decision")}, but some could not be saved` : "The decisions could not be saved"}>
          <ul className="list-disc space-y-1 pl-5">
            {outcome.failures.map((f) => (
              <li key={f.label} className="[overflow-wrap:anywhere]">
                <span className="font-medium">{f.label}</span>: {f.message}
              </li>
            ))}
          </ul>
        </FocusAlert>
      ) : null}
    </div>
  );
}
