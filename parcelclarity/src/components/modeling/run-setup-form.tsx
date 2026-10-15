"use client";

import { useId, useState } from "react";
import { createBulkScenario, rerunScenario } from "@/app/actions/modeling";
import { ActionForm, SubmitButton, useFormState } from "@/components/forms/action-form";
import { DateField } from "@/components/pricing/service-terms-form";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/field";

export interface RunSetupProps {
  /** Staff pass the customer; brand members are bound to their own. */
  brandId?: string;
  datasetId?: string;
  /** Re-run an existing scenario instead of creating one. */
  projectId?: string;
  cards: { id: string; name: string; effectiveDates: string[] }[];
  services: { id: string; carrierCode: string; name: string }[];
  /** True when the file carries no residential flag: the question must be asked. */
  askResidential: boolean;
  /** True when the file carries no origin ZIP. */
  askOrigin: boolean;
  defaultOriginZip: string | null;
  /** Orders whose shipping service is not mapped (excluded unless a service is chosen for them). */
  unmappedShipments: number;
  /** Earliest date the customer's rates cover, and the first order date in the file: orders before the rates cannot be priced on their own dates. */
  earliestRatesDate: string | null;
  firstOrderDate: string | null;
  today: string;
  tenantName: string;
}

/** Choices for one run: which rates, what to assume, what to do with unmapped services. Every assumption is explicit. */
export function RunSetupForm(p: RunSetupProps) {
  const id = useId();
  const state = useFormState();
  const [basis, setBasis] = useState<"fixed_date" | "ship_date">("fixed_date");
  const [override, setOverride] = useState("");
  const [overrideAll, setOverrideAll] = useState(false);
  const action = p.projectId ? rerunScenario : createBulkScenario;
  return (
    <Card>
      <CardTitle>{p.projectId ? "Run again with different settings" : "Run the model"}</CardTitle>
      <CardDescription>Every shipment is priced individually on the rates you choose; results are estimates, never an invoice.</CardDescription>
      <ActionForm action={action} className="mt-5 space-y-6">
        {p.brandId ? <input type="hidden" name="brandId" value={p.brandId} /> : null}
        {p.datasetId ? <input type="hidden" name="datasetId" value={p.datasetId} /> : null}
        {p.projectId ? <input type="hidden" name="projectId" value={p.projectId} /> : null}

        {!p.projectId ? (
          <Field id={`${id}-card`} label="Rate card" error={state.errors?.rateCardId}>
            {(aria) => (
              <Select {...aria} name="rateCardId" defaultValue={p.cards[0]?.id ?? ""}>
                {p.cards.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">Which rates to use</legend>
          <label className="flex min-h-11 items-start gap-3 text-sm">
            <input type="radio" name="pricingBasis" value="fixed_date" checked={basis === "fixed_date"} onChange={() => setBasis("fixed_date")} className="mt-1 size-4 accent-accent" />
            <span>
              <span className="font-medium">Today&apos;s rates</span>
              <span className="block text-muted">Prices every order at the rates in effect on one date, so you can see what these orders would cost now.</span>
            </span>
          </label>
          {basis === "fixed_date" ? <DateField id={`${id}-asof`} name="asOfDate" label="Rates in effect on" defaultValue={p.today} required /> : null}
          <label className="flex min-h-11 items-start gap-3 text-sm">
            <input type="radio" name="pricingBasis" value="ship_date" checked={basis === "ship_date"} onChange={() => setBasis("ship_date")} className="mt-1 size-4 accent-accent" />
            <span>
              <span className="font-medium">Rates in effect on each order&apos;s ship date</span>
              <span className="block text-muted">
                Historical view. Orders without a date cannot be priced this way.
                {p.earliestRatesDate && p.firstOrderDate && p.firstOrderDate < p.earliestRatesDate ? ` Your rates start on ${p.earliestRatesDate}; orders before that date (the file starts ${p.firstOrderDate}) cannot be priced this way.` : ""}
              </span>
            </span>
          </label>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">Shipping service</legend>
          <Field id={`${id}-override`} label={p.unmappedShipments > 0 ? `Service for the ${p.unmappedShipments.toLocaleString("en-US")} shipments whose service is not mapped` : "Price everything on one service (what-if)"} hint="Leave empty to keep the services in the file; unmapped shipments are then excluded and listed.">
            {(aria) => (
              <Select {...aria} name="serviceOverrideId" value={override} onChange={(e) => setOverride(e.target.value)}>
                <option value="">Keep the services in the file</option>
                {p.services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <input type="hidden" name="unmappedPolicy" value={override ? "use_override" : "exclude"} />
          {override ? (
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <input type="checkbox" name="overrideAllServices" checked={overrideAll} onChange={(e) => setOverrideAll(e.target.checked)} className="size-5 accent-accent" />
              Price every shipment on this service, not only the unmapped ones (what-if comparison)
            </label>
          ) : null}
        </fieldset>

        {p.askResidential || p.askOrigin ? (
          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold">What the file does not say</legend>
            {p.askResidential ? (
              <Field id={`${id}-res`} label="Deliveries to homes or businesses?" hint="The file has no residential flag. Residential surcharges priced on this choice are shown as estimates.">
                {(aria) => (
                  <Select {...aria} name="residentialDefault" defaultValue="yes">
                    <option value="yes">Treat all orders as home deliveries (most online orders are)</option>
                    <option value="no">Treat all orders as business deliveries</option>
                  </Select>
                )}
              </Field>
            ) : null}
            {p.askOrigin ? (
              <Field id={`${id}-origin`} label="Ships from ZIP code" error={state.errors?.originZipDefault} hint={p.defaultOriginZip ? `${p.tenantName} set ${p.defaultOriginZip} as the ship-from ZIP; change it if these orders ship from elsewhere.` : `${p.tenantName} has not set a ship-from ZIP; enter the warehouse ZIP these orders ship from.`}>
                {(aria) => <Input {...aria} name="originZipDefault" inputMode="numeric" defaultValue={p.defaultOriginZip ?? ""} placeholder="e.g. 90001" maxLength={5} />}
              </Field>
            ) : null}
          </fieldset>
        ) : null}

        {!p.projectId ? (
          <Field id={`${id}-name`} label="Scenario name (optional)" hint="Leave empty for a name built from the file and your choices.">
            {(aria) => <Input {...aria} name="name" maxLength={160} placeholder="e.g. Q1 orders at today's rates" />}
          </Field>
        ) : null}
        <SubmitButton pendingLabel="Starting…">{p.projectId ? "Run again" : "Run the model"}</SubmitButton>
      </ActionForm>
    </Card>
  );
}
