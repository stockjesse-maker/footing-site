import { Button, ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/field";
import { uuidSchema } from "@/lib/auth/validation";
import { formatDate } from "@/lib/format/date";

/**
 * Read-only browser for a version's rate rows (Server Components; the filter form is a plain
 * GET form so it needs no JavaScript). The page runs the query; this file holds the filter
 * parsing, the presentation and a few display helpers shared by the rate-card pages.
 */

export const ROWS_PAGE_SIZE = 100;

export interface RateRowRecord {
  id: number;
  service_id: string;
  origin_prefix: string | null;
  zone: string;
  weight_min: string | number;
  weight_max: string | number;
  weight_unit: "lb" | "oz";
  price: string | number;
  min_charge: string | number | null;
}

export interface ZoneRowRecord {
  id: number;
  carrier_code: string;
  origin_prefix: string;
  dest_prefix_from: string;
  dest_prefix_to: string;
  zone: string;
}

export interface RowsFilter {
  /** shipping_services.id, or "" for every service. */
  service: string;
  zone: string;
  origin: string;
  page: number;
}

export interface ServiceOptionRecord {
  id: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Money with two decimals; null/empty shows as an em dash. */
export function formatUsd(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  return Number.isFinite(n) ? usd.format(n) : String(value);
}

/** Shows a numeric value as stored, minus trailing zeros ("1.000" → "1", "0.500" → "0.5"). */
export function formatDecimal(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const s = String(value);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

export function formatEffectivity(effective: string | null, expiration: string | null): string {
  if (!effective) return "Dates are set at activation";
  return expiration ? `${formatDate(effective)} – ${formatDate(expiration)}` : `From ${formatDate(effective)}, no end date`;
}

// ---------------------------------------------------------------------------
// Filters and pagination (URL search params)
// ---------------------------------------------------------------------------

const text = (v: string | string[] | undefined) => (typeof v === "string" ? v.trim() : "");

/** Sanitises search params: anything that cannot be a valid value is dropped rather than queried. */
export function parseRowsFilter(params: Record<string, string | string[] | undefined>): RowsFilter {
  const serviceRaw = text(params.service);
  const service = uuidSchema.safeParse(serviceRaw).success ? serviceRaw : "";
  const zoneRaw = text(params.zone).toUpperCase().replace(/^ZONE\s*/, "");
  const zone = /^[A-Z0-9]{1,12}$/.test(zoneRaw) ? zoneRaw : "";
  const originRaw = text(params.origin).replace(/-\d{4}$/, "");
  const origin = /^\d{3}$|^\d{5}$/.test(originRaw) ? originRaw : "";
  const page = Math.max(1, Number.parseInt(text(params.page) || "1", 10) || 1);
  return { service, zone, origin, page };
}

export function rowsHref(basePath: string, filter: RowsFilter, page: number): string {
  const q = new URLSearchParams();
  if (filter.service) q.set("service", filter.service);
  if (filter.zone) q.set("zone", filter.zone);
  if (filter.origin) q.set("origin", filter.origin);
  if (page > 1) q.set("page", String(page));
  const query = q.toString();
  return `${basePath}${query ? `?${query}` : ""}#rows`;
}

// ---------------------------------------------------------------------------
// Rows browser
// ---------------------------------------------------------------------------

const cell = "px-3 py-2.5 sm:px-4";

export function VersionRowsBrowser({ basePath, services, filter, rows, total }: { basePath: string; services: ServiceOptionRecord[]; filter: RowsFilter; rows: RateRowRecord[]; total: number }) {
  const serviceName = new Map(services.map((s) => [s.id, s.label]));
  const showService = !filter.service && services.length > 1;
  const from = (filter.page - 1) * ROWS_PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(total / ROWS_PAGE_SIZE));
  const filtered = Boolean(filter.service || filter.zone || filter.origin);

  return (
    <div className="space-y-4">
      <form method="get" action={`${basePath}#rows`} className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem_11rem_auto] sm:items-end">
        <Field id="rows-service" label="Service">
          {(aria) => (
            <Select {...aria} name="service" defaultValue={filter.service}>
              <option value="">All services</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="rows-zone" label="Zone">
          {(aria) => <Input {...aria} name="zone" defaultValue={filter.zone} placeholder="Any" autoComplete="off" />}
        </Field>
        <Field id="rows-origin" label="Origin ZIP prefix">
          {(aria) => <Input {...aria} name="origin" defaultValue={filter.origin} placeholder="Any" inputMode="numeric" autoComplete="off" />}
        </Field>
        <Button type="submit" variant="secondary">
          Apply filters
        </Button>
      </form>

      {rows.length ? (
        <>
          <p className="text-sm text-muted">
            Showing rows {(from + 1).toLocaleString("en-US")}–{(from + rows.length).toLocaleString("en-US")} of {total.toLocaleString("en-US")}
            {filtered ? " matching the filters" : ""}. Prices are the base rate before surcharges; a bracket covers weights above its lower bound up to and including its upper bound.
          </p>
          <div className="overflow-x-auto rounded-card border border-line bg-raised shadow-card">
            <table className="w-full text-sm">
              <caption className="sr-only">Rate rows for this version</caption>
              <thead>
                <tr className="border-b border-line text-left text-xs font-medium text-muted">
                  {showService ? (
                    <th scope="col" className={`hidden sm:table-cell ${cell}`}>
                      Service
                    </th>
                  ) : null}
                  <th scope="col" className={cell}>
                    Zone
                  </th>
                  <th scope="col" className={cell}>
                    Origin
                  </th>
                  <th scope="col" className={cell}>
                    Weight bracket
                  </th>
                  <th scope="col" className={`text-right ${cell}`}>
                    Price
                  </th>
                  <th scope="col" className={`text-right ${cell}`}>
                    Min charge
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => {
                  const service = serviceName.get(r.service_id) ?? "Unknown service";
                  return (
                    <tr key={r.id}>
                      {showService ? <td className={`hidden sm:table-cell ${cell}`}>{service}</td> : null}
                      <td className={cell}>
                        <span className="tabular font-medium">{r.zone}</span>
                        {showService ? <span className="block text-xs text-muted sm:hidden">{service}</span> : null}
                      </td>
                      <td className={`tabular text-muted ${cell}`}>{r.origin_prefix ?? "Any"}</td>
                      <td className={`tabular whitespace-nowrap ${cell}`}>
                        {formatDecimal(r.weight_min)}–{formatDecimal(r.weight_max)} {r.weight_unit}
                      </td>
                      <td className={`tabular whitespace-nowrap text-right font-medium ${cell}`}>{formatUsd(r.price)}</td>
                      <td className={`tabular whitespace-nowrap text-right text-muted ${cell}`}>{formatUsd(r.min_charge)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {pages > 1 ? (
            <nav className="flex items-center justify-between text-sm" aria-label="Rate rows pagination">
              {filter.page > 1 ? (
                <ButtonLink href={rowsHref(basePath, filter, filter.page - 1)} variant="secondary" size="sm">
                  Previous
                </ButtonLink>
              ) : (
                <span />
              )}
              <span className="tabular text-muted">
                Page {filter.page} of {pages}
              </span>
              {filter.page < pages ? (
                <ButtonLink href={rowsHref(basePath, filter, filter.page + 1)} variant="secondary" size="sm">
                  Next
                </ButtonLink>
              ) : (
                <span />
              )}
            </nav>
          ) : null}
        </>
      ) : (
        <EmptyState
          title={filtered ? "No rows match these filters" : "No rate rows"}
          action={
            filtered ? (
              <ButtonLink href={`${basePath}#rows`} variant="secondary" size="sm">
                Clear filters
              </ButtonLink>
            ) : undefined
          }
        >
          {filtered ? "Try a different service, zone or origin prefix." : "This version holds no prices, so it cannot be activated."}
        </EmptyState>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Zone chart summary
// ---------------------------------------------------------------------------

export function ZoneChartSummary({ count, sample }: { count: number; sample: ZoneRowRecord[] }) {
  if (!count) {
    return (
      <EmptyState title="No zone chart on this version">
        The calculator can only price shipments whose destination zone is entered directly. ZIP-to-zone lookup becomes available once a zone chart is attached to a version.
      </EmptyState>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        {count.toLocaleString("en-US")} {count === 1 ? "entry" : "entries"} map origin and destination ZIP prefixes to zones. The first {Math.min(sample.length, count)} are shown.
      </p>
      <div className="overflow-x-auto rounded-card border border-line bg-raised shadow-card">
        <table className="w-full text-sm">
          <caption className="sr-only">Zone chart sample</caption>
          <thead>
            <tr className="border-b border-line text-left text-xs font-medium text-muted">
              <th scope="col" className={cell}>
                Carrier
              </th>
              <th scope="col" className={cell}>
                Origin
              </th>
              <th scope="col" className={cell}>
                Destination prefixes
              </th>
              <th scope="col" className={`text-right ${cell}`}>
                Zone
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {sample.map((z) => (
              <tr key={z.id}>
                <td className={cell}>{z.carrier_code}</td>
                <td className={`tabular ${cell}`}>{z.origin_prefix}</td>
                <td className={`tabular ${cell}`}>
                  {z.dest_prefix_from}–{z.dest_prefix_to}
                </td>
                <td className={`tabular text-right font-medium ${cell}`}>{z.zone}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
