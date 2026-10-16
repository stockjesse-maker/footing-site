"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { carrierProfile } from "@/engine/carriers";
import type { ActionState } from "@/lib/actions";
import { fieldErrors, nameSchema, uuidSchema } from "@/lib/auth/validation";
import { requireTenantContext } from "@/lib/auth/session";
import { LIMITS, ParseError, detectFileKind, parseTables } from "@/lib/import/parse-table";
import { detectRateCard, type RateCardMapping } from "@/lib/import/rate-card-mapping";
import { mappingSchema } from "@/lib/import/mapping-schema";
import { applyMapping } from "@/lib/import/rate-card-validate";
import { loadServiceCatalog } from "@/lib/pricing/catalog";
import { RATE_LIMITED_MESSAGE, withinRateLimit } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";

const GENERIC_FAILURE = "Something went wrong. Please try again.";
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a date.");

// ---------------------------------------------------------------------------
// Rate cards
// ---------------------------------------------------------------------------
export async function createRateCard(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const ctx = await requireTenantContext("ratecard.manage");
  const parsed = z.object({ name: nameSchema, description: z.string().trim().max(1000).optional() }).safeParse({ name: formData.get("name"), description: formData.get("description") ?? undefined });
  const values = { name: String(formData.get("name") ?? "") };
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error), values };
  const supabase = await createClient();
  if (!(await withinRateLimit(supabase, "ratecard.create", 60, 3600))) return { ok: false, message: RATE_LIMITED_MESSAGE, values };
  const { data, error } = await supabase.from("rate_cards").insert({ tenant_id: ctx.active.tenantId, name: parsed.data.name, description: parsed.data.description || null }).select("id").single();
  if (error) {
    if (error.code === "23505") return { ok: false, errors: { name: "You already have a rate card with that name." }, values };
    return { ok: false, message: GENERIC_FAILURE, values };
  }
  revalidatePath("/app/rate-cards");
  redirect(`/app/rate-cards/${data.id}`);
}

export async function renameRateCard(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const ctx = await requireTenantContext("ratecard.manage");
  const parsed = z.object({ id: uuidSchema, name: nameSchema }).safeParse({ id: formData.get("id"), name: formData.get("name") });
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) };
  const supabase = await createClient();
  const { data, error } = await supabase.from("rate_cards").update({ name: parsed.data.name }).eq("id", parsed.data.id).eq("tenant_id", ctx.active.tenantId).select("id");
  if (error?.code === "23505") return { ok: false, errors: { name: "You already have a rate card with that name." } };
  if (error || !data?.length) return { ok: false, message: GENERIC_FAILURE };
  revalidatePath("/app/rate-cards", "layout");
  return { ok: true, message: "Saved." };
}

// ---------------------------------------------------------------------------
// Import step 1: upload and detect
// ---------------------------------------------------------------------------
export async function uploadRateCardFile(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const ctx = await requireTenantContext("ratecard.manage");
  const rateCardId = String(formData.get("rateCardId") ?? "");
  const file = formData.get("file");
  if (!uuidSchema.safeParse(rateCardId).success) return { ok: false, message: GENERIC_FAILURE };
  if (!(file instanceof File) || file.size === 0) return { ok: false, errors: { file: "Choose a .csv or .xlsx file." } };
  if (file.size > LIMITS.maxBytes) return { ok: false, errors: { file: "Files must be 5 MB or smaller." } };

  const supabase = await createClient();
  if (!(await withinRateLimit(supabase, "ratecard.upload", 30, 3600))) return { ok: false, message: RATE_LIMITED_MESSAGE };
  const { data: card } = await supabase.from("rate_cards").select("id, tenant_id, status").eq("id", rateCardId).maybeSingle();
  if (!card || card.tenant_id !== ctx.active.tenantId) return { ok: false, message: "Rate card not found." };
  if (card.status !== "active") return { ok: false, message: "This rate card is archived and cannot receive new versions." };

  const bytes = new Uint8Array(await file.arrayBuffer());
  let detection;
  let kind;
  try {
    kind = detectFileKind(file.name, file.type, bytes);
    const tables = await parseTables(bytes, kind);
    detection = detectRateCard(tables, await loadServiceCatalog(supabase));
  } catch (err) {
    if (err instanceof ParseError) return { ok: false, errors: { file: err.message } };
    return { ok: false, errors: { file: "The file could not be read." } };
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const { data: stored, error: fileError } = await supabase
    .from("uploaded_files")
    .insert({
      tenant_id: ctx.active.tenantId,
      purpose: "rate_card",
      filename: file.name.slice(0, 255),
      mime_type: (file.type || (kind === "csv" ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).slice(0, 120),
      byte_size: bytes.length,
      sha256: `\\x${sha256}`,
      content: `\\x${Buffer.from(bytes).toString("hex")}`,
    })
    .select("id")
    .single();
  if (fileError || !stored) return { ok: false, message: GENERIC_FAILURE };

  const { data: imp, error: impError } = await supabase
    .from("rate_card_imports")
    .insert({ tenant_id: ctx.active.tenantId, rate_card_id: rateCardId, file_id: stored.id, detected: { ...detection, kind, filename: file.name } })
    .select("id")
    .single();
  if (impError || !imp) return { ok: false, message: GENERIC_FAILURE };
  redirect(`/app/rate-cards/${rateCardId}/import/${imp.id}`);
}

// ---------------------------------------------------------------------------
// Import step 2: approve mapping and validate
// ---------------------------------------------------------------------------

async function loadImport(importId: string, tenantId: string) {
  const supabase = await createClient();
  const { data: imp } = await supabase.from("rate_card_imports").select("id, tenant_id, rate_card_id, file_id, status, detected, mapping, validation, version_id").eq("id", importId).maybeSingle();
  if (!imp || imp.tenant_id !== tenantId) return null;
  return { supabase, imp };
}

async function loadImportTables(supabase: Awaited<ReturnType<typeof createClient>>, fileId: string) {
  const { data: file } = await supabase.from("uploaded_files").select("filename, mime_type, content").eq("id", fileId).maybeSingle();
  if (!file) return null;
  const hex = String(file.content).replace(/^\\x/, "");
  const bytes = new Uint8Array(Buffer.from(hex, "hex"));
  const kind = detectFileKind(file.filename, file.mime_type, bytes);
  return parseTables(bytes, kind);
}

export async function saveMappingAndValidate(importId: string, mappingJson: unknown): Promise<{ ok: boolean; message?: string }> {
  const ctx = await requireTenantContext("ratecard.manage");
  if (!uuidSchema.safeParse(importId).success) return { ok: false, message: GENERIC_FAILURE };
  const parsedMapping = mappingSchema.safeParse(mappingJson);
  if (!parsedMapping.success) return { ok: false, message: `The mapping is incomplete: ${parsedMapping.error.issues[0]?.path.join(".")} ${parsedMapping.error.issues[0]?.message}` };
  const loaded = await loadImport(importId, ctx.active.tenantId);
  if (!loaded) return { ok: false, message: "Import not found." };
  const { supabase, imp } = loaded;
  if (imp.status === "imported" || imp.status === "discarded") return { ok: false, message: "This import is already finished." };

  let tables;
  try {
    tables = await loadImportTables(supabase, imp.file_id);
  } catch (err) {
    return { ok: false, message: err instanceof ParseError ? err.message : GENERIC_FAILURE };
  }
  if (!tables) return { ok: false, message: "The uploaded file is no longer available." };
  const catalog = await loadServiceCatalog(supabase);
  const result = applyMapping(tables, parsedMapping.data as RateCardMapping, catalog);
  const { error } = await supabase
    .from("rate_card_imports")
    .update({ status: result.report.ok ? "validated" : "mapped", mapping: parsedMapping.data, validation: { ...result.report, sampleRows: result.rows.slice(0, 25) } })
    .eq("id", importId);
  if (error) return { ok: false, message: GENERIC_FAILURE };
  revalidatePath(`/app/rate-cards/${imp.rate_card_id}/import/${importId}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Import step 3: create a draft version from a validated import
// ---------------------------------------------------------------------------
/** The note a term carries when no earlier version of the service had one (the label its column defaulted to before the note became staff-only). */
const DEFAULT_TERMS_SOURCE = "Carrier structural defaults (verify against the carrier service guide)";

export async function createDraftFromImport(importId: string): Promise<{ ok: boolean; message?: string; versionId?: string; carriedFromVersion?: number | null }> {
  const ctx = await requireTenantContext("ratecard.manage");
  if (!uuidSchema.safeParse(importId).success) return { ok: false, message: GENERIC_FAILURE };
  const loaded = await loadImport(importId, ctx.active.tenantId);
  if (!loaded) return { ok: false, message: "Import not found." };
  const { supabase, imp } = loaded;
  if (imp.version_id) return { ok: false, message: "This import already produced a version." };
  if (imp.status !== "validated" || !imp.mapping) return { ok: false, message: "Validate the mapping first." };

  let tables;
  try {
    tables = await loadImportTables(supabase, imp.file_id);
  } catch (err) {
    return { ok: false, message: err instanceof ParseError ? err.message : GENERIC_FAILURE };
  }
  if (!tables) return { ok: false, message: "The uploaded file is no longer available." };
  const catalog = await loadServiceCatalog(supabase);
  const result = applyMapping(tables, imp.mapping as RateCardMapping, catalog);
  if (!result.report.ok) return { ok: false, message: "The file no longer validates; review the mapping." };
  const { data: cardRow } = await supabase.from("rate_cards").select("status").eq("id", imp.rate_card_id).maybeSingle();
  if (cardRow?.status !== "active") return { ok: false, message: "This rate card is archived and cannot receive new versions." };

  const { data: latest } = await supabase.from("rate_card_versions").select("version_number").eq("rate_card_id", imp.rate_card_id).order("version_number", { ascending: false }).limit(1).maybeSingle();
  const versionNumber = (latest?.version_number ?? 0) + 1;
  const { data: version, error: vError } = await supabase
    .from("rate_card_versions")
    .insert({ rate_card_id: imp.rate_card_id, tenant_id: ctx.active.tenantId, version_number: versionNumber, source_file_id: imp.file_id, validation_summary: { rowCount: result.report.rowCount, warningCount: result.report.warningCount, services: result.report.services }, row_count: result.rows.length })
    .select("id")
    .single();
  if (vError || !version) return { ok: false, message: GENERIC_FAILURE };

  const discard = async () => {
    await supabase.rpc("archive_rate_card_version", { p_version: version.id });
  };

  // Carry forward what the file cannot express from the card's latest version that was ever
  // activated (active or archived, whatever its dates): service terms (rounding, thresholds,
  // bundled surcharges, chart key, markup) and the zone chart. Drafts and discarded versions
  // are never a source.
  const { data: previous } = await supabase
    .from("rate_card_versions")
    .select("id, version_number")
    .eq("rate_card_id", imp.rate_card_id)
    .in("status", ["active", "archived"])
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  const previousTerms = new Map<string, Record<string, unknown>>();
  // Each term's source note lives in the staff-only `rate_card_service_term_sources` (not a column of the term any more), so it is
  // carried separately: previous term id by service, then the notes by previous term id.
  const previousTermIds = new Map<string, string>();
  const previousSources = new Map<string, string>();
  if (previous) {
    const { data: prevTerms } = await supabase
      .from("rate_card_service_terms")
      .select("id, service_id, dim_divisor, dim_threshold_cubic_in, dimension_rounding, weight_rounding, min_billable_lb, dim_exempt, min_charge, included_surcharge_keys, excluded_surcharge_keys, zone_chart_key, zone_independent, surcharge_markup_percent")
      .eq("version_id", previous.id);
    for (const t of prevTerms ?? []) {
      const { id: termId, ...columns } = t as Record<string, unknown>;
      previousTerms.set(t.service_id as string, columns);
      previousTermIds.set(t.service_id as string, termId as string);
    }
    if (previousTermIds.size) {
      const { data: sources } = await supabase.from("rate_card_service_term_sources").select("term_id, source_reference").in("term_id", [...previousTermIds.values()]);
      for (const row of sources ?? []) previousSources.set(row.term_id as string, row.source_reference as string);
    }
  }

  const catalogById = new Map(catalog.map((c) => [c.id, c]));
  const termsRows = result.report.services.map((s) => {
    const carrier = catalogById.get(s.serviceId)?.carrierCode ?? "generic";
    const defaults = carrierProfile(carrier).structuralDefaults;
    const t = result.terms[s.serviceId];
    const prev = previousTerms.get(s.serviceId);
    const { service_id: _sid, dim_divisor: prevDivisor, min_charge: prevMin, ...carried } = (prev ?? {}) as Record<string, unknown>;
    // A file that states any minimum for the service (per row or per sheet) replaces the old
    // service-level minimum; only a file silent on minimums keeps it.
    const fileStatesMinimum = (t?.minCharge ?? null) !== null || result.rows.some((r) => r.serviceId === s.serviceId && r.minCharge !== null);
    return {
      version_id: version.id,
      service_id: s.serviceId,
      dim_threshold_cubic_in: defaults.thresholdCubicIn,
      dimension_rounding: defaults.dimensionRounding,
      weight_rounding: defaults.weightRounding,
      min_billable_lb: defaults.minBillableLb,
      dim_exempt: defaults.exempt,
      ...carried,
      dim_divisor: t?.dimDivisor ?? (prevDivisor as string | null | undefined) ?? null,
      min_charge: t?.minCharge ?? (fileStatesMinimum ? null : ((prevMin as string | null | undefined) ?? null)),
    };
  });
  const { data: insertedTerms, error: tError } = await supabase.from("rate_card_service_terms").insert(termsRows).select("id, service_id");
  if (tError || !insertedTerms) {
    await discard();
    return { ok: false, message: GENERIC_FAILURE };
  }
  // Every new term gets its staff-only source note: the one carried from the same service's previous term, else the standing label
  // for structural defaults the form could not state (what the term's own column defaulted to before the note moved).
  const sourceRows = insertedTerms.map((t) => ({
    term_id: t.id as string,
    tenant_id: ctx.active.tenantId,
    source_reference: previousSources.get(previousTermIds.get(t.service_id as string) ?? "") ?? DEFAULT_TERMS_SOURCE,
  }));
  const { error: sError } = await supabase.from("rate_card_service_term_sources").insert(sourceRows);
  if (sError) {
    await discard();
    return { ok: false, message: GENERIC_FAILURE };
  }

  const BATCH = 1000;
  for (let i = 0; i < result.rows.length; i += BATCH) {
    const batch = result.rows.slice(i, i + BATCH).map((r) => ({
      version_id: version.id,
      service_id: r.serviceId,
      origin_prefix: r.originPrefix,
      zone: r.zone,
      weight_min: r.weightMin,
      weight_max: r.weightMax,
      weight_unit: r.weightUnit,
      price: r.price,
      min_charge: r.minCharge,
    }));
    const { error: rError } = await supabase.from("rate_card_rows").insert(batch);
    if (rError) {
      await discard();
      if (rError.code === "23505") return { ok: false, message: "The file contains duplicate brackets for the same service and zone." };
      if (rError.code === "23P01") return { ok: false, message: "The file contains overlapping weight brackets for the same service and zone." };
      return { ok: false, message: GENERIC_FAILURE };
    }
  }

  if (previous) {
    const { data: prevZones } = await supabase.rpc("rate_card_zones_json", { p_version: previous.id });
    const zoneRows = ((prevZones ?? []) as { carrierCode: string; originPrefix: string; destPrefixFrom: string; destPrefixTo: string; zone: string; zoneChartKey: string }[]).map((z) => ({
      version_id: version.id,
      carrier_code: z.carrierCode,
      origin_prefix: z.originPrefix,
      dest_prefix_from: z.destPrefixFrom,
      dest_prefix_to: z.destPrefixTo,
      zone: z.zone,
      zone_chart_key: z.zoneChartKey ?? "default",
    }));
    for (let i = 0; i < zoneRows.length; i += 1000) {
      const { error: zError } = await supabase.from("rate_card_zones").insert(zoneRows.slice(i, i + 1000));
      if (zError) {
        await discard();
        return { ok: false, message: GENERIC_FAILURE };
      }
    }
  }

  const { data: marked, error: markError } = await supabase.from("rate_card_imports").update({ status: "imported", version_id: version.id }).eq("id", importId).select("id");
  if (markError || !marked?.length) {
    await discard();
    return { ok: false, message: GENERIC_FAILURE };
  }
  revalidatePath(`/app/rate-cards/${imp.rate_card_id}`, "layout");
  return { ok: true, versionId: version.id, carriedFromVersion: previous?.version_number ?? null };
}

/** Ends an active version on a date so a successor can be activated from the next day; history stays intact. */
export async function endVersion(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireTenantContext("ratecard.manage");
  const parsed = z.object({ versionId: uuidSchema, expirationDate: isoDate }).safeParse({ versionId: formData.get("versionId"), expirationDate: formData.get("expirationDate") });
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) };
  const supabase = await createClient();
  const { error } = await supabase.rpc("end_rate_card_version", { p_version: parsed.data.versionId, p_expiration: parsed.data.expirationDate });
  if (error) {
    if (error.message.includes("only an active")) return { ok: false, message: "Only an active version can be ended." };
    if (error.message.includes("precede")) return { ok: false, errors: { expirationDate: "The end date cannot be before the effective date." } };
    if (error.code === "23P01" || error.message.includes("already covers")) return { ok: false, errors: { expirationDate: "Another active version already covers that date; end this version before it starts." } };
    return { ok: false, message: "Version not found." };
  }
  revalidatePath("/app/rate-cards", "layout");
  return { ok: true, message: "Version ended." };
}

/**
 * Replaces a draft version's zone chart from a CSV/XLSX with columns
 * carrier, origin_prefix, dest_prefix_from, dest_prefix_to, zone (and optionally chart_key).
 */
export async function uploadZoneChart(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const ctx = await requireTenantContext("ratecard.manage");
  const versionId = String(formData.get("versionId") ?? "");
  const file = formData.get("file");
  if (!uuidSchema.safeParse(versionId).success) return { ok: false, message: GENERIC_FAILURE };
  if (!(file instanceof File) || file.size === 0) return { ok: false, errors: { file: "Choose a .csv or .xlsx zone chart." } };
  if (file.size > LIMITS.maxBytes) return { ok: false, errors: { file: "Files must be 5 MB or smaller." } };

  const supabase = await createClient();
  if (!(await withinRateLimit(supabase, "ratecard.upload", 30, 3600))) return { ok: false, message: RATE_LIMITED_MESSAGE };
  const { data: version } = await supabase.from("rate_card_versions").select("id, tenant_id, status").eq("id", versionId).maybeSingle();
  if (!version || version.tenant_id !== ctx.active.tenantId) return { ok: false, message: "Version not found." };
  if (version.status !== "draft") return { ok: false, message: "Only a draft version's zone chart can be changed." };

  let tables;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    tables = await parseTables(bytes, detectFileKind(file.name, file.type, bytes));
  } catch (err) {
    return { ok: false, errors: { file: err instanceof ParseError ? err.message : "The file could not be read." } };
  }
  const { data: carriers } = await supabase.from("carriers").select("code, name");
  const carrierByName = new Map<string, string>();
  for (const c of carriers ?? []) {
    carrierByName.set(String(c.code).toLowerCase(), c.code);
    carrierByName.set(String(c.name).toLowerCase(), c.code);
  }
  const parsed = parseZoneChart(tables, carrierByName);
  if (!parsed.ok) return { ok: false, errors: { file: parsed.message } };

  // One transaction: a rejected row leaves the previous chart untouched.
  const { data: inserted, error } = await supabase.rpc("replace_rate_card_zones", { p_version: versionId, p_rows: parsed.rows });
  if (error) {
    if (error.message.includes("rate_card_zones_no_overlap")) return { ok: false, errors: { file: "Two destination ranges overlap for the same carrier, origin and chart. Nothing was changed; fix the chart and upload again." } };
    if (error.message.includes("not a draft")) return { ok: false, message: "Only a draft version's zone chart can be changed." };
    return { ok: false, message: GENERIC_FAILURE };
  }
  revalidatePath("/app/rate-cards", "layout");
  return { ok: true, message: `Zone chart replaced: ${inserted ?? parsed.rows.length} rows.` };
}

interface ZoneChartRow {
  carrier_code: string;
  origin_prefix: string;
  dest_prefix_from: string;
  dest_prefix_to: string;
  zone: string;
  zone_chart_key: string;
}

function parseZoneChart(tables: { name: string; rows: string[][] }[], carrierByName: Map<string, string>): { ok: true; rows: ZoneChartRow[] } | { ok: false; message: string } {
  const table = tables[0];
  if (!table || table.rows.length < 2) return { ok: false, message: "The zone chart has no rows." };
  const headers = table.rows[0]!.map((h) => h.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""));
  const col = (...names: string[]) => headers.findIndex((h) => names.includes(h));
  const cCarrier = col("carrier", "carrier_code");
  const cOrigin = col("origin_prefix", "origin", "origin_zip", "origin_zip_prefix");
  const cFrom = col("dest_prefix_from", "destination_from", "dest_from", "from", "zip_from");
  const cTo = col("dest_prefix_to", "destination_to", "dest_to", "to", "zip_to");
  const cZone = col("zone");
  const cKey = col("chart_key", "zone_chart_key", "chart");
  if ([cCarrier, cOrigin, cFrom, cTo, cZone].some((i) => i === -1)) {
    return { ok: false, message: "Expected columns: carrier, origin_prefix, dest_prefix_from, dest_prefix_to, zone (optional chart_key)." };
  }
  const rows: ZoneChartRow[] = [];
  const seen = new Map<string, { zone: string; row: number }>();
  for (let i = 1; i < table.rows.length; i++) {
    const r = table.rows[i]!;
    if (r.every((c) => c === "")) continue;
    const carrier = carrierByName.get((r[cCarrier] ?? "").trim().toLowerCase());
    const origin = (r[cOrigin] ?? "").trim();
    const from = (r[cFrom] ?? "").trim();
    const to = (r[cTo] ?? "").trim();
    const zone = (r[cZone] ?? "").trim().toUpperCase().replace(/^ZONE\s*/, "");
    const key = cKey === -1 ? "default" : (r[cKey] ?? "").trim().toLowerCase() || "default";
    if (!carrier) return { ok: false, message: `Row ${i + 1}: unknown carrier "${r[cCarrier] ?? ""}".` };
    if (!/^\d{3}$|^\d{5}$/.test(origin)) return { ok: false, message: `Row ${i + 1}: origin prefix must be 3 or 5 digits.` };
    if (!/^\d{3}$|^\d{5}$/.test(from) || !/^\d{3}$|^\d{5}$/.test(to) || from.length !== to.length || from > to) return { ok: false, message: `Row ${i + 1}: destination range ${from}–${to} is not valid (same length, from ≤ to).` };
    if (!/^[A-Z0-9]{1,12}$/.test(zone)) return { ok: false, message: `Row ${i + 1}: zone "${zone}" is not valid.` };
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(key)) return { ok: false, message: `Row ${i + 1}: chart key "${key}" is not valid.` };
    const dedupe = `${carrier}|${key}|${origin}|${from}|${to}`;
    const earlier = seen.get(dedupe);
    if (earlier) {
      if (earlier.zone === zone) continue; // exact duplicate
      return { ok: false, message: `Row ${i + 1}: ${carrier} ${origin} → ${from}–${to} is zone ${zone} here but zone ${earlier.zone} on row ${earlier.row}. The chart contradicts itself; fix it and upload again.` };
    }
    seen.set(dedupe, { zone, row: i + 1 });
    rows.push({ carrier_code: carrier, origin_prefix: origin, dest_prefix_from: from, dest_prefix_to: to, zone, zone_chart_key: key });
  }
  if (!rows.length) return { ok: false, message: "No zone rows were found." };
  if (rows.length > 50_000) return { ok: false, message: "Zone charts are limited to 50,000 rows." };
  return { ok: true, rows };
}

export async function discardImport(importId: string): Promise<{ ok: boolean; message?: string }> {
  const ctx = await requireTenantContext("ratecard.manage");
  if (!uuidSchema.safeParse(importId).success) return { ok: false, message: GENERIC_FAILURE };
  const loaded = await loadImport(importId, ctx.active.tenantId);
  if (!loaded) return { ok: false, message: "Import not found." };
  const { supabase, imp } = loaded;
  if (imp.status === "imported") return { ok: false, message: "This import already produced a version." };
  await supabase.from("rate_card_imports").update({ status: "discarded" }).eq("id", importId);
  revalidatePath(`/app/rate-cards/${imp.rate_card_id}`, "layout");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Versions: terms, activation, archiving
// ---------------------------------------------------------------------------
const termsSchema = z.object({
  versionId: uuidSchema,
  serviceId: uuidSchema,
  dimDivisor: z.preprocess((v) => (v === "" ? null : v), z.string().regex(/^\d+(\.\d+)?$/, "Enter a number.").nullable()),
  dimThresholdCubicIn: z.preprocess((v) => (v === "" ? null : v), z.string().regex(/^\d+(\.\d+)?$/, "Enter a number.").nullable()),
  dimensionRounding: z.enum(["none", "nearest_whole", "up_whole"]),
  weightRounding: z.enum(["none", "up_whole_lb", "up_whole_oz", "postal"]),
  minBillableLb: z.preprocess((v) => (v === "" ? null : v), z.string().regex(/^\d+(\.\d+)?$/, "Enter a number.").nullable()),
  dimExempt: z.boolean(),
  minCharge: z.preprocess((v) => (v === "" ? null : v), z.string().regex(/^\d+(\.\d+)?$/, "Enter an amount.").nullable()),
  includedSurchargeKeys: z.array(z.string().regex(/^[a-z][a-z0-9_.]{1,80}$/)).max(50),
  excludedSurchargeKeys: z.array(z.string().regex(/^[a-z][a-z0-9_.]{1,80}$/)).max(50),
  zoneChartKey: z.preprocess((v) => (v === "" || v === null || v === undefined ? "default" : String(v).trim().toLowerCase()), z.string().regex(/^[a-z][a-z0-9_]{0,40}$/, "Use lowercase letters, digits and underscores.")),
  zoneIndependent: z.boolean(),
  surchargeMarkupPercent: z.preprocess((v) => (v === "" || v === null || v === undefined ? null : v), z.string().regex(/^-?\d+(\.\d+)?$/, "Enter a percentage.").refine((v) => Number(v) >= -100, "Cannot be below -100.").nullable()),
});

export async function updateServiceTerms(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireTenantContext("ratecard.manage");
  const keys = (name: string) => String(formData.get(name) ?? "").split(/[\s,]+/).map((k) => k.trim()).filter(Boolean);
  const parsed = termsSchema.safeParse({
    versionId: formData.get("versionId"),
    serviceId: formData.get("serviceId"),
    dimDivisor: formData.get("dimDivisor"),
    dimThresholdCubicIn: formData.get("dimThresholdCubicIn"),
    dimensionRounding: formData.get("dimensionRounding"),
    weightRounding: formData.get("weightRounding"),
    minBillableLb: formData.get("minBillableLb"),
    dimExempt: formData.get("dimExempt") === "on",
    minCharge: formData.get("minCharge"),
    includedSurchargeKeys: keys("includedSurchargeKeys"),
    excludedSurchargeKeys: keys("excludedSurchargeKeys"),
    zoneChartKey: formData.get("zoneChartKey"),
    zoneIndependent: formData.get("zoneIndependent") === "on",
    surchargeMarkupPercent: formData.get("surchargeMarkupPercent"),
  });
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) };
  const t = parsed.data;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("rate_card_service_terms")
    .update({
      dim_divisor: t.dimDivisor,
      dim_threshold_cubic_in: t.dimThresholdCubicIn,
      dimension_rounding: t.dimensionRounding,
      weight_rounding: t.weightRounding,
      min_billable_lb: t.minBillableLb,
      dim_exempt: t.dimExempt,
      min_charge: t.minCharge,
      included_surcharge_keys: t.includedSurchargeKeys,
      excluded_surcharge_keys: t.excludedSurchargeKeys,
      zone_chart_key: t.zoneChartKey,
      zone_independent: t.zoneIndependent,
      surcharge_markup_percent: t.surchargeMarkupPercent,
    })
    .eq("version_id", t.versionId)
    .eq("service_id", t.serviceId)
    .select("id");
  if (error) return { ok: false, message: error.message.includes("not a draft") ? "Only draft versions can be edited." : GENERIC_FAILURE };
  if (!data?.length) return { ok: false, message: "Only draft versions can be edited." };
  revalidatePath("/app/rate-cards", "layout");
  return { ok: true, message: "Saved." };
}

export async function activateVersion(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireTenantContext("ratecard.manage");
  const parsed = z
    .object({ versionId: uuidSchema, effectiveDate: isoDate, expirationDate: z.preprocess((v) => (v === "" ? null : v), isoDate.nullable()) })
    .safeParse({ versionId: formData.get("versionId"), effectiveDate: formData.get("effectiveDate"), expirationDate: formData.get("expirationDate") });
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) };
  const supabase = await createClient();
  const { error } = await supabase.rpc("activate_rate_card_version", { p_version: parsed.data.versionId, p_effective: parsed.data.effectiveDate, p_expiration: parsed.data.expirationDate });
  if (error) {
    const m = error.message;
    if (m.includes("already covers")) return { ok: false, errors: { effectiveDate: "Another active version already covers these dates. Archive it or choose different dates." } };
    if (m.includes("needs service terms")) return { ok: false, message: "Every service on the card needs service terms before activation." };
    if (m.includes("no rate rows")) return { ok: false, message: "This version has no rate rows." };
    if (m.includes("only a draft")) return { ok: false, message: "Only a draft version can be activated." };
    if (m.includes("expiration")) return { ok: false, errors: { expirationDate: "Expiration must not precede the effective date." } };
    return { ok: false, message: GENERIC_FAILURE };
  }
  revalidatePath("/app/rate-cards", "layout");
  return { ok: true, message: "Version activated." };
}

export async function archiveVersion(versionId: string): Promise<{ ok: boolean; message?: string }> {
  await requireTenantContext("ratecard.manage");
  if (!uuidSchema.safeParse(versionId).success) return { ok: false, message: GENERIC_FAILURE };
  const supabase = await createClient();
  const { error } = await supabase.rpc("archive_rate_card_version", { p_version: versionId });
  if (error) return { ok: false, message: error.message.includes("already closed") ? "This version is already closed." : "Version not found." };
  revalidatePath("/app/rate-cards", "layout");
  return { ok: true };
}

export async function archiveRateCard(rateCardId: string): Promise<{ ok: boolean; message?: string }> {
  const ctx = await requireTenantContext("ratecard.manage");
  if (!uuidSchema.safeParse(rateCardId).success) return { ok: false, message: GENERIC_FAILURE };
  const supabase = await createClient();
  const { data, error } = await supabase.from("rate_cards").update({ status: "archived" }).eq("id", rateCardId).eq("tenant_id", ctx.active.tenantId).select("id");
  if (error || !data?.length) return { ok: false, message: "Rate card not found." };
  revalidatePath("/app/rate-cards", "layout");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Brand assignments
// ---------------------------------------------------------------------------
export async function assignRateCard(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const ctx = await requireTenantContext("ratecard.manage");
  const parsed = z.object({ brandId: uuidSchema, rateCardId: uuidSchema, allowedServiceIds: z.array(uuidSchema).max(100) }).safeParse({
    brandId: formData.get("brandId"),
    rateCardId: formData.get("rateCardId"),
    allowedServiceIds: formData.getAll("allowedServiceIds").map(String).filter(Boolean),
  });
  if (!parsed.success) return { ok: false, message: "Choose a rate card." };
  const supabase = await createClient();
  const { data: card } = await supabase.from("rate_cards").select("id, tenant_id, status").eq("id", parsed.data.rateCardId).maybeSingle();
  if (!card || card.tenant_id !== ctx.active.tenantId) return { ok: false, message: "Rate card not found." };
  if (card.status !== "active") return { ok: false, message: "An archived rate card cannot be assigned." };
  const { error } = await supabase.from("brand_rate_card_assignments").insert({
    tenant_id: ctx.active.tenantId,
    brand_id: parsed.data.brandId,
    rate_card_id: parsed.data.rateCardId,
    allowed_service_ids: parsed.data.allowedServiceIds.length ? parsed.data.allowedServiceIds : null,
  });
  if (error) {
    if (error.code === "23505") return { ok: false, message: "This rate card is already assigned to the customer." };
    return { ok: false, message: GENERIC_FAILURE };
  }
  revalidatePath(`/app/customers/${parsed.data.brandId}`);
  revalidatePath("/app/rate-cards", "layout");
  return { ok: true, message: "Rate card assigned." };
}

export async function unassignRateCard(assignmentId: string): Promise<{ ok: boolean; message?: string }> {
  const ctx = await requireTenantContext("ratecard.manage");
  if (!uuidSchema.safeParse(assignmentId).success) return { ok: false, message: GENERIC_FAILURE };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("brand_rate_card_assignments")
    .update({ unassigned_at: new Date().toISOString(), unassigned_by: ctx.user.id })
    .eq("id", assignmentId)
    .eq("tenant_id", ctx.active.tenantId)
    .is("unassigned_at", null)
    .select("id, brand_id");
  if (error || !data?.length) return { ok: false, message: "Assignment not found." };
  revalidatePath(`/app/customers/${data[0]!.brand_id}`);
  revalidatePath("/app/rate-cards", "layout");
  return { ok: true };
}
