import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { OverviewChecklist, LegacyRulesAlert, LegacyRulesUnavailable, UndecidedRuleAlert } from "./checklist";
import { checklistSteps, glanceRows, undecidedRuleWarning, type LegacyFeeRule, type OverviewInput } from "./checklist-model";
import { PrivateNotice } from "./private-notice";
import { NO_SEPARATE_FEE_HELP } from "@/lib/adjustments/staff-copy";

/**
 * The Overview: the notice that this is private, any warning about what customers can see today, the four-step checklist, and where
 * things stand. `legacy` is `undefined` when it was not checked, `null` when the check failed (said so, never "none"), a list otherwise.
 */
export function OverviewView({ data, legacy, canManage }: { data: OverviewInput; legacy?: LegacyFeeRule[] | null; canManage: boolean }) {
  const steps = checklistSteps(data, { noSeparateFee: NO_SEPARATE_FEE_HELP });
  const warning = undecidedRuleWarning(data);
  const glance = glanceRows(data);
  return (
    <div className="space-y-8">
      <PrivateNotice />
      {!canManage ? <Alert>You can view adjustments, but only administrators can manage them.</Alert> : null}
      {legacy === null ? <LegacyRulesUnavailable /> : legacy && legacy.length ? <LegacyRulesAlert rules={legacy} /> : null}
      {warning ? <UndecidedRuleAlert warning={warning} /> : null}
      <OverviewChecklist steps={steps} />
      <section aria-labelledby="adjustments-glance-heading" className="space-y-3">
        <h2 id="adjustments-glance-heading" className="text-xl font-semibold tracking-tight">
          Where things stand
        </h2>
        <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-raised shadow-card">
          {glance.map((r) => (
            <li key={r.id} className="flex flex-col gap-1 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6" data-testid={`glance-${r.id}`}>
              <div className="min-w-0">
                <p className="text-sm text-muted">{r.label}</p>
                <p className="tabular font-medium [overflow-wrap:anywhere]">{r.value}</p>
                {r.detail ? <p className="text-sm text-muted [overflow-wrap:anywhere]">{r.detail}</p> : null}
              </div>
              <Link href={r.href} className="inline-flex min-h-11 shrink-0 items-center font-medium text-accent-text hover:underline">
                {r.linkLabel}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
