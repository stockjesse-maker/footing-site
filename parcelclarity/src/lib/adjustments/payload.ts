import type { AdjustmentImportResult, AdjustmentRecord, AppendChunk, AppendRow } from "./types";

/**
 * Turns validated records into the row chunks `public.append_adjustment_records(p_import, p_from_row, p_rows)` accepts.
 * Rows are numbered densely over the whole import (1..accepted, in file order) because the database cursor is "rows
 * stored or skipped so far": a chunk starts at `fromRow`, holds at most 2,000 rows, and a retried chunk is acknowledged
 * by the database rather than repeated. Every key the database knows is present, unknown values are null and never 0.
 */

/** The database accepts 1 to 2,000 rows per call. */
export const APPEND_CHUNK_ROWS = 2000;

export function toAppendRow(r: AdjustmentRecord): AppendRow {
  return {
    ship_date: r.shipDate,
    adjusted_on: r.adjustedOn,
    carrier_code: r.carrierCode,
    service_id: r.serviceId,
    service_text: r.serviceText,
    brand_id: r.brandId,
    adjustment_type: r.adjustmentType,
    cause: r.cause,
    reason_text: r.reasonText,
    package_ref: r.packageRef,
    declared_weight_lb: r.declaredWeightLb,
    declared_weight_basis: r.declaredWeightBasis,
    actual_weight_lb: r.actualWeightLb,
    orig_length_in: r.original?.length ?? null,
    orig_width_in: r.original?.width ?? null,
    orig_height_in: r.original?.height ?? null,
    corr_length_in: r.corrected?.length ?? null,
    corr_width_in: r.corrected?.width ?? null,
    corr_height_in: r.corrected?.height ?? null,
    original_charge: r.originalCharge,
    corrected_charge: r.correctedCharge,
    separate_fee: r.separateFee,
    handling_recorded: r.handlingRecorded,
  };
}

export class ChunkError extends Error {}

/**
 * Chunks a committable import result. Refuses (throws) a result that is not committable or whose record count disagrees with
 * the report's accepted count, so a commit can never send a different number of rows than the 3PL saw and attested to.
 */
export function buildAppendChunks(result: AdjustmentImportResult, chunkSize: number = APPEND_CHUNK_ROWS): { chunks: AppendChunk[]; accepted: number } {
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > APPEND_CHUNK_ROWS) throw new ChunkError(`A chunk holds between 1 and ${APPEND_CHUNK_ROWS} rows.`);
  const { records, report } = result;
  if (!report.ok || !report.committable) throw new ChunkError("The file still has rows that must be fixed; nothing is sent until every row is valid.");
  if (records.length !== report.counts.accepted || records.length < 1) throw new ChunkError("The rows to send do not match the validated count.");
  const chunks: AppendChunk[] = [];
  for (let i = 0; i < records.length; i += chunkSize) chunks.push({ fromRow: i + 1, rows: records.slice(i, i + chunkSize).map(toAppendRow) });
  return { chunks, accepted: records.length };
}

/** What `append_adjustment_records` returns (a replayed chunk reports the totals as `committed` and `skipped`). */
export interface AppendResult {
  applied?: boolean;
  inserted?: number;
  skipped?: number;
  nextRow?: number;
  committed?: number;
  skippedTotal?: number;
}

/**
 * Reconciles the database's totals after the last chunk with the validated count: stored plus skipped (already imported
 * earlier) must equal the accepted count exactly. Only then may the import be finalised.
 */
export function reconcileCommit(accepted: number, last: AppendResult | null): { ok: boolean; committed: number; skipped: number; message: string } {
  const committed = last?.committed ?? 0;
  const skipped = last?.skippedTotal ?? last?.skipped ?? 0;
  const ok = committed + skipped === accepted && accepted > 0;
  const message = ok
    ? skipped > 0
      ? `${committed.toLocaleString("en-US")} ${committed === 1 ? "row was" : "rows were"} added; ${skipped.toLocaleString("en-US")} ${skipped === 1 ? "was" : "were"} already imported and skipped.`
      : `${committed.toLocaleString("en-US")} ${committed === 1 ? "row was" : "rows were"} added.`
    : "The rows stored do not match the rows checked, so the import was not finished. Start the import again from the beginning.";
  return { ok, committed, skipped, message };
}

/** The chunks still to send when the database cursor stands at `nextRow` (chunks it already applied are acknowledged, not repeated, but need not be sent). */
export function remainingChunks(chunks: AppendChunk[], nextRow: number): AppendChunk[] {
  return chunks.filter((c) => c.fromRow + c.rows.length > nextRow);
}
