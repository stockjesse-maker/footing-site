"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { createDraftFromImport, discardImport, saveMappingAndValidate } from "@/app/actions/rate-cards";
import { useFormState } from "@/components/forms/action-form";
import { ConfirmAction } from "@/components/forms/confirm-action";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { DataList, DataRow } from "@/components/ui/data-list";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/field";
import { Stat } from "@/components/ui/stat";
import { mappingSchema } from "@/lib/import/mapping-schema";
import { normalizeServiceText, type Detection, type GridMapping, type LongMapping, type RateCardMapping, type ServiceCatalogEntry, type WeightUnit } from "@/lib/import/rate-card-mapping";
import type { Issue, ParsedRateRow, ValidationReport } from "@/lib/import/rate-card-validate";

/**
 * Rate-card import wizard: the administrator reviews the detected column mapping, validates it
 * against the whole file and, when it is clean, creates a draft version. The mapping edited here
 * is the exact shape of RateCardMapping; it is checked with mappingSchema before it is sent, and
 * the server checks it again.
 */

// ---------------------------------------------------------------------------
// Types shared with the pages
// ---------------------------------------------------------------------------

export type DetectedSheet = Detection["sheets"][number];

export interface ImportValidation extends ValidationReport {
  /** First 25 parsed rows, stored by saveMappingAndValidate for the preview. */
  sampleRows?: ParsedRateRow[];
}

/** rate_card_imports row as the review page passes it (jsonb columns already typed). */
export interface ImportRow {
  id: string;
  status: string;
  rate_card_id: string;
  version_id: string | null;
  detected: Detection & { kind: "csv" | "xlsx"; filename: string };
  mapping: RateCardMapping | null;
  validation: ImportValidation | null;
}

// ---------------------------------------------------------------------------
// Small client pieces also used by the upload page
// ---------------------------------------------------------------------------

export function ImportStatusBadge({ status }: { status: string }) {
  const tone = status === "validated" ? "success" : status === "imported" ? "accent" : status === "discarded" ? "danger" : status === "mapped" ? "warning" : "neutral";
  const label = status === "uploaded" ? "awaiting mapping" : status === "mapped" ? "needs fixes" : status;
  return <Badge tone={tone}>{label}</Badge>;
}

const STEPS = ["Upload", "Map columns", "Review"] as const;

export function ImportSteps({ current }: { current: 1 | 2 | 3 }) {
  return (
    <ol aria-label="Import steps" className="mb-6 flex flex-wrap gap-2">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const state = n < current ? "done" : n === current ? "current" : "todo";
        return (
          <li
            key={label}
            aria-current={state === "current" ? "step" : undefined}
            className={cn(
              "inline-flex min-h-9 items-center gap-2 rounded-full px-3.5 text-sm font-medium",
              state === "current" && "bg-accent text-accent-fg",
              state === "done" && "bg-success-soft text-success",
              state === "todo" && "bg-surface text-muted",
            )}
          >
            <span className="tabular">{n}</span>
            {label}
          </li>
        );
      })}
    </ol>
  );
}

/** File picker for the upload step. Lives in this client module so it can read the ActionForm's field errors. */
export function RateCardFileField() {
  const state = useFormState();
  return (
    <Field id="file" label="Rate file" error={state.errors?.file} hint="A .csv or .xlsx file up to 5 MB. Nothing is imported until you approve the column mapping.">
      {(aria) => (
        <Input
          {...aria}
          type="file"
          name="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          required
          className="cursor-pointer py-2 file:mr-3 file:rounded-control file:border-0 file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-fg"
        />
      )}
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Draft mapping model (what the form edits) and its conversion to RateCardMapping
// ---------------------------------------------------------------------------

type ColumnKey = keyof LongMapping["columns"];

const COLUMN_FIELDS: { key: ColumnKey; label: string; required: boolean; hint?: string }[] = [
  { key: "carrier", label: "Carrier", required: false },
  { key: "service", label: "Service", required: true, hint: "Service name as written in the file." },
  { key: "originZip", label: "Origin ZIP", required: false, hint: "Only when the card prices per origin." },
  { key: "zone", label: "Zone", required: true },
  { key: "weightMin", label: "Weight from", required: false, hint: "Derived from the previous bracket when absent." },
  { key: "weightMax", label: "Weight to", required: true, hint: "Upper bound of the bracket, e.g. 5 or “1-4 oz”." },
  { key: "weightUnit", label: "Weight unit", required: false },
  { key: "price", label: "Price", required: true },
  { key: "minCharge", label: "Minimum charge", required: false },
  { key: "dimDivisor", label: "DIM divisor", required: false },
];
const fieldLabel = (key: PropertyKey) => COLUMN_FIELDS.find((f) => f.key === key)?.label ?? String(key);

const EMPTY_COLUMNS: Record<ColumnKey, number | null> = { carrier: null, service: null, originZip: null, zone: null, weightMin: null, weightMax: null, weightUnit: null, price: null, minCharge: null, dimDivisor: null };

interface LongDraft {
  format: "long";
  sheet: string;
  headerRow: number;
  columns: Record<ColumnKey, number | null>;
  defaults: { weightUnit: WeightUnit; dimDivisor: string };
  serviceMap: Record<string, string>;
}
interface GridSheetDraft {
  include: boolean;
  sheet: string;
  serviceId: string;
  headerRow: number;
  weightColumn: number;
  weightUnit: WeightUnit;
  zoneColumns: { column: number; zone: string }[];
  originZip: string;
  dimDivisor: string;
  minCharge: string;
}
interface GridDraft {
  format: "grid";
  sheets: GridSheetDraft[];
}
type Draft = LongDraft | GridDraft;

function blankLong(sheet: DetectedSheet | undefined): LongDraft {
  return { format: "long", sheet: sheet?.name ?? "Sheet1", headerRow: sheet?.headerRow ?? 0, columns: { ...EMPTY_COLUMNS }, defaults: { weightUnit: "lb", dimDivisor: "" }, serviceMap: {} };
}

function longDraft(m: LongMapping, detected: ImportRow["detected"]): LongDraft {
  // Prefill every detected service with its best guess; the confidence badge tells the admin which to check.
  const serviceMap = { ...m.serviceMap };
  for (const s of detected.serviceStrings) if (!serviceMap[s.normalized] && s.suggestedServiceId) serviceMap[s.normalized] = s.suggestedServiceId;
  return { format: "long", sheet: m.sheet, headerRow: m.headerRow, columns: { ...m.columns }, defaults: { weightUnit: m.defaults.weightUnit, dimDivisor: m.defaults.dimDivisor ?? "" }, serviceMap };
}

function gridDraft(sheets: GridMapping["sheets"]): GridDraft {
  return {
    format: "grid",
    sheets: sheets.map((s) => ({ include: true, sheet: s.sheet, serviceId: s.serviceId, headerRow: s.headerRow, weightColumn: s.weightColumn, weightUnit: s.weightUnit, zoneColumns: s.zoneColumns, originZip: s.originZip ?? "", dimDivisor: s.dimDivisor ?? "", minCharge: s.minCharge ?? "" })),
  };
}

const ZONE_HEADER = /^(zone\s*)?([0-9]{1,2}|[a-z])$/i;
const WEIGHT_HEADER = /weight|lbs?\b|wt\b|oz\b|ounces|pounds/i;

/** Used only when the administrator overrides a "long" detection with the grid layout; mirrors the server's zone-header rule. */
function deriveGridSheet(sheet: DetectedSheet): GridSheetDraft | null {
  const zoneColumns = sheet.headers
    .map((h, column) => ({ h: h.trim(), column }))
    .filter(({ h }) => ZONE_HEADER.test(h))
    .map(({ h, column }) => ({ column, zone: h.replace(/zone\s*/i, "").toUpperCase() }));
  if (!zoneColumns.length) return null;
  const weightColumn = sheet.headers.findIndex((h, i) => WEIGHT_HEADER.test(h) && !zoneColumns.some((z) => z.column === i));
  return {
    include: true,
    sheet: sheet.name,
    serviceId: "",
    headerRow: sheet.headerRow,
    weightColumn: Math.max(0, weightColumn),
    weightUnit: /oz|ounce/i.test(sheet.headers[weightColumn] ?? "") ? "oz" : "lb",
    zoneColumns,
    originZip: "",
    dimDivisor: "",
    minCharge: "",
  };
}

function initialDraft(row: ImportRow): Draft {
  const base = row.mapping ?? row.detected.suggestion;
  if (base?.format === "long") return longDraft(base, row.detected);
  if (base?.format === "grid") return gridDraft(base.sheets);
  return blankLong(row.detected.sheets[0]);
}

/** Builds the RateCardMapping shape; required columns left unchosen stay null so mappingSchema reports them. */
function toMappingJson(draft: Draft): unknown {
  const opt = (s: string) => (s.trim() === "" ? null : s.trim());
  if (draft.format === "long") {
    return {
      format: "long",
      sheet: draft.sheet,
      headerRow: draft.headerRow,
      columns: draft.columns,
      defaults: { weightUnit: draft.defaults.weightUnit, dimDivisor: opt(draft.defaults.dimDivisor) },
      serviceMap: Object.fromEntries(Object.entries(draft.serviceMap).filter(([, v]) => v !== "")),
    };
  }
  return {
    format: "grid",
    sheets: draft.sheets
      .filter((s) => s.include)
      .map((s) => ({ sheet: s.sheet, serviceId: s.serviceId, headerRow: s.headerRow, weightColumn: s.weightColumn, weightUnit: s.weightUnit, zoneColumns: s.zoneColumns, originZip: opt(s.originZip), dimDivisor: opt(s.dimDivisor), minCharge: opt(s.minCharge) })),
  };
}

function describeIssue(path: PropertyKey[], draft: Draft): string {
  const [a, b, c] = path;
  if (a === "columns" && typeof b === "string") return `Choose the column that holds ${fieldLabel(b)}.`;
  if (a === "defaults" && b === "dimDivisor") return "The default DIM divisor must be a number, for example 139.";
  if (a === "sheets" && draft.format === "grid") {
    if (b === undefined) return "Include at least one sheet.";
    const name = draft.sheets.filter((s) => s.include)[typeof b === "number" ? b : -1]?.sheet ?? "?";
    if (c === "serviceId") return `Choose a service for sheet “${name}”.`;
    if (c === "originZip") return `Origin ZIP for sheet “${name}” must be 3 or 5 digits.`;
    if (c === "dimDivisor") return `DIM divisor for sheet “${name}” must be a number.`;
    if (c === "minCharge") return `Minimum charge for sheet “${name}” must be a number.`;
    if (c === "zoneColumns") return `Sheet “${name}” has no zone columns.`;
  }
  return "The mapping is incomplete.";
}

/** JSON with sorted keys, so a mapping read back from jsonb compares equal to the one the form holds. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const GENERIC = "Something went wrong. Please try again.";
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const money = (v: string | null | undefined) => (v ? usd.format(Number(v)) : "—");
const count = (n: number) => n.toLocaleString("en-US");
const colLabel = (i: number, headers: string[]) => `${i + 1}: ${headers[i]?.trim() || "(blank)"}`;
const where = (i: Issue) => [i.sheet, i.row !== undefined ? `row ${i.row}` : null].filter(Boolean).join(" · ");

interface CarrierGroup {
  carrierCode: string;
  carrierName: string;
  services: ServiceCatalogEntry[];
}

function groupByCarrier(catalog: ServiceCatalogEntry[]): CarrierGroup[] {
  const groups: CarrierGroup[] = [];
  for (const s of catalog) {
    let g = groups.find((x) => x.carrierCode === s.carrierCode);
    if (!g) {
      g = { carrierCode: s.carrierCode, carrierName: s.carrierName, services: [] };
      groups.push(g);
    }
    g.services.push(s);
  }
  return groups;
}

interface ServiceEntry {
  raw: string;
  normalized: string;
  suggestedServiceId: string | null;
  confidence: number;
}

type Aria = { id: string; "aria-describedby"?: string; "aria-invalid"?: true };

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------

export function ImportWizard({ importRow: row, catalog, rateCardId }: { importRow: ImportRow; catalog: ServiceCatalogEntry[]; rateCardId: string }) {
  const router = useRouter();
  const detected = row.detected;
  const validation = row.validation;
  const [draft, setDraft] = useState<Draft>(() => initialDraft(row));
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [validating, startValidate] = useTransition();
  const [creating, startCreate] = useTransition();
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const focusReview = useRef(false);

  const groups = useMemo(() => groupByCarrier(catalog), [catalog]);
  const catalogById = useMemo(() => new Map(catalog.map((c) => [c.id, c])), [catalog]);
  const parsed = useMemo(() => mappingSchema.safeParse(toMappingJson(draft)), [draft]);
  const dirty = useMemo(() => stableStringify(parsed.success ? parsed.data : null) !== stableStringify(row.mapping), [parsed, row.mapping]);

  // Service names come from detection; names the last validation flagged as unmapped are added so they can be fixed here.
  const serviceEntries = useMemo<ServiceEntry[]>(() => {
    const list: ServiceEntry[] = detected.serviceStrings.map((s) => ({ raw: s.raw, normalized: s.normalized, suggestedServiceId: s.suggestedServiceId, confidence: s.confidence }));
    const seen = new Set(list.map((s) => s.normalized));
    for (const issue of validation?.errors ?? []) {
      if (issue.code !== "service_unmapped") continue;
      const raw = /^Service "(.+)" is not mapped/.exec(issue.message)?.[1];
      if (!raw) continue;
      const normalized = normalizeServiceText(raw);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      list.push({ raw, normalized, suggestedServiceId: null, confidence: 0 });
    }
    return list;
  }, [detected.serviceStrings, validation]);

  useEffect(() => {
    if (focusReview.current && validation) {
      focusReview.current = false;
      reviewHeading.current?.focus();
    }
  }, [validation]);

  function validate() {
    setError(null);
    if (!parsed.success) {
      setProblems([...new Set(parsed.error.issues.map((i) => describeIssue(i.path, draft)))].slice(0, 6));
      return;
    }
    setProblems([]);
    const data = parsed.data;
    startValidate(async () => {
      const res = await saveMappingAndValidate(row.id, data);
      if (!res.ok) {
        setError(res.message ?? GENERIC);
        return;
      }
      focusReview.current = true;
      router.refresh();
    });
  }

  function createVersion() {
    setCreateError(null);
    startCreate(async () => {
      const res = await createDraftFromImport(row.id);
      if (!res.ok || !res.versionId) {
        setCreateError(res.message ?? GENERIC);
        return;
      }
      router.push(`/app/rate-cards/${rateCardId}/versions/${res.versionId}`);
    });
  }

  const discard = async () => {
    const res = await discardImport(row.id);
    if (res.ok) router.refresh();
    return res;
  };

  function switchFormat(format: "long" | "grid") {
    if (format === draft.format) return;
    setProblems([]);
    const suggestion = detected.suggestion;
    if (format === "long") setDraft(suggestion?.format === "long" ? longDraft(suggestion, detected) : blankLong(detected.sheets[0]));
    else setDraft(suggestion?.format === "grid" ? gridDraft(suggestion.sheets) : { format: "grid", sheets: detected.sheets.map(deriveGridSheet).filter((s): s is GridSheetDraft => s !== null) });
  }

  const unmapped = draft.format === "long" ? serviceEntries.filter((s) => !draft.serviceMap[s.normalized]).length : 0;
  const canCreate = !!validation?.ok && !dirty && row.status === "validated";

  return (
    <div className="space-y-10">
      <ImportSteps current={validation ? 3 : 2} />

      <section aria-labelledby="map-heading" className="space-y-5">
        <div>
          <h2 id="map-heading" className="text-xl font-semibold tracking-tight">
            Map columns
          </h2>
          <p className="mt-1 text-sm text-muted">
            {detected.filename} · {detected.kind.toUpperCase()} · {detected.sheets.length === 1 ? "1 sheet" : `${detected.sheets.length} sheets`}. The suggestions below were made from the headers only; nothing is imported until you validate and create a version.
          </p>
        </div>

        <div className="max-w-xl">
          <Field id="layout" label="File layout" hint={`Detected as ${detected.suggestedFormat}. Switch only if the file is laid out the other way.`}>
            {(aria) => (
              <Select {...aria} value={draft.format} onChange={(e) => switchFormat(e.target.value === "grid" ? "grid" : "long")}>
                <option value="long">Long: one row per service, zone and weight bracket</option>
                <option value="grid">Grid: weights down, zones across, one service per sheet</option>
              </Select>
            )}
          </Field>
        </div>

        {draft.format === "long" ? (
          <LongMapper draft={draft} detected={detected} groups={groups} serviceEntries={serviceEntries} onChange={setDraft} />
        ) : (
          <GridMapper draft={draft} detected={detected} groups={groups} onChange={setDraft} />
        )}

        {problems.length ? (
          <Alert tone="danger" title="Before validating">
            <ul className="list-disc space-y-1 pl-5">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
        {error ? <Alert tone="danger">{error}</Alert> : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={validate} loading={validating} size="lg">
            {validation ? "Validate again" : "Validate"}
          </Button>
          <ConfirmAction action={discard} label="Discard import" confirmLabel="Discard" variant="danger">
            Nothing will be added to the rate card.
          </ConfirmAction>
          <p className="w-full text-sm text-muted sm:w-auto">
            Validating saves the mapping and checks every row of the file.
            {unmapped ? ` ${count(unmapped)} service name${unmapped === 1 ? " is" : "s are"} still unmapped; its rows will be reported as errors.` : ""}
          </p>
        </div>
      </section>

      {validation ? (
        <ReviewSection validation={validation} dirty={dirty} canCreate={canCreate} creating={creating} createError={createError} onCreate={createVersion} catalogById={catalogById} rateCardId={rateCardId} headingRef={reviewHeading} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2: long layout
// ---------------------------------------------------------------------------

function LongMapper({ draft, detected, groups, serviceEntries, onChange }: { draft: LongDraft; detected: ImportRow["detected"]; groups: CarrierGroup[]; serviceEntries: ServiceEntry[]; onChange: (next: LongDraft) => void }) {
  const sheet = detected.sheets.find((s) => s.name === draft.sheet) ?? detected.sheets[0];
  const headers = sheet?.headers ?? [];
  const width = Math.max(headers.length, ...(sheet?.sample.map((r) => r.length) ?? []));
  const columnOptions = Array.from({ length: width }, (_, i) => ({ value: String(i), label: colLabel(i, headers) }));
  const tags = new Map<number, string>();
  for (const f of COLUMN_FIELDS) {
    const idx = draft.columns[f.key];
    if (idx !== null) tags.set(idx, f.label);
  }

  const setColumn = (key: ColumnKey, value: string) => onChange({ ...draft, columns: { ...draft.columns, [key]: value === "" ? null : Number(value) } });
  const setService = (normalized: string, serviceId: string) => onChange({ ...draft, serviceMap: { ...draft.serviceMap, [normalized]: serviceId } });
  const setSheet = (name: string) => {
    const next = detected.sheets.find((s) => s.name === name);
    onChange({ ...draft, sheet: name, headerRow: next?.headerRow ?? 0, columns: { ...EMPTY_COLUMNS } });
  };

  return (
    <div className="space-y-6">
      <Card>
        <h3 className="text-lg font-semibold tracking-tight">Columns</h3>
        <CardDescription>
          Pick the column that holds each value. Header row {draft.headerRow + 1}
          {sheet ? `, ${count(sheet.rowCount)} data rows` : ""}.
        </CardDescription>
        {detected.sheets.length > 1 ? (
          <div className="mt-5 max-w-sm">
            <Field id="long-sheet" label="Sheet" hint="The long layout imports one sheet.">
              {(aria) => (
                <Select {...aria} value={draft.sheet} onChange={(e) => setSheet(e.target.value)}>
                  {detected.sheets.map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        ) : null}
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          {COLUMN_FIELDS.map((f) => (
            <Field key={f.key} id={`col-${f.key}`} label={f.required ? f.label : `${f.label} (optional)`} hint={f.hint}>
              {(aria) => (
                <Select {...aria} value={draft.columns[f.key] === null ? "" : String(draft.columns[f.key])} onChange={(e) => setColumn(f.key, e.target.value)}>
                  <option value="">{f.required ? "— choose a column —" : "— not in file —"}</option>
                  {columnOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ))}
        </div>

        <h4 className="mt-7 text-sm font-semibold">Defaults</h4>
        <p className="mt-1 text-sm text-muted">Used when the file has no column for the value.</p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Field id="default-weight-unit" label="Weight unit">
            {(aria) => (
              <Select {...aria} value={draft.defaults.weightUnit} onChange={(e) => onChange({ ...draft, defaults: { ...draft.defaults, weightUnit: e.target.value === "oz" ? "oz" : "lb" } })}>
                <option value="lb">Pounds (lb)</option>
                <option value="oz">Ounces (oz)</option>
              </Select>
            )}
          </Field>
          <Field id="default-dim-divisor" label="DIM divisor (optional)" hint="Leave blank if the agreement does not state one; calculations then use actual weight and are marked as estimates.">
            {(aria) => <Input {...aria} inputMode="decimal" placeholder="e.g. 139" value={draft.defaults.dimDivisor} onChange={(e) => onChange({ ...draft, defaults: { ...draft.defaults, dimDivisor: e.target.value } })} />}
          </Field>
        </div>

        {sheet ? (
          <>
            <h4 className="mt-7 text-sm font-semibold">First rows of {sheet.name}</h4>
            <p className="mt-1 mb-3 text-sm text-muted">Check that the tagged columns line up with the values.</p>
            <SampleTable sheet={sheet} tags={tags} />
          </>
        ) : null}
      </Card>

      <div>
        <h3 className="text-lg font-semibold tracking-tight">Services</h3>
        <p className="mt-1 text-sm text-muted">Each service name in the file must map to a catalog service. Suggestions are matched from the text only; confirm each one.</p>
        {serviceEntries.length ? (
          <DataList className="mt-4">
            {serviceEntries.map((s, i) => {
              const id = `svc-${i}`;
              const value = draft.serviceMap[s.normalized] ?? "";
              const chosen = value !== "" && value !== s.suggestedServiceId;
              return (
                <DataRow key={s.normalized}>
                  <label htmlFor={id} className="flex min-w-0 flex-wrap items-center gap-2 font-medium">
                    <span className="truncate">{s.raw}</span>
                    {chosen ? <Badge>your choice</Badge> : value === "" ? <Badge tone="warning">unmapped</Badge> : <ConfidenceBadge confidence={s.confidence} />}
                  </label>
                  <div className="w-full sm:w-80">
                    <ServiceSelect aria={{ id }} value={value} groups={groups} onChange={(v) => setService(s.normalized, v)} />
                  </div>
                </DataRow>
              );
            })}
          </DataList>
        ) : (
          <p className="mt-4 text-sm text-muted">No service names were found in the service column. Choose the right column above, then validate; unmapped names will be listed here.</p>
        )}
      </div>
    </div>
  );
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  if (confidence >= 0.8) return <Badge tone="success">high match</Badge>;
  if (confidence >= 0.6) return <Badge tone="accent">medium match</Badge>;
  return <Badge tone="warning">check</Badge>;
}

function ServiceSelect({ aria, value, groups, onChange }: { aria: Aria; value: string; groups: CarrierGroup[]; onChange: (serviceId: string) => void }) {
  return (
    <Select {...aria} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">— choose a service —</option>
      {groups.map((g) => (
        <optgroup key={g.carrierCode} label={g.carrierName}>
          {g.services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}

// ---------------------------------------------------------------------------
// Step 2: grid layout
// ---------------------------------------------------------------------------

function GridMapper({ draft, detected, groups, onChange }: { draft: GridDraft; detected: ImportRow["detected"]; groups: CarrierGroup[]; onChange: (next: GridDraft) => void }) {
  const skipped = detected.sheets.filter((s) => !draft.sheets.some((d) => d.sheet === s.name));
  const update = (index: number, next: GridSheetDraft) => onChange({ ...draft, sheets: draft.sheets.map((s, i) => (i === index ? next : s)) });
  return (
    <div className="space-y-6">
      {draft.sheets.length ? (
        draft.sheets.map((s, i) => <GridSheetCard key={s.sheet} index={i} sheet={s} detected={detected.sheets.find((d) => d.name === s.sheet)} groups={groups} onChange={(next) => update(i, next)} />)
      ) : (
        <EmptyState title="No grid sheets found">No sheet has zone headers (such as 2, 3, 4 or Zone 2) across the top. Switch the layout to long, or upload a file with one service per sheet.</EmptyState>
      )}
      {skipped.length ? <p className="text-sm text-muted">Not imported (no zone columns detected): {skipped.map((s) => s.name).join(", ")}.</p> : null}
    </div>
  );
}

function GridSheetCard({ index, sheet, detected, groups, onChange }: { index: number; sheet: GridSheetDraft; detected: DetectedSheet | undefined; groups: CarrierGroup[]; onChange: (next: GridSheetDraft) => void }) {
  const id = (k: string) => `grid-${index}-${k}`;
  const headers = detected?.headers ?? [];
  const tags = new Map<number, string>([[sheet.weightColumn, "Weight"], ...sheet.zoneColumns.map((z) => [z.column, `Zone ${z.zone}`] as [number, string])]);
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold tracking-tight">{sheet.sheet}</h3>
          <CardDescription>{detected ? `${count(detected.rowCount)} rows below header row ${sheet.headerRow + 1}` : "This sheet was not found in the file."}</CardDescription>
        </div>
        <Button variant="secondary" onClick={() => onChange({ ...sheet, include: !sheet.include })}>
          {sheet.include ? "Skip this sheet" : "Include this sheet"}
        </Button>
      </div>
      {sheet.include ? (
        <>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <Field id={id("service")} label="Service" hint="The service this sheet prices.">
              {(aria) => <ServiceSelect aria={aria} value={sheet.serviceId} groups={groups} onChange={(serviceId) => onChange({ ...sheet, serviceId })} />}
            </Field>
            <Field id={id("weight-column")} label="Weight column">
              {(aria) => (
                <Select {...aria} value={String(sheet.weightColumn)} onChange={(e) => onChange({ ...sheet, weightColumn: Number(e.target.value) })}>
                  {headers.map((_, i) => (
                    <option key={i} value={String(i)}>
                      {colLabel(i, headers)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field id={id("unit")} label="Weight unit" hint="Used when the weight cells carry no unit.">
              {(aria) => (
                <Select {...aria} value={sheet.weightUnit} onChange={(e) => onChange({ ...sheet, weightUnit: e.target.value === "oz" ? "oz" : "lb" })}>
                  <option value="lb">Pounds (lb)</option>
                  <option value="oz">Ounces (oz)</option>
                </Select>
              )}
            </Field>
            <Field id={id("origin")} label="Origin ZIP (optional)" hint="3 or 5 digits, when this sheet prices from one origin.">
              {(aria) => <Input {...aria} inputMode="numeric" maxLength={5} placeholder="e.g. 606 or 60601" value={sheet.originZip} onChange={(e) => onChange({ ...sheet, originZip: e.target.value })} />}
            </Field>
            <Field id={id("dim")} label="DIM divisor (optional)" hint="Leave blank if the agreement does not state one; calculations are then marked as estimates.">
              {(aria) => <Input {...aria} inputMode="decimal" placeholder="e.g. 139" value={sheet.dimDivisor} onChange={(e) => onChange({ ...sheet, dimDivisor: e.target.value })} />}
            </Field>
            <Field id={id("min")} label="Minimum charge (optional)" hint="Applies to every zone and bracket on this sheet.">
              {(aria) => <Input {...aria} inputMode="decimal" placeholder="e.g. 0.00" value={sheet.minCharge} onChange={(e) => onChange({ ...sheet, minCharge: e.target.value })} />}
            </Field>
          </div>
          <h4 className="mt-7 text-sm font-semibold">Zone columns (detected)</h4>
          <ul className="mt-2 flex flex-wrap gap-2">
            {sheet.zoneColumns.map((z) => (
              <li key={z.column}>
                <Badge tone="accent">
                  Zone {z.zone} · column {z.column + 1}
                </Badge>
              </li>
            ))}
          </ul>
          {detected ? (
            <details className="mt-5">
              <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium text-accent-text">First rows of this sheet</summary>
              <div className="mt-3">
                <SampleTable sheet={detected} tags={tags} />
              </div>
            </details>
          ) : null}
        </>
      ) : (
        <p className="mt-4 text-sm text-muted">Skipped. Nothing from this sheet will be imported.</p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Shared: raw sample rows of a sheet
// ---------------------------------------------------------------------------

function SampleTable({ sheet, tags }: { sheet: DetectedSheet; tags: ReadonlyMap<number, string> }) {
  if (!sheet.sample.length) return <p className="text-sm text-muted">This sheet has no rows below the header.</p>;
  const width = Math.max(sheet.headers.length, ...sheet.sample.map((r) => r.length));
  const cols = Array.from({ length: width }, (_, i) => i);
  return (
    <div tabIndex={0} role="region" aria-label={`First rows of ${sheet.name}`} className="overflow-x-auto rounded-control border border-line">
      <table className="w-full text-sm">
        <caption className="sr-only">
          First {sheet.sample.length} rows of sheet {sheet.name}
        </caption>
        <thead className="bg-surface text-left text-xs text-muted">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Row
            </th>
            {cols.map((i) => (
              <th key={i} scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
                {colLabel(i, sheet.headers)}
                {tags.get(i) ? <span className="ml-1.5 rounded-full bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-accent-text">{tags.get(i)}</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {sheet.sample.map((r, ri) => (
            <tr key={ri}>
              <td className="tabular px-3 py-2 text-muted">{sheet.headerRow + 2 + ri}</td>
              {cols.map((ci) => (
                <td key={ci} className="tabular px-3 py-2 whitespace-nowrap">
                  {r[ci] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3: review
// ---------------------------------------------------------------------------

function ReviewSection({
  validation,
  dirty,
  canCreate,
  creating,
  createError,
  onCreate,
  catalogById,
  rateCardId,
  headingRef,
}: {
  validation: ImportValidation;
  dirty: boolean;
  canCreate: boolean;
  creating: boolean;
  createError: string | null;
  onCreate: () => void;
  catalogById: Map<string, ServiceCatalogEntry>;
  rateCardId: string;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  const sample = (validation.sampleRows ?? []).slice(0, 10);
  const serviceName = (id: string) => catalogById.get(id)?.name ?? id;
  const zoneList = (zones: string[]) => (zones.length > 12 ? `${zones.slice(0, 12).join(", ")}, …` : zones.join(", "));

  return (
    <section aria-labelledby="review-heading" className="space-y-6">
      <h2 id="review-heading" ref={headingRef} tabIndex={-1} className="text-xl font-semibold tracking-tight">
        Review
      </h2>
      {dirty ? <Alert tone="warning">The mapping changed since this validation ran. Validate again to refresh the results below.</Alert> : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Rate rows" value={count(validation.rowCount)} note="Parsed from the file" />
        <Stat label="Errors" value={count(validation.errorCount)} note={validation.errorCount ? "Block the import" : "Nothing blocks the import"} />
        <Stat label="Warnings" value={count(validation.warningCount)} note="For your judgement; they do not block" />
      </div>

      {validation.ok ? (
        <Alert tone="success" title="The file validates">
          Review the services and warnings, then create a draft version. Nothing changes for customers until you activate it.
        </Alert>
      ) : (
        <Alert tone="danger" title="Fix the errors, then validate again">
          Adjust the column or service mapping above, or correct the file and{" "}
          <Link href={`/app/rate-cards/${rateCardId}/import`} className="font-medium underline">
            upload it again
          </Link>
          . Every error must be resolved before a version can be created.
        </Alert>
      )}
      {validation.issuesTruncated ? <p className="text-sm text-muted">Only the first 300 errors and warnings are listed.</p> : null}

      <div>
        <h3 className="text-base font-semibold">Services</h3>
        {validation.services.length ? (
          <DataList className="mt-3">
            {validation.services.map((s) => {
              const origins = s.originPrefixes.filter((o) => o !== "any");
              return (
                <DataRow key={s.serviceId}>
                  <div className="min-w-0">
                    <p className="font-medium">{s.serviceName}</p>
                    <p className="text-sm text-muted">
                      {count(s.rowCount)} rows · {s.zones.length === 1 ? "1 zone" : `${s.zones.length} zones`} ({zoneList(s.zones)})
                      {origins.length ? ` · origins ${zoneList(origins)}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="tabular">Up to {s.maxWeight ? `${s.maxWeight.value} ${s.maxWeight.unit}` : "—"}</span>
                    {s.dimDivisor ? <Badge tone="accent">DIM divisor {s.dimDivisor}</Badge> : <Badge tone="warning">DIM divisor missing</Badge>}
                  </div>
                </DataRow>
              );
            })}
          </DataList>
        ) : (
          <p className="mt-2 text-sm text-muted">No rows were parsed, so there is nothing to summarise yet.</p>
        )}
      </div>

      {validation.errors.length ? <IssueList title="Errors" issues={validation.errors} tone="danger" /> : null}
      {validation.warnings.length ? <IssueList title="Warnings" issues={validation.warnings} tone="warning" collapsible /> : null}

      {sample.length ? (
        <div>
          <h3 className="text-base font-semibold">Parsed rows (preview)</h3>
          <p className="mt-1 text-sm text-muted">
            The first {sample.length} of {count(validation.rowCount)} rows as they will be stored. Prices are the base rates from your file; surcharges are not included.
          </p>
          <DataList className="mt-3">
            {sample.map((r, i) => (
              <DataRow key={`${r.source.sheet}-${r.source.row}-${i}`}>
                <div className="min-w-0">
                  <p className="font-medium">{serviceName(r.serviceId)}</p>
                  <p className="text-sm text-muted">
                    Zone {r.zone} · {r.weightMin}–{r.weightMax} {r.weightUnit}
                    {r.originPrefix ? ` · from ${r.originPrefix}` : ""} · {r.source.sheet} row {r.source.row}
                  </p>
                </div>
                <div className="sm:text-right">
                  <p className="tabular text-lg font-semibold">{money(r.price)}</p>
                  {r.minCharge ? <p className="text-sm text-muted">minimum {money(r.minCharge)}</p> : null}
                </div>
              </DataRow>
            ))}
          </DataList>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-6">
        <Button onClick={onCreate} loading={creating} disabled={!canCreate} size="lg">
          Create draft version
        </Button>
        <p className="w-full text-sm text-muted sm:w-auto">
          {canCreate ? "Creates a new draft version of this rate card. Nothing changes for customers until you activate it." : dirty ? "Validate the updated mapping first." : "Resolve the errors above first."}
        </p>
      </div>
      {createError ? <Alert tone="danger">{createError}</Alert> : null}
    </section>
  );
}

function IssueList({ title, issues, tone, collapsible }: { title: string; issues: Issue[]; tone: "danger" | "warning"; collapsible?: boolean }) {
  const heading = `${title} (${count(issues.length)})`;
  // The scroll region is focusable so keyboard users can reach issues beyond the first screenful.
  const list = (
    <div tabIndex={0} role="region" aria-label={heading} className="max-h-96 overflow-y-auto rounded-card border border-line bg-raised">
      <ul className="divide-y divide-line">
        {issues.map((issue, i) => (
          <li key={`${issue.code}-${issue.sheet ?? ""}-${issue.row ?? ""}-${i}`} className="px-4 py-3 text-sm">
            <span className={cn("mr-2 font-medium", tone === "danger" ? "text-danger" : "text-warning")}>{where(issue) || "File"}</span>
            {issue.message}
          </li>
        ))}
      </ul>
    </div>
  );
  if (collapsible && issues.length > 5) {
    // The heading stays outside the disclosure: inside <summary> it would drop out of the heading outline.
    return (
      <div>
        <h3 className="text-base font-semibold">{heading}</h3>
        <details className="mt-2">
          <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium text-accent-text">Show {title.toLowerCase()}</summary>
          <div className="mt-3">{list}</div>
        </details>
      </div>
    );
  }
  return (
    <div>
      <h3 className="text-base font-semibold">{heading}</h3>
      <div className="mt-3">{list}</div>
    </div>
  );
}
