"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { deleteFeeRule, reorderFeeRules } from "@/app/actions/fee-schedules";
import { RuleForm } from "@/components/fees/rule-form";
import { BASIS_LABELS, CATEGORY_LABELS } from "@/components/fees/shared";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { describeFeeRule } from "@/engine/fees";
import type { FeeRule } from "@/engine/fees/types";

/**
 * The rules of one version, in the order customers read them. A draft is editable: add or edit a rule,
 * move it up or down (buttons, no dragging), delete it. Any other version is read-only. Every change
 * goes through the server actions, which authorise and validate again.
 */

const touch = "min-h-11 sm:min-h-9";

type Editing = { kind: "new" } | { kind: "edit"; rule: FeeRule };

export function RulesWorkspace({ versionId, editable, rules, sources }: { versionId: string; editable: boolean; rules: FeeRule[]; sources: Record<string, string> }) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const editorRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  // Which move button to hand keyboard focus back to once a move has been saved, and the order it started from.
  const moveFocus = useRef<{ target: string; before: string } | null>(null);

  const ids = rules.map((r) => r.id);
  const reorderable = editable && ids.every((x): x is string => typeof x === "string");

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (!reorderable || target < 0 || target >= rules.length) return;
    const order = ids.filter((x): x is string => typeof x === "string");
    const moved = order[index];
    const other = order[target];
    if (moved === undefined || other === undefined) return;
    order[index] = other;
    order[target] = moved;
    setError(null);
    setNotice(null);
    moveFocus.current = { target: `${moved}:${delta === -1 ? "up" : "down"}`, before: ids.join(",") };
    start(async () => {
      const result = await reorderFeeRules(versionId, order);
      if (!result.ok) setError(result.message ?? "Something went wrong. Please try again.");
    });
  };

  // The buttons are disabled while a move saves and the list re-renders in its new order, either of which drops
  // keyboard focus to the page. Put it back on the rule that moved (or on its other arrow when this one is now at an end).
  useEffect(() => {
    const m = moveFocus.current;
    if (!m || pending) return;
    // The saved order has not reached the page yet: wait for it (a failed move shows its message and settles at once).
    if (rules.map((r) => r.id).join(",") === m.before && !error) return;
    moveFocus.current = null;
    const [ruleId, direction] = m.target.split(":");
    const find = (d: string) => listRef.current?.querySelector<HTMLButtonElement>(`[data-move="${ruleId}:${d}"]`) ?? null;
    const same = find(direction ?? "up");
    (same && !same.disabled ? same : find(direction === "up" ? "down" : "up"))?.focus();
  }, [pending, rules, error]);

  // The editor unmounts when it closes; keyboard focus returns to the section instead of falling to the page.
  const closeEditor = (message: string | null) => {
    setEditing(null);
    setNotice(message);
    setTimeout(() => headingRef.current?.focus(), 0);
  };

  const others = editing?.kind === "edit" ? rules.filter((r) => r.id !== editing.rule.id) : rules;

  return (
    <section aria-labelledby="rules-heading" className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id="rules-heading" ref={headingRef} tabIndex={-1} className="text-xl font-semibold tracking-tight outline-none">
            Rules
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Each rule is one charge your customer reads on their fee schedule, in the order below.{" "}
            {editable ? "Customers see nothing until you activate the version." : "This version is no longer a draft, so its rules cannot change. Copy it to a new draft to make changes."}
          </p>
        </div>
        {editable && !editing ? (
          <Button
            onClick={() => {
              setNotice(null);
              setEditing({ kind: "new" });
            }}
          >
            Add rule
          </Button>
        ) : null}
      </div>

      {notice ? (
        <Alert tone="success">{notice}</Alert>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {editing ? (
        <Card>
          <p id="rule-editor-hint" className="mb-4 text-sm text-muted">
            Save or cancel this rule before you open another one.
          </p>
          <div ref={editorRef} id="rule-editor">
            <RuleForm
              key={editing.kind === "new" ? "new" : (editing.rule.id ?? editing.rule.key)}
              versionId={versionId}
              rule={editing.kind === "edit" ? editing.rule : null}
              source={editing.kind === "edit" && editing.rule.id ? (sources[editing.rule.id] ?? null) : null}
              otherRules={others}
              onSaved={(message) => closeEditor(message)}
              onCancel={() => closeEditor(null)}
            />
          </div>
        </Card>
      ) : null}

      {rules.length ? (
        <ol ref={listRef} className="divide-y divide-line overflow-hidden rounded-card border border-line bg-raised shadow-card">
          {rules.map((rule, index) => (
            <li key={rule.id ?? rule.key} className="px-4 py-4 sm:px-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1 [overflow-wrap:anywhere]">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{rule.name}</span>
                    <Badge tone="neutral">{CATEGORY_LABELS[rule.category]}</Badge>
                    <Badge tone="accent">{BASIS_LABELS[rule.basis]}</Badge>
                  </p>
                  <p className="text-[15px]">{describeFeeRule(rule)}</p>
                  {rule.description ? <p className="text-sm text-muted">{rule.description}</p> : null}
                  {rule.driver && (rule.basis === "driver" || rule.basis === "order_driver") ? <p className="text-sm text-muted">Asks the customer: {rule.driver.label}</p> : null}
                  <p className="text-xs text-muted">
                    Key (staff only): <span className="tabular">{rule.key}</span>
                  </p>
                  {rule.id && sources[rule.id] ? <p className="text-xs text-muted">Source (staff only): {sources[rule.id]}</p> : null}
                </div>
                {editable ? (
                  <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                    <Button size="sm" variant="secondary" className={touch} disabled={pending || !reorderable || index === 0} onClick={() => move(index, -1)} aria-label={`Move up: ${rule.name}`} data-move={rule.id ? `${rule.id}:up` : undefined}>
                      Move up
                    </Button>
                    <Button size="sm" variant="secondary" className={touch} disabled={pending || !reorderable || index === rules.length - 1} onClick={() => move(index, 1)} aria-label={`Move down: ${rule.name}`} data-move={rule.id ? `${rule.id}:down` : undefined}>
                      Move down
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      className={touch}
                      // Opening another rule would replace the open form and drop what was typed in it.
                      disabled={editing !== null && !(editing.kind === "edit" && editing.rule.id === rule.id)}
                      aria-describedby={editing ? "rule-editor-hint" : undefined}
                      onClick={() => {
                        setNotice(null);
                        setEditing({ kind: "edit", rule });
                      }}
                      aria-label={`Edit: ${rule.name}`}
                    >
                      Edit
                    </Button>
                    {rule.id ? (
                      <DeleteRule
                        ruleId={rule.id}
                        name={rule.name}
                        onDeleted={() => {
                          // A rule deleted while its form is open cannot be saved any more: close the form with it.
                          if (editing?.kind === "edit" && editing.rule.id === rule.id) setEditing(null);
                          setNotice("Rule removed.");
                          setTimeout(() => headingRef.current?.focus(), 0);
                        }}
                      />
                    ) : null}
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <EmptyState title="No rules yet">{editable ? "Add the first rule: choose a preset such as \"First pick included\" and enter your amount." : "This version has no rules."}</EmptyState>
      )}
    </section>
  );
}

/** Two-step delete (the button turns into Confirm / Cancel in place), named for its rule. */
function DeleteRule({ ruleId, name, onDeleted }: { ruleId: string; name: string; onDeleted: () => void }) {
  const [armed, setArmed] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (!armed) {
    return (
      <Button size="sm" variant="danger" className={touch} onClick={() => setArmed(true)} aria-label={`Delete: ${name}`}>
        Delete
      </Button>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2" role="group" aria-label={`Confirm: delete ${name}`}>
      <span className="text-sm text-muted">Removes this rule from the draft.</span>
      <Button
        size="sm"
        variant="danger"
        className={touch}
        loading={pending}
        onClick={() =>
          start(async () => {
            const result = await deleteFeeRule(ruleId);
            if (!result.ok) setError(result.message ?? "Something went wrong. Please try again.");
            else onDeleted();
          })
        }
      >
        Delete rule
      </Button>
      <Button
        size="sm"
        variant="secondary"
        className={touch}
        disabled={pending}
        onClick={() => {
          setArmed(false);
          setError(null);
        }}
      >
        Cancel
      </Button>
      {error ? (
        <span role="alert" className="text-sm font-medium text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}
