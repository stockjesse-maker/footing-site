import type { AdjustmentField, MoneyField } from "./types";

export type PlainField = Exclude<AdjustmentField, MoneyField>;

/**
 * Header synonyms per field, normalised (lower case, non-alphanumerics to spaces; see header-text.ts). Exact matches only: a column is
 * never guessed from a fragment. The header row of a sheet is the first row that holds a ship date synonym and a carrier, service or
 * adjustment type synonym (sheet.ts), so this list also decides what a "file with column names" is.
 */
export const SYNONYMS: Record<PlainField, string[]> = {
  shipDate: ["ship date", "shipped date", "shipped on", "date shipped", "shipment date", "shipped at", "ship dt"],
  adjustedOn: ["adjusted on", "adjustment date", "date adjusted", "adjusted date", "adjusted at", "adjustment posted", "adjustment posted date", "posted date", "correction date", "reweigh date"],
  carrier: ["carrier", "courier", "shipper", "shipping company"],
  service: ["service", "service name", "service level", "shipping method", "ship method", "shipping service", "method", "service type", "ship via"],
  brand: ["brand", "customer", "customer name", "client", "client name", "account", "account name", "merchant", "merchant name", "company"],
  adjustmentType: ["adjustment type", "type", "correction type", "adjustment kind", "adjustment category", "kind"],
  cause: ["cause", "root cause", "adjustment cause", "cause code"],
  reason: ["reason", "adjustment reason", "reason code", "reason for adjustment", "reweigh reason", "adjustment reason code"],
  packageRef: ["package ref", "package reference", "package id", "package number", "tracking number", "tracking no", "tracking id", "tracking", "parcel id", "parcel number", "pro number"],
  declaredWeight: ["declared weight", "original weight", "shipped weight", "entered weight", "weight declared", "declared wt"],
  actualWeight: ["actual weight", "corrected weight", "adjusted weight", "measured weight", "new weight", "reweigh weight", "weight actual"],
  weightUnit: ["weight unit", "weight units", "weight uom", "unit of weight"],
  originalLength: ["original length", "orig length", "declared length", "entered length", "length declared"],
  originalWidth: ["original width", "orig width", "declared width", "entered width", "width declared"],
  originalHeight: ["original height", "orig height", "declared height", "entered height", "height declared"],
  correctedLength: ["corrected length", "adjusted length", "new length", "actual length", "remeasured length"],
  correctedWidth: ["corrected width", "adjusted width", "new width", "actual width", "remeasured width"],
  correctedHeight: ["corrected height", "adjusted height", "new height", "actual height", "remeasured height"],
  dimensionUnit: ["dimension unit", "dimensions unit", "dim unit", "dimension uom", "unit of dimension"],
  handling: ["handling", "handling recorded", "who paid", "absorbed"],
};

/** True when a normalised header is one of the synonyms of the field. */
export const isSynonymOf = (field: PlainField, normalized: string): boolean => SYNONYMS[field].includes(normalized);
