import Link from "next/link";
import { notFound } from "next/navigation";
import type { ShipmentCalculation } from "@/engine/types";
import type { BulkSummary } from "@/engine/modeling/types";
import { DatasetList, HubCard, ScenarioList, runStateLabel } from "@/components/modeling/lists";
import { OrderMappingWizard, type DatasetValidation } from "@/components/modeling/order-mapping-wizard";
import { RunProgress } from "@/components/modeling/run-progress";
import { RunBreakdowns, RunExclusions, RunHeadline, ShipmentsTable, type RunProvenance, type ShipmentRowView } from "@/components/modeling/run-results";
import { RunSetupForm } from "@/components/modeling/run-setup-form";
import { OrderUploadForm, SkuProfilesForm } from "@/components/modeling/upload-forms";
import { CalculationResult, formatMoney } from "@/components/pricing/calculation-result";
import { CalculatorForm } from "@/components/pricing/calculator-form";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Stat } from "@/components/ui/stat";
import { uuidSchema } from "@/lib/auth/validation";
import { formatDate } from "@/lib/format/date";
import type { ModelingView } from "@/lib/modeling/page-context";
import { latestCompletedBulkRun, loadAssignedCards, loadModelingLists, type RunListRow } from "@/lib/modeling/queries";
import type { OrderDetection } from "@/lib/orders/mapping";
import type { OrderMapping } from "@/lib/orders/types";

/**
 * Server-rendered views shared by the customer portal (/portal/model) and the 3PL's on-behalf
 * pages (/app/customers/[brandId]/model). Every query runs under the viewer's Row Level Security;
 * the view only decides vocabulary and links.
 */

const today = () => new Date().toISOString().slice(0, 10);

function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <p className="mb-3 text-sm">
      <Link href={href} className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
        ← {label}
      </Link>
    </p>
  );
}

// ---------------------------------------------------------------------------
// Hub
// ---------------------------------------------------------------------------
export async function ModelHubView(v: ModelingView) {
  const [{ datasets, projects }, assigned] = await Promise.all([loadModelingLists(v.supabase, v.brandId), loadAssignedCards(v.supabase, v.brandId, v.tenantDefaultOriginZip)]);
  const latest = latestCompletedBulkRun(projects);
  const brandIdProp = v.staff ? v.brandId : undefined;
  return (
    <>
      {v.staff ? <BackLink href={`/app/customers/${v.brandId}`} label={v.brandName} /> : null}
      <PageHeader title={v.staff ? `Model costs for ${v.brandName}` : "Model Costs"} description={v.staff ? "What you prepare here stays private to your team until you share it with the customer." : `Estimate shipping costs on the pricing ${v.tenantName} assigned to you. Every result is an estimate, never an invoice.`} />
      {!assigned.cards.length ? (
        <Alert tone="warning" className="mb-6">
          {v.staff ? "Assign an active rate card to this customer before modeling." : `${v.tenantName} has not assigned a rate card to your account yet, so nothing can be priced.`}
        </Alert>
      ) : null}
      {latest ? (
        <section className="mb-8 space-y-3" aria-labelledby="latest-heading">
          <h2 id="latest-heading" className="text-xl font-semibold tracking-tight">
            Latest model
          </h2>
          <HeadlineFromRun summary={latest.run.summary!} run={latest.run} scenarioName={latest.project.name} rateCardName={latest.project.rate_cards?.name ?? "rate card"} href={`${v.basePath}/runs/${latest.run.id}`} />
        </section>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <HubCard title="Price one shipment" description="Weight, size, destination and service: see every charge explained." href={`${v.basePath}/calculator`} cta="Open the calculator" />
        <HubCard title="Product weights" description="For orders files that carry no package weight (Shopify exports)." href={`${v.basePath}/products`} cta="Manage product weights" />
      </div>
      <div className="mt-8 space-y-8">
        {assigned.cards.length ? <OrderUploadForm brandId={brandIdProp} tenantName={v.tenantName} /> : null}
        <section className="space-y-3" aria-labelledby="files-heading">
          <h2 id="files-heading" className="text-xl font-semibold tracking-tight">
            Orders files
          </h2>
          <DatasetList datasets={datasets} basePath={v.basePath} brandId={brandIdProp} staff={v.staff} />
        </section>
        <section className="space-y-3" aria-labelledby="scenarios-heading">
          <h2 id="scenarios-heading" className="text-xl font-semibold tracking-tight">
            Saved scenarios
          </h2>
          <ScenarioList projects={projects} basePath={v.basePath} brandId={brandIdProp} staff={v.staff} compareHref={v.reportsPath} />
        </section>
      </div>
    </>
  );
}

function HeadlineFromRun({ summary, run, scenarioName, rateCardName, href }: { summary: BulkSummary; run: RunListRow; scenarioName: string; rateCardName: string; href: string }) {
  return (
    <div className="space-y-2">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Estimated shipping cost per order" value={summary.averages.expectedPerOrder ? formatMoney({ amount: summary.averages.expectedPerOrder, currency: "USD" }) : "—"} note={`${summary.modeled.orders.toLocaleString("en-US")} of ${summary.imported.orders.toLocaleString("en-US")} orders (${summary.coverage.ordersPct}%)`} />
        <Stat label="Projected shipping spend" value={formatMoney({ amount: summary.totals.expected, currency: "USD" })} note="for the orders in the file" />
        <Stat label="Per package" value={summary.averages.expectedPerPackage ? formatMoney({ amount: summary.averages.expectedPerPackage, currency: "USD" }) : "—"} note={`${summary.modeled.packages.toLocaleString("en-US")} packages`} />
      </div>
      <p className="text-sm text-muted">
        <Link href={href} className="font-medium text-accent-text hover:underline">
          {scenarioName}
        </Link>{" "}
        · {rateCardName} · {run.pricing_basis === "fixed_date" && run.as_of_date ? `rates in effect on ${formatDate(run.as_of_date)}` : "rates on each ship date"} · estimates, not an invoice.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calculator and product weights
// ---------------------------------------------------------------------------
export async function CalculatorView(v: ModelingView) {
  const assigned = await loadAssignedCards(v.supabase, v.brandId, v.tenantDefaultOriginZip);
  return (
    <>
      <BackLink href={v.basePath} label="Model Costs" />
      <PageHeader title="Price one shipment" description={v.staff ? `Priced as ${v.brandName} would be: their exceptions apply, and saved results appear in their portal once shared.` : "Every charge is explained: what comes from your rate card, what is estimated, and what might be added after shipping."} />
      {assigned.cards.length ? (
        <CalculatorForm cards={assigned.cards} allowVersionChoice={false} audience={v.staff ? "staff" : "brand"} brandId={v.staff ? v.brandId : undefined} canSave />
      ) : (
        <EmptyState title="Nothing to price against yet">{v.staff ? "Assign an active rate card to this customer first." : `${v.tenantName} has not assigned a rate card to your account yet.`}</EmptyState>
      )}
    </>
  );
}

export async function ProductsView(v: ModelingView) {
  const { count } = await v.supabase.from("sku_profiles").select("id", { count: "exact", head: true }).eq("brand_id", v.brandId);
  const { data: sample } = await v.supabase.from("sku_profiles").select("sku, unit_weight, weight_unit, length_in, width_in, height_in").eq("brand_id", v.brandId).order("sku").limit(25);
  return (
    <>
      <BackLink href={v.basePath} label="Model Costs" />
      <PageHeader title="Product weights" description="Used only when an orders file carries no package weight. Prices built on them are shown as estimates." />
      <div className="space-y-6">
        <SkuProfilesForm brandId={v.staff ? v.brandId : undefined} count={count ?? 0} />
        {sample?.length ? (
          <Card>
            <CardTitle>On file</CardTitle>
            <CardDescription>{(count ?? 0) > 25 ? "The first 25 of " : ""}{(count ?? 0).toLocaleString("en-US")} products.</CardDescription>
            <div className="mt-3 overflow-x-auto" tabIndex={0} role="region" aria-label="Product weights on file">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted">
                    <th className="py-1 pr-3 font-medium">SKU</th>
                    <th className="py-1 pr-3 font-medium">Unit weight</th>
                    <th className="py-1 font-medium">Dimensions (in)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {sample.map((p) => (
                    <tr key={String(p.sku)}>
                      <td className="py-2 pr-3">{String(p.sku)}</td>
                      <td className="tabular py-2 pr-3">
                        {String(p.unit_weight)} {String(p.weight_unit)}
                      </td>
                      <td className="tabular py-2">{p.length_in ? `${p.length_in} × ${p.width_in} × ${p.height_in}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : null}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Orders file
// ---------------------------------------------------------------------------
interface DatasetRow {
  id: string;
  name: string;
  brand_id: string;
  status: string;
  detected: OrderDetection & { filename?: string };
  mapping: OrderMapping | null;
  validation: DatasetValidation | null;
  order_count: number;
  shipment_count: number;
  package_count: number;
}

export async function DatasetView(v: ModelingView, datasetId: string) {
  if (!uuidSchema.safeParse(datasetId).success) notFound();
  const { data } = await v.supabase.from("order_datasets").select("id, name, brand_id, status, detected, mapping, validation, order_count, shipment_count, package_count").eq("id", datasetId).maybeSingle();
  const ds = data as DatasetRow | null;
  if (!ds || ds.brand_id !== v.brandId || ds.status === "discarded") notFound();
  const [assigned, { count: skuCount }] = await Promise.all([
    loadAssignedCards(v.supabase, v.brandId, v.tenantDefaultOriginZip),
    v.supabase.from("sku_profiles").select("id", { count: "exact", head: true }).eq("brand_id", v.brandId),
  ]);
  const brandIdProp = v.staff ? v.brandId : undefined;
  const unmapped = ds.validation?.issuesByCode.find((i) => i.code === "service_unmapped")?.rows ?? 0;
  const earliestRates = assigned.cards.flatMap((c) => c.versions.map((x) => x.effectiveDate)).filter((d): d is string => !!d).sort()[0] ?? null;
  return (
    <>
      <BackLink href={v.basePath} label="Model Costs" />
      <PageHeader
        title={ds.name}
        description={ds.status === "ready" ? `${ds.order_count.toLocaleString("en-US")} orders · ${ds.shipment_count.toLocaleString("en-US")} shipments · ${ds.package_count.toLocaleString("en-US")} packages, ready to model.` : "Review how the file was read before anything is priced."}
      />
      <div className="space-y-6">
        <OrderMappingWizard
          datasetId={ds.id}
          brandId={brandIdProp}
          status={ds.status}
          detected={ds.detected}
          mapping={ds.mapping}
          validation={ds.validation}
          services={assigned.services.map((s) => ({ id: s.id, carrierCode: s.carrierCode, name: s.name }))}
          defaultOriginZip={assigned.defaultOriginZip}
          skuProfileCount={skuCount ?? 0}
          productsHref={`${v.basePath}/products`}
        />
        {ds.status === "ready" && assigned.cards.length ? (
          <RunSetupForm
            brandId={brandIdProp}
            datasetId={ds.id}
            cards={assigned.cards.map((c) => ({ id: c.id, name: c.name, effectiveDates: c.versions.map((x) => x.effectiveDate ?? "") }))}
            services={assigned.services.map((s) => ({ id: s.id, carrierCode: s.carrierCode, name: s.name }))}
            askResidential={ds.mapping?.columns.residential === null}
            askOrigin={ds.mapping?.columns.originZip === null}
            defaultOriginZip={assigned.defaultOriginZip}
            unmappedShipments={unmapped}
            earliestRatesDate={earliestRates}
            firstOrderDate={ds.validation?.dateRange.from ?? null}
            today={today()}
            tenantName={v.tenantName}
          />
        ) : null}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
interface RunRow extends RunListRow {
  project_id: string;
  brand_id: string;
  service_override_id: string | null;
  single_input: Record<string, unknown> | null;
  single_result: ShipmentCalculation | null;
  error: string | null;
  simulation_projects: { id: string; name: string; dataset_id: string | null; rate_cards: { name: string } | null; order_datasets: { name: string; mapping: OrderMapping | null; validation: DatasetValidation | null } | null } | null;
  shipping_services: { name: string } | null;
}

interface ResultRow {
  row_no: number;
  status: "ok" | "unavailable";
  unavailable_reason: string | null;
  ship_date: string | null;
  zone: string | null;
  billable_lb: string[] | null;
  definite: string | number;
  estimated: string | number;
  expected: string | number;
  conditional_exposure: string | number;
  unresolved: string | number;
  shipments: { external_shipment_id: string | null; destination_zip: string | null; orders: { external_order_id: string } | null } | null;
  shipping_services: { name: string } | null;
}

const PAGE_SIZE = 50;

export async function RunView(v: ModelingView, runId: string, searchParams: { page?: string; status?: string }) {
  if (!uuidSchema.safeParse(runId).success) notFound();
  const { data } = await v.supabase
    .from("simulation_runs")
    .select(
      "id, project_id, brand_id, status, kind, pricing_basis, as_of_date, service_override_id, created_at, finished_at, last_progress_at, total_shipments, processed_shipments, modeled_orders, total_expected, summary, single_input, single_result, error, simulation_projects(id, name, dataset_id, rate_cards(name), order_datasets(name, mapping, validation)), shipping_services(name)",
    )
    .eq("id", runId)
    .maybeSingle();
  const run = data as RunRow | null;
  if (!run || run.brand_id !== v.brandId || !run.simulation_projects) notFound();
  const project = run.simulation_projects;
  const brandIdProp = v.staff ? v.brandId : undefined;
  const state = runStateLabel(run);

  if (run.kind === "single") {
    return (
      <>
        <BackLink href={v.basePath} label="Model Costs" />
        <PageHeader title={project.name} description={<Badge tone="success">Saved scenario</Badge>} />
        {run.single_result ? <CalculationResult result={run.single_result} audience={v.staff ? "staff" : "brand"} cardName={project.rate_cards?.name ?? "your rate card"} effectiveDate={run.as_of_date} /> : <EmptyState title="No result stored" />}
      </>
    );
  }

  const assigned = await loadAssignedCards(v.supabase, v.brandId, v.tenantDefaultOriginZip);
  const dataset = project.order_datasets;
  const setup = (
    <RunSetupForm
      brandId={brandIdProp}
      projectId={project.id}
      cards={[]}
      services={assigned.services.map((s) => ({ id: s.id, carrierCode: s.carrierCode, name: s.name }))}
      askResidential={dataset?.mapping?.columns.residential === null}
      askOrigin={dataset?.mapping?.columns.originZip === null}
      defaultOriginZip={assigned.defaultOriginZip}
      unmappedShipments={dataset?.validation?.issuesByCode.find((i) => i.code === "service_unmapped")?.rows ?? 0}
      earliestRatesDate={assigned.cards.flatMap((c) => c.versions.map((x) => x.effectiveDate)).filter((d): d is string => !!d).sort()[0] ?? null}
      firstOrderDate={dataset?.validation?.dateRange.from ?? null}
      today={today()}
      tenantName={v.tenantName}
    />
  );

  if (run.status === "running") {
    return (
      <>
        <BackLink href={v.basePath} label="Model Costs" />
        <PageHeader title={project.name} description={<Badge tone={state.tone}>{state.label}</Badge>} />
        <RunProgress runId={run.id} brandId={brandIdProp} initial={{ processed: run.processed_shipments, total: run.total_shipments, status: run.status }} />
      </>
    );
  }
  if (run.status !== "completed" || !run.summary) {
    return (
      <>
        <BackLink href={v.basePath} label="Model Costs" />
        <PageHeader title={project.name} description={<Badge tone={state.tone}>{state.label}</Badge>} />
        <Alert tone={run.status === "failed" ? "danger" : "info"} className="mb-6">
          {run.status === "failed" ? `This run could not finish${run.error ? `: ${run.error}` : ""}. Nothing from it is shown as a result.` : "This run was cancelled before it finished; nothing from it is shown as a result."}
        </Alert>
        {setup}
      </>
    );
  }

  const page = Math.max(1, Number.parseInt(searchParams.page ?? "1", 10) || 1);
  const status = searchParams.status === "ok" || searchParams.status === "unavailable" ? searchParams.status : "all";
  let query = v.supabase
    .from("simulation_results")
    .select("row_no, status, unavailable_reason, ship_date, zone, billable_lb, definite, estimated, expected, conditional_exposure, unresolved, shipments(external_shipment_id, destination_zip, orders(external_order_id)), shipping_services(name)", { count: "exact" })
    .eq("run_id", run.id)
    .order("row_no")
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (status !== "all") query = query.eq("status", status);
  const { data: resultRows, count } = await query.overrideTypes<ResultRow[], { merge: false }>();
  const rows: ShipmentRowView[] = (resultRows ?? []).map((r) => ({
    rowNo: r.row_no,
    externalOrderId: r.shipments?.orders?.external_order_id ?? "—",
    externalShipmentId: r.shipments?.external_shipment_id ?? null,
    shipDate: r.ship_date,
    destinationZip: r.shipments?.destination_zip ?? null,
    zone: r.zone,
    serviceName: r.shipping_services?.name ?? null,
    billableLb: r.billable_lb,
    status: r.status,
    reason: r.unavailable_reason,
    expected: String(r.expected),
    definite: String(r.definite),
    estimated: String(r.estimated),
    conditional: String(r.conditional_exposure),
    unresolved: String(r.unresolved),
  }));
  const provenance: RunProvenance = {
    scenarioName: project.name,
    datasetName: dataset?.name ?? null,
    rateCardName: project.rate_cards?.name ?? "rate card",
    pricingBasis: run.pricing_basis,
    asOfDate: run.as_of_date,
    serviceOverrideName: run.shipping_services?.name ?? null,
    finishedAt: run.finished_at,
    exportHref: `/api/runs/${run.id}/results.csv${v.staff ? `?brandId=${v.brandId}` : ""}`,
  };
  const hrefFor = (p: number, s: string) => `${v.basePath}/runs/${run.id}?page=${p}${s !== "all" ? `&status=${s}` : ""}`;
  return (
    <>
      <BackLink href={v.basePath} label="Model Costs" />
      <PageHeader title={project.name} description={<Badge tone={state.tone}>{state.label}</Badge>} />
      <div className="space-y-8">
        <RunHeadline summary={run.summary} provenance={provenance} />
        <RunExclusions summary={run.summary} fixHref={project.dataset_id ? `${v.basePath}/orders/${project.dataset_id}` : null} />
        <RunBreakdowns summary={run.summary} />
        <ShipmentsTable rows={rows} page={page} pageSize={PAGE_SIZE} total={count ?? rows.length} hrefFor={hrefFor} status={status} />
        {setup}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Reports: list and compare
// ---------------------------------------------------------------------------
export async function ReportsView(v: ModelingView, searchParams: { a?: string; b?: string }) {
  const { projects } = await loadModelingLists(v.supabase, v.brandId);
  const completed = projects.flatMap((p) => p.simulation_runs.filter((r) => r.kind === "bulk" && r.status === "completed" && r.summary).map((r) => ({ project: p, run: r })));
  const pick = (id: string | undefined) => (id && uuidSchema.safeParse(id).success ? completed.find((x) => x.run.id === id) : undefined);
  const a = pick(searchParams.a);
  const b = pick(searchParams.b);
  return (
    <>
      {v.staff ? <BackLink href={v.basePath} label="Model Costs" /> : null}
      <PageHeader title="Reports" description="Saved models side by side. PDF reports arrive in a later release." />
      {a ? (
        <Card className="mb-6 space-y-4">
          <CardTitle>Compare</CardTitle>
          {!b ? (
            <div className="space-y-2 text-sm">
              <p className="text-muted">Comparing {a.project.name}. Choose a second model:</p>
              <ul className="space-y-1">
                {completed
                  .filter((x) => x.run.id !== a.run.id)
                  .map((x) => (
                    <li key={x.run.id}>
                      <Link href={`${v.reportsPath}?a=${a.run.id}&b=${x.run.id}`} className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
                        {x.project.name}
                      </Link>
                    </li>
                  ))}
              </ul>
            </div>
          ) : (
            <CompareTable a={a} b={b} />
          )}
        </Card>
      ) : null}
      <ScenarioList projects={projects} basePath={v.basePath} brandId={v.staff ? v.brandId : undefined} staff={v.staff} compareHref={v.reportsPath} />
    </>
  );
}

function CompareTable({ a, b }: { a: { project: { name: string; dataset_id: string | null; rate_cards: { name: string } | null }; run: RunListRow }; b: { project: { name: string; dataset_id: string | null; rate_cards: { name: string } | null }; run: RunListRow } }) {
  const sa = a.run.summary!;
  const sb = b.run.summary!;
  const warnings: string[] = [];
  if (a.project.dataset_id !== b.project.dataset_id) warnings.push("Different orders files were modeled, so the averages are not directly comparable.");
  if (Math.abs(Number(sa.coverage.ordersPct) - Number(sb.coverage.ordersPct)) > 5) warnings.push("The share of orders that could be priced differs by more than 5 points.");
  if (a.run.pricing_basis !== b.run.pricing_basis || a.run.as_of_date !== b.run.as_of_date) warnings.push("The two models use different pricing dates.");
  const m = (x: string | null) => (x ? formatMoney({ amount: x, currency: "USD" }) : "—");
  const rows: [string, string, string][] = [
    ["Rate card", a.project.rate_cards?.name ?? "—", b.project.rate_cards?.name ?? "—"],
    ["Rates", a.run.pricing_basis === "fixed_date" ? `as of ${a.run.as_of_date ?? "?"}` : "each ship date", b.run.pricing_basis === "fixed_date" ? `as of ${b.run.as_of_date ?? "?"}` : "each ship date"],
    ["Orders modeled", `${sa.modeled.orders.toLocaleString("en-US")} of ${sa.imported.orders.toLocaleString("en-US")} (${sa.coverage.ordersPct}%)`, `${sb.modeled.orders.toLocaleString("en-US")} of ${sb.imported.orders.toLocaleString("en-US")} (${sb.coverage.ordersPct}%)`],
    ["Estimated cost per order", m(sa.averages.expectedPerOrder), m(sb.averages.expectedPerOrder)],
    ["Per package", m(sa.averages.expectedPerPackage), m(sb.averages.expectedPerPackage)],
    ["Projected spend", m(sa.totals.expected), m(sb.totals.expected)],
    ["From rate card", m(sa.totals.definite), m(sb.totals.definite)],
    ["Based on assumptions", m(sa.totals.estimated), m(sb.totals.estimated)],
    ["Could not be decided (up to)", m(sa.exposure.unresolved.amount), m(sb.exposure.unresolved.amount)],
    ["May be added after shipping (up to)", m(sa.exposure.conditional.amount), m(sb.exposure.conditional.amount)],
  ];
  return (
    <div className="space-y-3">
      {warnings.length ? (
        <Alert tone="warning">
          <ul className="list-disc space-y-1 pl-5">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Comparison">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="py-1 pr-3 font-medium" />
              <th className="py-1 pr-3 font-medium">{a.project.name}</th>
              <th className="py-1 font-medium">{b.project.name}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map(([label, x, y]) => (
              <tr key={label}>
                <td className="py-2 pr-3 text-muted">{label}</td>
                <td className="tabular py-2 pr-3">{x}</td>
                <td className="tabular py-2">{y}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
