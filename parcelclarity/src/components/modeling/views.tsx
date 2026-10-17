import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import type { ForecastSummary } from "@/engine/forecast/types";
import type { BulkSummary } from "@/engine/modeling/types";
import type { ShipmentCalculation, ShipmentInput } from "@/engine/types";
import { PossibleAdjustmentsHubCard, hasCurrentAdjustmentExample } from "@/components/adjustments/customer/hub-card";
import { DatasetList, HubCard, OverviewFigures, ScenarioList, overviewModels, runStateLabel } from "@/components/modeling/lists";
import { OrderMappingWizard, type DatasetValidation } from "@/components/modeling/order-mapping-wizard";
import { RunProgress } from "@/components/modeling/run-progress";
import {
  MinimumCard,
  MonthlyChargesCard,
  NotIncludedCard,
  OrderFeesCard,
  OrdersTable,
  RunBreakdowns,
  RunExclusions,
  RunHeadline,
  ShipmentsTable,
  type OrderRowView,
  type RunProvenance,
  type ShipmentRowView,
} from "@/components/modeling/run-results";
import { RunSetupForm } from "@/components/modeling/run-setup-form";
import { OrderUploadForm, SkuProfilesForm } from "@/components/modeling/upload-forms";
import { CalculationResult, formatDecimal } from "@/components/pricing/calculation-result";
import { CalculatorForm } from "@/components/pricing/calculator-form";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/auth/permissions";
import { getContext } from "@/lib/auth/session";
import { uuidSchema } from "@/lib/auth/validation";
import { formatDate } from "@/lib/format/date";
import { assumptionsLine, buildComparison, defaultView, feeScheduleLine, feesChangedSince, isForecastSummary, parseView, uncoveredFeeDatesNote, type CompareRunInput, type HeadlineView } from "@/lib/modeling/headline";
import type { AssumptionsLike } from "@/lib/modeling/assumptions";
import type { ModelingView } from "@/lib/modeling/page-context";
import type { RunAssumptions } from "@/lib/modeling/run";
import {
  fileSummaryOf,
  forecastSummaryOf,
  loadAssignedCards,
  loadAssumptionsAuthor,
  loadCurrentFeeVersion,
  loadModelingLists,
  loadOrderResults,
  loadOrderShipping,
  loadRunFeeContexts,
  loadRunSetupData,
  loadRunsForCompare,
  type CompareRunRow,
  type ProjectListRow,
  type RunListRow,
} from "@/lib/modeling/queries";
import type { OrderDetection } from "@/lib/orders/mapping";
import type { OrderMapping } from "@/lib/orders/types";

/**
 * Server-rendered views shared by the customer portal (/portal/model) and the 3PL's on-behalf
 * pages (/app/customers/[brandId]/model). Every query runs under the viewer's Row Level Security;
 * the view only decides vocabulary and links.
 */


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
  // The adjustments card is for the customer only (never the 3PL's on-behalf hub), and only while one example is current.
  const [{ datasets, projects }, assigned, showAdjustments] = await Promise.all([
    loadModelingLists(v.supabase, v.brandId),
    loadAssignedCards(v.supabase, v.brandId, v.tenantDefaultOriginZip),
    v.staff ? Promise.resolve(false) : hasCurrentAdjustmentExample(v.supabase, v.brandId),
  ]);
  const models = overviewModels(projects);
  const brandIdProp = v.staff ? v.brandId : undefined;
  return (
    <>
      {v.staff ? <BackLink href={`/app/customers/${v.brandId}`} label={v.brandName} /> : null}
      <PageHeader
        title={v.staff ? `Model costs for ${v.brandName}` : "Model Costs"}
        description={v.staff ? "What you prepare here stays private to your team until you share it with the customer." : `Estimate shipping and fulfillment costs on the pricing and fee schedule ${v.tenantName} assigned to you. Every result is an estimate, never an invoice.`}
      />
      {!assigned.cards.length ? (
        <Alert tone="warning" className="mb-6">
          {v.staff ? "Assign an active rate card to this customer before modeling." : `${v.tenantName} has not assigned a rate card to your account yet, so nothing can be priced.`}
        </Alert>
      ) : null}
      {models.latest || models.forecast || models.whatIf ? (
        <div className="mb-8">
          <OverviewFigures projects={projects} basePath={v.basePath} tenantName={v.tenantName} audience={v.staff ? "staff" : "brand"} />
        </div>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <HubCard title="Price one shipment" description="Weight, size, destination and service: see every charge explained, with the order fees for what is in the box." href={`${v.basePath}/calculator`} cta="Open the calculator" />
        <HubCard
          title="Forecast from assumptions"
          description={v.staff ? "No orders file yet? Describe the orders the customer expects and see the expected cost per order, shipping and fulfillment." : "No orders file yet? Describe the orders you expect and see the expected cost per order, shipping and fulfillment."}
          href={`${v.basePath}/forecast`}
          cta="Forecast from assumptions"
        />
        <HubCard title="Product weights" description="For orders files that carry no package weight (Shopify exports)." href={`${v.basePath}/products`} cta="Manage product weights" />
        {!v.staff ? <HubCard title="Your fee schedule" description={`The fulfillment fees ${v.tenantName} charges you: what each one is and how it is counted.`} href={`${v.basePath}/fees`} cta="See your fee schedule" /> : null}
        {!v.staff && showAdjustments ? <PossibleAdjustmentsHubCard tenantName={v.tenantName} /> : null}
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
  const [assigned, { count: skuCount }, setupData] = await Promise.all([
    loadAssignedCards(v.supabase, v.brandId, v.tenantDefaultOriginZip),
    v.supabase.from("sku_profiles").select("id", { count: "exact", head: true }).eq("brand_id", v.brandId),
    // Step 2 of the run form ("Fulfillment costs") is only asked for a file that is ready to run.
    ds.status === "ready" ? loadRunSetupData(v.supabase, v.brandId, ds.id) : Promise.resolve(null),
  ]);
  const brandIdProp = v.staff ? v.brandId : undefined;
  const unmapped = ds.validation?.issuesByCode.find((i) => i.code === "service_unmapped")?.shipments ?? 0;
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
          uploadHref={v.basePath}
          hasCards={assigned.cards.length > 0}
        />
        {ds.status === "ready" && !assigned.cards.length ? (
          <Alert tone="warning">{v.staff ? "Assign an active rate card to this customer to run the model." : `${v.tenantName} has not assigned a rate card to your account, so this file cannot be priced yet.`}</Alert>
        ) : null}
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
            tenantName={v.tenantName}
            fulfillment={setupData}
            audience={v.staff ? "staff" : "brand"}
          />
        ) : null}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
/** A run read whole for its own page: the whole summary and every assumption, where a list row carries only the headline inputs. */
interface RunRow extends Omit<RunListRow, "summary" | "assumptions"> {
  summary: BulkSummary | ForecastSummary | null;
  assumptions: RunAssumptions | null;
  project_id: string;
  brand_id: string;
  created_by: string | null;
  monthly_fee_schedule_version_id: string | null;
  single_input: ShipmentInput | null;
  single_result: ShipmentCalculation | null;
  simulation_projects: { id: string; name: string; dataset_id: string | null; shared_with_brand: boolean; rate_cards: { name: string } | null; order_datasets: { name: string; mapping: OrderMapping | null; validation: DatasetValidation | null } | null } | null;
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
  in_totals: boolean;
  shipments: { external_shipment_id: string | null; destination_zip: string | null; ship_date: string | null; orders: { external_order_id: string; order_date: string | null } | null } | null;
  shipping_services: { name: string } | null;
}

const PAGE_SIZE = 50;

/** Where "Add" links point: the run-again form at the bottom of the run page (step 2 there takes the numbers). */
const RUN_AGAIN_HREF = "#run-again";

export interface RunSearchParams {
  page?: string;
  status?: string;
  /** shipping | fees | allin */
  view?: string;
  /** Page of the orders table (the shipments table keeps `page`). */
  opage?: string;
}

/** True when the run carries fulfillment answers the customer or the 3PL typed (not a skip, not an empty set). */
function hasFulfillmentAnswers(f: NonNullable<RunRow["assumptions"]>["fulfillment"]): boolean {
  if (!f || f.skip) return false;
  return Object.keys(f.drivers ?? {}).length > 0 || Object.keys(f.orderShares ?? {}).length > 0 || !!f.monthlyOrders || !!f.packagingDefault || (f.orderContent?.rows.length ?? 0) > 0;
}

/** Why a run failed, for staff: `simulation_run_failures` has no policy a customer can pass, and brand screens never ask. */
async function loadRunFailureDetail(supabase: ModelingView["supabase"], runId: string): Promise<string | null> {
  const { data } = await supabase.from("simulation_run_failures").select("detail").eq("run_id", runId).maybeSingle();
  return typeof data?.detail === "string" && data.detail ? data.detail : null;
}

/** The distinct pricing problems a run met, for staff: `simulation_run_contexts` is staff-only, and brand screens never ask. */
async function loadRunLoadIssues(supabase: ModelingView["supabase"], runId: string): Promise<string[]> {
  const { data } = await supabase.from("simulation_run_contexts").select("load_issues").eq("run_id", runId);
  const issues = new Set<string>();
  for (const row of (data ?? []) as { load_issues: string[] | null }[]) for (const issue of row.load_issues ?? []) issues.add(issue);
  return [...issues].sort();
}

export async function RunView(v: ModelingView, runId: string, searchParams: RunSearchParams) {
  if (!uuidSchema.safeParse(runId).success) notFound();
  const { data } = await v.supabase
    .from("simulation_runs")
    .select(
      "id, project_id, brand_id, status, kind, pricing_basis, as_of_date, service_override_id, assumptions, created_at, created_by, finished_at, last_progress_at, total_shipments, processed_shipments, modeled_orders, total_expected, summary, monthly_fee_schedule_version_id, single_input, single_result, simulation_projects(id, name, dataset_id, shared_with_brand, rate_cards(name), order_datasets(name, mapping, validation)), shipping_services(name)",
    )
    .eq("id", runId)
    .maybeSingle();
  const run = data as RunRow | null;
  if (!run || run.brand_id !== v.brandId || !run.simulation_projects) notFound();
  const project = run.simulation_projects;
  // A forecast from assumptions has no shipments or orders to list: it has its own page.
  if (run.kind === "forecast") redirect(`${v.basePath}/forecast/${project.id}`);
  const brandIdProp = v.staff ? v.brandId : undefined;
  const audience = v.staff ? "staff" : "brand";
  const state = runStateLabel(run);

  if (run.kind === "single") {
    const input = run.single_input;
    return (
      <>
        <BackLink href={v.basePath} label="Model Costs" />
        <PageHeader title={project.name} description={<Badge tone="success">Saved scenario</Badge>} />
        <div className="space-y-6">
          {input ? (
            <Card>
              <CardTitle>What was priced</CardTitle>
              <dl className="mt-3 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <SingleDetail label="Ship date">{formatDate(input.shipDate)}</SingleDetail>
                <SingleDetail label="From">{input.originZip}</SingleDetail>
                <SingleDetail label="To">{input.destinationZone ? `zone ${input.destinationZone}` : (input.destinationZip ?? "—")}</SingleDetail>
                <SingleDetail label="Delivery">{input.residential ? "Home address" : "Business address"}</SingleDetail>
                <SingleDetail label="Service">{run.single_result?.service?.serviceName ?? `${input.carrierCode} ${input.serviceCode}`}</SingleDetail>
                <SingleDetail label="Options">{[input.options?.signature && input.options.signature !== "none" ? `${input.options.signature.replace(/_/g, " ")} signature` : null, input.options?.saturdayDelivery ? "Saturday delivery" : null].filter(Boolean).join(", ") || "None"}</SingleDetail>
                <SingleDetail label={input.packages.length === 1 ? "Package" : "Packages"}>
                  {input.packages.map((p, i) => (
                    <span key={i} className="block">
                      {formatDecimal(p.weight)} {p.weightUnit}
                      {p.length && p.width && p.height ? ` · ${formatDecimal(p.length)} × ${formatDecimal(p.width)} × ${formatDecimal(p.height)} in` : " · no dimensions"}
                    </span>
                  ))}
                </SingleDetail>
              </dl>
              <p className="mt-3 text-sm text-muted">Saved {formatDate(run.created_at)}; the price does not change afterwards. To price the same shipment again, enter it in the calculator.</p>
            </Card>
          ) : null}
          {run.single_result ? <CalculationResult result={run.single_result} audience={audience} cardName={project.rate_cards?.name ?? "your rate card"} effectiveDate={null} shipDate={run.as_of_date} /> : <EmptyState title="No result stored" />}
        </div>
      </>
    );
  }

  const assigned = await loadAssignedCards(v.supabase, v.brandId, v.tenantDefaultOriginZip);
  const dataset = project.order_datasets;
  const assumptions = run.assumptions ?? {};
  // Step 2 of the form (fulfillment costs) is read for the file of this run and opens with the answers it was run with. Its questions are those of the fee
  // schedule version in effect on the day this run took its monthly charges from (the as-of date, or the end of the file's period), not today's: an "Add"
  // link on a model priced for a past date must lead to the questions of that date's version, or to a form with no step 2 at all.
  const runFeeDate = run.pricing_basis === "fixed_date" ? run.as_of_date : (fileSummaryOf(run)?.period.to ?? null);
  const setupData = run.status !== "running" && project.dataset_id ? await loadRunSetupData(v.supabase, v.brandId, project.dataset_id, runFeeDate ?? undefined) : null;
  const setup = (
    <div id="run-again" className="scroll-mt-4">
      <RunSetupForm
        brandId={brandIdProp}
        projectId={project.id}
        fulfillmentDatasetId={project.dataset_id ?? undefined}
        cards={[]}
        services={assigned.services.map((s) => ({ id: s.id, carrierCode: s.carrierCode, name: s.name }))}
        askResidential={dataset?.mapping?.columns.residential === null}
        askOrigin={dataset?.mapping?.columns.originZip === null}
        defaultOriginZip={assigned.defaultOriginZip}
        unmappedShipments={dataset?.validation?.issuesByCode.find((i) => i.code === "service_unmapped")?.shipments ?? 0}
        earliestRatesDate={assigned.cards.flatMap((c) => c.versions.map((x) => x.effectiveDate)).filter((d): d is string => !!d).sort()[0] ?? null}
        firstOrderDate={dataset?.validation?.dateRange.from ?? null}
        tenantName={v.tenantName}
        fulfillment={setupData}
        audience={audience}
        initial={{
          pricingBasis: run.pricing_basis,
          asOfDate: run.as_of_date,
          serviceOverrideId: run.service_override_id,
          overrideAllServices: assumptions.overrideAllServices ?? false,
          residentialDefault: assumptions.residentialDefault ?? null,
          originZipDefault: assumptions.originZipDefault ?? null,
          fulfillment: assumptions.fulfillment ?? null,
        }}
      />
    </div>
  );

  if (run.status === "running") {
    // The progress card owns the live state; a server-rendered "paused" badge would contradict it as soon as the loop resumes.
    return (
      <>
        <BackLink href={v.basePath} label="Model Costs" />
        <PageHeader title={project.name} />
        <RunProgress runId={run.id} brandId={brandIdProp} initial={{ processed: run.processed_shipments, total: run.total_shipments, status: run.status }} />
      </>
    );
  }
  if (run.status !== "completed" || !run.summary) {
    // What went wrong can name server internals: only staff read it (from a staff-only table), a customer reads the sentence alone.
    const failureDetail = run.status === "failed" && v.staff ? await loadRunFailureDetail(v.supabase, run.id) : null;
    return (
      <>
        <BackLink href={v.basePath} label="Model Costs" />
        <PageHeader title={project.name} description={<Badge tone={state.tone}>{state.label}</Badge>} />
        <Alert tone={run.status === "failed" ? "danger" : "info"} className="mb-6">
          {run.status === "failed"
            ? `This run could not finish. Nothing from it is shown as a result. You can run it again below; if it keeps failing, contact ${v.staff ? "support" : v.tenantName}.${failureDetail ? ` (${failureDetail})` : ""}`
            : "This run was cancelled before it finished; nothing from it is shown as a result."}
        </Alert>
        {setup}
      </>
    );
  }

  const summary = fileSummaryOf(run);
  if (!summary) {
    // Priced before fulfillment fees existed (a version 1 summary): its figures have no fee sections to show.
    return (
      <>
        <BackLink href={v.basePath} label="Model Costs" />
        <PageHeader title={project.name} description={<Badge tone={state.tone}>{state.label}</Badge>} />
        <Alert tone="info" className="mb-6">
          This model was priced before fulfillment fees were added, so it has no fee figures to show. Run it again below to price shipping and fees together.
        </Alert>
        {setup}
      </>
    );
  }

  const page = Math.max(1, Number.parseInt(searchParams.page ?? "1", 10) || 1);
  const orderPage = Math.max(1, Number.parseInt(searchParams.opage ?? "1", 10) || 1);
  const status = searchParams.status === "ok" || searchParams.status === "unavailable" ? searchParams.status : "all";
  const chosenView = parseView(searchParams.view);
  const view: HeadlineView = chosenView ?? defaultView(summary);
  const modeled = summary.fees.mode === "modeled";
  const answered = hasFulfillmentAnswers(assumptions.fulfillment);
  const ctx = await getContext();
  // What each pricing problem says names the 3PL's rules; the summary holds only a count, so staff read the text from the run's contexts (staff only).
  const staffLoadIssues = v.staff && summary.loadIssueCount > 0 ? await loadRunLoadIssues(v.supabase, run.id) : [];

  let query = v.supabase
    .from("simulation_results")
    .select("row_no, status, unavailable_reason, ship_date, zone, billable_lb, definite, estimated, expected, conditional_exposure, unresolved, in_totals, shipments(external_shipment_id, destination_zip, ship_date, orders(external_order_id, order_date)), shipping_services(name)", { count: "exact" })
    .eq("run_id", run.id)
    .order("row_no")
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (status !== "all") query = query.eq("status", status);
  const [{ data: resultRows, count }, orderResults, contexts, currentFee, author] = await Promise.all([
    query.overrideTypes<ResultRow[], { merge: false }>(),
    modeled ? loadOrderResults(v.supabase, run.id, { from: (orderPage - 1) * PAGE_SIZE, to: orderPage * PAGE_SIZE - 1 }) : Promise.resolve(null),
    modeled ? loadRunFeeContexts(v.supabase, run.id) : Promise.resolve(null),
    modeled ? loadCurrentFeeVersion(v.supabase, v.brandId) : Promise.resolve(null),
    answered && ctx ? loadAssumptionsAuthor(v.supabase, { createdBy: run.created_by, viewerId: ctx.user.id, viewerCanSeeMembers: can(ctx.active.role, "member.view"), brandId: v.brandId }) : Promise.resolve(null),
  ]);
  const orderShipping = orderResults && !orderResults.error ? await loadOrderShipping(v.supabase, run.id, orderResults.rows.map((r) => r.orderId)) : null;
  const ordersFailed = !!orderResults && (!!orderResults.error || !orderShipping || !!orderShipping.error);
  const orderRows: OrderRowView[] =
    orderResults && orderShipping && !ordersFailed
      ? orderResults.rows.map((r) => ({
          orderId: r.orderId,
          externalOrderId: r.externalOrderId,
          units: r.units,
          lines: r.lines,
          packages: r.packages,
          assumed: r.assumed,
          feeStatus: r.feeStatus,
          definiteE4: r.definiteE4,
          estimatedE4: r.estimatedE4,
          unresolved: r.unresolved,
          shippingExpected: orderShipping.shipping.get(r.orderId)?.expected ?? null,
        }))
      : [];

  const rows: ShipmentRowView[] = (resultRows ?? []).map((r) => ({
    rowNo: r.row_no,
    externalOrderId: r.shipments?.orders?.external_order_id ?? "—",
    externalShipmentId: r.shipments?.external_shipment_id ?? null,
    shipDate: r.shipments?.ship_date ?? r.shipments?.orders?.order_date ?? null,
    pricedOn: r.ship_date,
    inTotals: r.in_totals,
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

  const pinnedVersions = [...(contexts?.versions.map((x) => x.versionId) ?? []), ...(run.monthly_fee_schedule_version_id ? [run.monthly_fee_schedule_version_id] : [])];
  const csvQuery = v.staff ? `?brandId=${v.brandId}` : "";
  const provenance: RunProvenance = {
    scenarioName: project.name,
    datasetName: dataset?.name ?? null,
    rateCardName: project.rate_cards?.name ?? "rate card",
    pricingBasis: run.pricing_basis,
    asOfDate: run.as_of_date,
    serviceOverrideName: run.shipping_services?.name ?? null,
    overrideAllServices: assumptions.overrideAllServices ?? false,
    residentialDefault: assumptions.residentialDefault ?? null,
    originZipDefault: assumptions.originZipDefault ?? null,
    finishedAt: run.finished_at,
    exportHref: `/api/runs/${run.id}/results.csv${csvQuery}`,
    audience,
    ordersCsvHref: modeled ? `/api/runs/${run.id}/orders.csv${csvQuery}` : null,
    monthlyCsvHref: modeled && summary.monthly ? `/api/runs/${run.id}/monthly.csv${csvQuery}` : null,
    addHref: RUN_AGAIN_HREF,
    feeScheduleLine: modeled ? feeScheduleLine(v.tenantName, summary.provenance) : null,
    feesChanged: modeled && currentFee ? feesChangedSince(pinnedVersions, currentFee) : false,
    assumptionsLine: author ? assumptionsLine(author, v.tenantName, run.created_at) : null,
    uncoveredNote: modeled ? uncoveredFeeDatesNote(contexts?.uncovered ?? null) : null,
  };

  const link = (over: { view?: HeadlineView; page?: number; status?: string; opage?: number; hash?: string }) => {
    const q = new URLSearchParams();
    const shown = over.view ?? chosenView;
    if (shown) q.set("view", shown);
    const p = over.page ?? page;
    if (p > 1) q.set("page", String(p));
    const st = over.status ?? status;
    if (st !== "all") q.set("status", st);
    const op = over.opage ?? orderPage;
    if (op > 1) q.set("opage", String(op));
    const qs = q.toString();
    return `${v.basePath}/runs/${run.id}${qs ? `?${qs}` : ""}${over.hash ? `#${over.hash}` : ""}`;
  };

  return (
    <>
      <BackLink href={v.basePath} label="Model Costs" />
      <PageHeader
        title={project.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={state.tone}>{state.label}</Badge>
            {v.staff ? <Badge tone={project.shared_with_brand ? "success" : "warning"}>{project.shared_with_brand ? "Shared with the customer" : "Private to your team"}</Badge> : null}
          </span>
        }
      />
      {v.staff ? <p className="mb-6 text-sm text-muted">Modeled on behalf of {v.brandName}. The wording and figures below are the ones the customer sees once this scenario is shared.</p> : null}
      <div className="space-y-8">
        <RunHeadline summary={summary} provenance={provenance} view={view} viewHref={(next) => link({ view: next })} />
        <RunExclusions summary={summary} fixHref={project.dataset_id ? `${v.basePath}/orders/${project.dataset_id}` : null} staff={v.staff} staffLoadIssues={staffLoadIssues} />
        <OrderFeesCard summary={summary} addHref={RUN_AGAIN_HREF} />
        <MonthlyChargesCard summary={summary} addHref={RUN_AGAIN_HREF} />
        <MinimumCard summary={summary} />
        <NotIncludedCard summary={summary} addHref={RUN_AGAIN_HREF} audience={audience} />
        <RunBreakdowns summary={summary} />
        {modeled && orderResults ? <OrdersTable summary={summary} rows={orderRows} page={orderPage} pageSize={PAGE_SIZE} total={orderResults.count ?? orderRows.length} hrefFor={(p) => link({ opage: p, hash: "orders" })} loadError={ordersFailed} /> : null}
        <ShipmentsTable rows={rows} page={page} pageSize={PAGE_SIZE} total={count ?? rows.length} hrefFor={(p, s) => link({ page: p, status: s, hash: "shipments" })} status={status} pricedButExcluded={summary.pricedButExcluded.shipments} />
        {setup}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Reports: list and compare
// ---------------------------------------------------------------------------
function SingleDetail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="font-medium break-words">{children}</dd>
    </div>
  );
}

type ComparableRun = { project: ProjectListRow; run: RunListRow };

/** A completed model that can be compared: an orders-file run or a forecast, with a current (fee-aware) summary. */
function isComparable(run: RunListRow): boolean {
  return run.status === "completed" && (fileSummaryOf(run) !== null || forecastSummaryOf(run) !== null);
}

/** A comparison reads each of its two runs whole (the lists only carry headline inputs): the row for the list's run, the summary and assumptions from `full`. */
function compareInput(x: ComparableRun, full: CompareRunRow): CompareRunInput {
  const forecast = isForecastSummary(full.summary) ? full.summary : null;
  return {
    summary: full.summary,
    datasetId: x.project.dataset_id,
    datasetName: x.project.order_datasets?.name ?? null,
    rateCardName: forecast ? forecast.provenance.rateCardName : (x.project.rate_cards?.name ?? null),
    pricingBasis: x.run.pricing_basis,
    asOfDate: x.run.as_of_date,
    serviceOverrideId: x.run.service_override_id,
    serviceOverrideName: x.run.shipping_services?.name ?? null,
    overrideAllServices: full.assumptions?.overrideAllServices ?? false,
    // A forecast stores its own assumptions in the same column; only the fields both kinds share are read.
    assumptions: full.assumptions as AssumptionsLike | null,
  };
}

export async function ReportsView(v: ModelingView, searchParams: { a?: string; b?: string }) {
  const { projects } = await loadModelingLists(v.supabase, v.brandId);
  const completed: ComparableRun[] = projects.flatMap((p) => p.simulation_runs.filter(isComparable).map((r) => ({ project: p, run: r })));
  const label = (x: ComparableRun) => {
    const forecast = forecastSummaryOf(x.run);
    const rates = forecast ? `rates of ${formatDate(forecast.asOfDate)}` : x.run.pricing_basis === "fixed_date" && x.run.as_of_date ? `rates of ${formatDate(x.run.as_of_date)}` : "rates on each ship date";
    return `${forecast ? "Forecast: " : ""}${x.project.name} · ${rates} · priced ${formatDate(x.run.finished_at ?? x.run.created_at)}`;
  };
  const pick = (id: string | undefined) => (id && uuidSchema.safeParse(id).success ? completed.find((x) => x.run.id === id) : undefined);
  const a = pick(searchParams.a);
  const b = pick(searchParams.b);
  // The two runs are read whole for the comparison only; the lists above and below carry just the headline inputs.
  const full = a && b ? await loadRunsForCompare(v.supabase, v.brandId, a.run.id === b.run.id ? [a.run.id] : [a.run.id, b.run.id]) : null;
  const fullA = a ? full?.get(a.run.id) : undefined;
  const fullB = b ? full?.get(b.run.id) : undefined;
  return (
    <>
      {v.staff ? <BackLink href={v.basePath} label="Model Costs" /> : null}
      <PageHeader title="Reports" description="Saved models and forecasts side by side. Every figure is an estimate, never an invoice." />
      {a ? (
        <Card className="mb-6 space-y-4">
          <CardTitle>Compare</CardTitle>
          {!b ? (
            <div className="space-y-2 text-sm">
              <p className="text-muted">Comparing {label(a)}. Choose a second model:</p>
              <ul className="space-y-1">
                {completed
                  .filter((x) => x.run.id !== a.run.id)
                  .map((x) => (
                    <li key={x.run.id}>
                      <Link href={`${v.reportsPath}?a=${a.run.id}&b=${x.run.id}`} className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
                        {label(x)}
                      </Link>
                    </li>
                  ))}
              </ul>
            </div>
          ) : fullA && fullB ? (
            <CompareTable a={a} b={b} fullA={fullA} fullB={fullB} labelA={label(a)} labelB={label(b)} />
          ) : (
            <Alert tone="warning">These models could not be loaded for comparison just now. Reload the page to try again; if it keeps failing, run them again to price them with the current fees.</Alert>
          )}
        </Card>
      ) : null}
      <ScenarioList projects={projects} basePath={v.basePath} brandId={v.staff ? v.brandId : undefined} staff={v.staff} compareHref={v.reportsPath} />
    </>
  );
}

const COMPARE_GROUP_TITLE = { basis: "What each one is based on", figures: "Per order", allin: "All-in, with monthly charges spread over orders" } as const;

function CompareTable({ a, b, fullA, fullB, labelA, labelB }: { a: ComparableRun; b: ComparableRun; fullA: CompareRunRow; fullB: CompareRunRow; labelA: string; labelB: string }) {
  const c = buildComparison(compareInput(a, fullA), compareInput(b, fullB));
  const groups = (["basis", "figures", "allin"] as const).map((g) => ({ group: g, rows: c.rows.filter((r) => r.group === g) }));
  return (
    <div className="space-y-4">
      {c.warnings.length ? (
        <Alert tone="warning">
          <ul className="list-disc space-y-1 pl-5">
            {c.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {c.changes.length ? (
        <div className="space-y-1 text-sm">
          <p className="font-medium">What differs in the assumptions</p>
          <ul className="list-disc space-y-1 pl-5 text-muted">
            {c.changes.map((line, i) => (
              <li key={`${i}:${line}`}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Comparison">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="py-1 pr-3 font-medium">
                <span className="sr-only">Figure</span>
              </th>
              <th className="py-1 pr-3 font-medium">{labelA}</th>
              <th className="py-1 font-medium">{labelB}</th>
            </tr>
          </thead>
          {groups.map(({ group, rows }) => (
            <tbody key={group} className="divide-y divide-line">
              <tr>
                <th colSpan={3} scope="rowgroup" className="pt-4 pb-1 text-left text-xs font-semibold tracking-wide text-muted uppercase">
                  {COMPARE_GROUP_TITLE[group]}
                </th>
              </tr>
              {rows.map((r) => (
                <tr key={r.label} className={r.muted ? "text-muted" : undefined}>
                  <th scope="row" className="py-2 pr-3 text-left font-normal text-muted">
                    {r.label}
                    {r.note ? <span className="mt-1 block text-xs font-normal">{r.note}</span> : null}
                  </th>
                  <td className="tabular py-2 pr-3">{r.a}</td>
                  <td className="tabular py-2">{r.b}</td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
      {!c.allInComparable && c.allInNote ? <p className="text-sm text-muted">{c.allInNote}</p> : null}
    </div>
  );
}
