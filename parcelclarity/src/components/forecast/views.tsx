import Link from "next/link";
import { notFound } from "next/navigation";
import { ForecastForm } from "@/components/forecast/forecast-form";
import { ForecastManage } from "@/components/forecast/forecast-manage";
import { ForecastResult } from "@/components/forecast/forecast-result";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { uuidSchema } from "@/lib/auth/validation";
import { forecastResultData, loadForecastContext, loadSavedForecast } from "@/lib/forecast/queries";
import { formatDate } from "@/lib/format/date";
import type { ModelingView } from "@/lib/modeling/page-context";

/**
 * Server-rendered forecast pages shared by the customer portal (/portal/model/forecast) and the 3PL's
 * on-behalf pages (/app/customers/[brandId]/model/forecast). Every query runs under the viewer's Row
 * Level Security; the view only decides vocabulary and links.
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

const todayUtc = () => new Date().toISOString().slice(0, 10);

/** A real calendar date as YYYY-MM-DD ("2026-02-30" is not one). */
function isoDateOrNull(value: string | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value ? value : null;
}

/**
 * The form: describe the orders you expect, preview the expected cost per order, save it. `?from=` starts from a
 * saved forecast; `?date=` opens it on a date other than today (the only way in when the rate card has no rates today).
 */
export async function ForecastNewView(v: ModelingView, searchParams: { from?: string; date?: string }) {
  const fromId = searchParams.from && uuidSchema.safeParse(searchParams.from).success ? searchParams.from : null;
  const startDate = isoDateOrNull(searchParams.date);
  const saved = fromId ? await loadSavedForecast(v.supabase, v.brandId, fromId) : null;
  // An edit starts on the rate card the saved forecast used, while the customer still has it (the loader falls back to the first card otherwise).
  const context = await loadForecastContext(v.supabase, { brandId: v.brandId, tenantDefaultOriginZip: v.tenantDefaultOriginZip, asOfDate: startDate ?? todayUtc(), rateCardId: saved?.rateCardId ?? null });
  const whose = v.staff ? "the customer's" : "your";
  return (
    <>
      <BackLink href={v.basePath} label={v.staff ? `Model costs for ${v.brandName}` : "Model Costs"} />
      <PageHeader
        title="Forecast from your assumptions"
        description={`Describe the orders you expect and see the expected cost per order on ${whose} rate card and fee schedule. A forecast is an estimate, never an invoice or a quote.${v.staff ? " What you prepare stays private to your team until you share it with the customer." : ""}`}
      />
      {fromId && !saved ? <Alert tone="info" className="mb-6">That forecast could not be found, so you are starting from scratch.</Alert> : null}
      {saved && !saved.assumptions ? <Alert tone="info" className="mb-6">{saved.name} was saved with numbers this form can no longer read, so you are starting from scratch. The saved forecast is unchanged.</Alert> : null}
      {context.status === "no_card" ? (
        <EmptyState title="Nothing to price against yet">{v.staff ? "Assign an active rate card to this customer first." : `${v.tenantName} has not assigned a rate card to your account yet.`}</EmptyState>
      ) : context.status === "no_rates" ? (
        <div className="space-y-4">
          <Alert tone="warning">{context.message}</Alert>
          {/* A plain GET form: there is no forecast form to change the date in until a date with rates is chosen. */}
          <form method="get" className="flex flex-col gap-3 sm:flex-row sm:items-end">
            {fromId ? <input type="hidden" name="from" value={fromId} /> : null}
            <Field id="forecast-retry-date" label="Rates and fees as of" hint="The rate card and fee schedule in effect on this date.">
              {(aria) => <Input {...aria} type="date" name="date" required defaultValue={startDate ?? undefined} className="max-w-48" />}
            </Field>
            <Button type="submit" variant="secondary">
              Use this date
            </Button>
          </form>
        </div>
      ) : context.status === "failed" ? (
        <Alert tone="danger">{context.message}</Alert>
      ) : (
        <ForecastForm
          audience={v.staff ? "staff" : "brand"}
          brandId={v.staff ? v.brandId : undefined}
          tenantName={v.tenantName}
          context={context}
          initial={saved?.assumptions ?? null}
          editedFrom={saved?.assumptions ? { name: saved.name, asOfDate: saved.asOfDate } : null}
          startDate={startDate}
        />
      )}
    </>
  );
}

/** A saved forecast: the result as it was priced, with rename, archive and "Edit as new forecast". */
export async function ForecastSavedView(v: ModelingView, projectId: string) {
  if (!uuidSchema.safeParse(projectId).success) notFound();
  const saved = await loadSavedForecast(v.supabase, v.brandId, projectId);
  if (!saved) notFound();
  const audience = v.staff ? "staff" : "brand";
  const data = forecastResultData(saved.summary, audience);
  const editHref = `${v.basePath}/forecast?from=${saved.projectId}`;
  return (
    <>
      <BackLink href={v.basePath} label={v.staff ? `Model costs for ${v.brandName}` : "Model Costs"} />
      <PageHeader
        title={saved.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone="success">Saved forecast</Badge>
            {saved.archivedAt ? <Badge tone="neutral">Archived</Badge> : null}
            {v.staff && !saved.sharedWithBrand ? <Badge tone="warning">Private to your team</Badge> : null}
          </span>
        }
        actions={<ButtonLink href={editHref} variant="secondary">Edit as new forecast</ButtonLink>}
      />
      <div className="space-y-6">
        <p className="text-sm text-muted">
          Saved {formatDate(saved.createdAt)}
          {saved.rateCardName ? ` · ${saved.rateCardName}` : ""} · priced on {formatDate(saved.asOfDate)}. The forecast does not change afterwards; to try other numbers, edit it as a new forecast.
        </p>
        <ForecastManage projectId={saved.projectId} name={saved.name} brandId={v.staff ? v.brandId : undefined} staff={v.staff} shared={saved.sharedWithBrand} archived={saved.archivedAt !== null} />
        <ForecastResult data={data} audience={audience} editHref={editHref} />
      </div>
    </>
  );
}
