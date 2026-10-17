"use client";

import Link from "next/link";
import { useId, useMemo, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/field";
import type { PolicyRecord } from "@/lib/adjustments/action-schemas";
import { HANDLING_BADGES, HANDLING_LABELS, POLICIES_EMPTY, POLICIES_INTRO, POLICY_COMPONENT_LABELS, POLICY_TYPE_LABELS, READ_ONLY_NOTICE, pluralize } from "@/lib/adjustments/staff-copy";
import { PolicyMatrix } from "./policy-matrix";
import { exceptionSummary, nothingDecided } from "./policy-model";

export interface PolicyBrand {
  id: string;
  name: string;
  status: string;
}

/**
 * The Policies screen: the decision for all customers (a 4 by 2 matrix), then exceptions for one customer. "Use the all-customers decision"
 * clears a customer's own decision. Read-only members see the same decisions as text.
 */
export function PoliciesWorkspace({ policies, brands, today, canManage, initialCustomerId }: { policies: readonly PolicyRecord[]; brands: readonly PolicyBrand[]; today: string; canManage: boolean; initialCustomerId?: string | null }) {
  const id = useId();
  const [customerId, setCustomerId] = useState<string>(initialCustomerId && brands.some((b) => b.id === initialCustomerId) ? initialCustomerId : "");
  const customer = brands.find((b) => b.id === customerId) ?? null;
  const summary = useMemo(() => exceptionSummary(policies, brands, today), [policies, brands, today]);
  const region = useRef<HTMLDivElement>(null);
  // "Edit" on a customer in the list opens that customer's decisions further down the page: bring them into view and hand them focus.
  const open = (brandId: string) => {
    setCustomerId(brandId);
    requestAnimationFrame(() => {
      region.current?.scrollIntoView({ block: "start" });
      region.current?.focus();
    });
  };
  const empty = nothingDecided(policies, today);

  return (
    <div className="space-y-10">
      <p className="max-w-2xl text-[15px] text-muted">{POLICIES_INTRO}</p>
      {!canManage ? <Alert>{READ_ONLY_NOTICE}</Alert> : null}
      {empty ? <Alert tone="info">{POLICIES_EMPTY}</Alert> : null}

      <section aria-labelledby={`${id}-all`} className="space-y-4">
        <div>
          <h2 id={`${id}-all`} className="text-xl font-semibold tracking-tight">
            For all customers
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">These decisions apply to every customer that has no decision of its own.</p>
        </div>
        <PolicyMatrix scope={{ kind: "account" }} policies={policies} today={today} canManage={canManage} />
      </section>

      <section aria-labelledby={`${id}-one`} className="space-y-4">
        <div>
          <h2 id={`${id}-one`} className="text-xl font-semibold tracking-tight">
            Exceptions for one customer
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">Use this when one customer&apos;s agreement differs. Anything you leave as &ldquo;Use the all-customers decision&rdquo; follows the decisions above.</p>
        </div>

        {summary.length ? (
          <div className="space-y-2">
            <h3 className="text-base font-semibold">Customers with their own decisions</h3>
            <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-raised shadow-card">
              {summary.map((s) => (
                <li key={s.brandId} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-medium [overflow-wrap:anywhere]">{s.brandName}</p>
                    <ul className="mt-1 space-y-0.5 text-sm text-muted">
                      {s.decisions.map((d) => (
                        <li key={`${d.type}-${d.component}`} className="[overflow-wrap:anywhere]">
                          {POLICY_TYPE_LABELS[d.type]}, {POLICY_COMPONENT_LABELS[d.component].toLowerCase()}: {HANDLING_LABELS[d.handling]} <Badge tone="neutral">{HANDLING_BADGES[d.handling]}</Badge>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <Button size="sm" variant="secondary" className="min-h-11 shrink-0 sm:min-h-9" onClick={() => open(s.brandId)} aria-label={`${canManage ? "Edit" : "Show"} decisions for ${s.brandName}`}>
                    {canManage ? "Edit" : "Show"}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-sm text-muted">No customer has a decision of its own yet.</p>
        )}

        {brands.length ? (
          <div className="max-w-sm">
            <Field id={`${id}-customer`} label="Customer" hint={customer ? undefined : "Choose a customer to see or give them a decision of their own."}>
              {(aria) => (
                <Select {...aria} value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                  <option value="">Choose a customer…</option>
                  {brands.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.status === "active" ? b.name : `${b.name} (${b.status})`}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        ) : (
          <p className="text-sm text-muted">
            You have no customers yet.{" "}
            <Link href="/app/customers" className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
              Add a customer
            </Link>{" "}
            to give them a decision of their own.
          </p>
        )}

        {customer ? (
          <div ref={region} tabIndex={-1} className="scroll-mt-4 space-y-3 outline-none" role="region" aria-label={`Decisions for ${customer.name}`}>
            <h3 className="text-base font-semibold [overflow-wrap:anywhere]">{`Decisions for ${customer.name}`}</h3>
            <p className="text-sm text-muted">
              {pluralize(summary.find((s) => s.brandId === customer.id)?.decisions.length ?? 0, "decision")} of their own today.
            </p>
            <PolicyMatrix key={customer.id} scope={{ kind: "customer", brandId: customer.id, brandName: customer.name }} policies={policies} today={today} canManage={canManage} />
          </div>
        ) : null}
      </section>
    </div>
  );
}
