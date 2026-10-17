import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { CHECKLIST_INTRO, CHECKLIST_TITLE } from "@/lib/adjustments/staff-copy";
import type { ChecklistStep, LegacyFeeRule, UndecidedRuleWarning } from "./checklist-model";

/** The four setup steps with where each stands today. Status is words plus a badge. */
export function OverviewChecklist({ steps }: { steps: ChecklistStep[] }) {
  return (
    <section aria-labelledby="adjustments-checklist-heading" className="space-y-3">
      <div>
        <h2 id="adjustments-checklist-heading" className="text-xl font-semibold tracking-tight">
          {CHECKLIST_TITLE}
        </h2>
        <p className="mt-1 text-sm text-muted">{CHECKLIST_INTRO}</p>
      </div>
      <ol className="divide-y divide-line overflow-hidden rounded-card border border-line bg-raised shadow-card">
        {steps.map((s) => (
          <li key={s.id} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-6" data-testid={`checklist-${s.id}`}>
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-medium">{`Step ${s.n}: ${s.title}`}</h3>
                <Badge tone={s.done ? "success" : "neutral"}>{s.done ? "Done" : "Not done"}</Badge>
              </div>
              <p className="text-sm [overflow-wrap:anywhere]">{s.detail}</p>
              {s.help ? <p className="max-w-prose text-sm text-muted [overflow-wrap:anywhere]">{s.help}</p> : null}
            </div>
            {s.action ? (
              <div className="shrink-0">
                <ButtonLink href={s.action.href} variant={s.done ? "secondary" : "primary"}>
                  {s.action.label}
                </ButtonLink>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Customers can read a reweigh, remeasure or correction fee rule although nobody decided who pays it (design D8). */
export function UndecidedRuleAlert({ warning }: { warning: UndecidedRuleWarning }) {
  const n = warning.customers.length + warning.more;
  return (
    <Alert tone="warning" title="Customers can see a fee rule that nobody has decided who pays">
      <p>
        {n === 1 ? "This customer reads" : `These ${n} customers read`} a reweigh, remeasure or correction fee rule in their pricing as a charge that may be added after shipping, but you have not decided who pays it.
      </p>
      <ul className="mt-2 list-disc space-y-0.5 pl-5">
        {warning.customers.map((c) => (
          <li key={c.brandId} className="[overflow-wrap:anywhere]">
            <span className="font-medium">{c.brandName}</span>: {c.words}
          </li>
        ))}
        {warning.more > 0 ? <li>and {warning.more} more</li> : null}
      </ul>
      <p className="mt-2">If you decide the separate adjustment fee is not billed to the customer, the rule is hidden from them. Any other decision keeps it visible.</p>
      <p className="mt-2">
        <Link href="/app/adjustments/policies" className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
          Decide who pays
        </Link>
      </p>
    </Alert>
  );
}

/** Published fee rules that are not conditional charges: they still count in totals until retired and published again. */
export function LegacyRulesAlert({ rules }: { rules: LegacyFeeRule[] }) {
  return (
    <Alert tone="warning" title="Some correction fee rules are saved as fixed charges">
      <p>These published rules were saved before correction fees became conditional charges, so they still count in calculator, run and forecast totals. Retire each one and publish it again as a conditional charge.</p>
      <ul className="mt-2 list-disc space-y-0.5 pl-5">
        {rules.map((r) => (
          <li key={`${r.ruleName}-${r.versionNumber}`} className="[overflow-wrap:anywhere]">
            {r.ruleName}, version {r.versionNumber}
          </li>
        ))}
      </ul>
      <p className="mt-2">
        <Link href="/app/surcharges" className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
          Go to surcharge rules
        </Link>
      </p>
    </Alert>
  );
}

/** Shown when the check for older fee rules failed: a failed check is never reported as "none". */
export function LegacyRulesUnavailable() {
  return <Alert tone="info">The check for older correction fee rules could not be run. Reload the page to try again.</Alert>;
}
