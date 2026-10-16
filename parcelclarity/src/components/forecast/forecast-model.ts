import { FORECAST_LIMITS, type ForecastAssumptions, type ForecastFulfillment, type ForecastGridCounts, type ForecastParcel, type ForecastService, type ForecastZone } from "@/engine/forecast/types";
import { describeGridProduct, validateForecastAssumptions } from "@/engine/forecast/grid";
import type { DriverQuestion } from "@/lib/fees/queries";
import { fulfillmentFromState, initialFulfillmentState, newContentRow, type ContentRowState, type FulfillmentFormContext, type FulfillmentFormState } from "@/lib/modeling/assumptions";

/**
 * The pure model behind the "Forecast from your assumptions" form (Milestone 4, design §7): form
 * state, the context the server loads for it (services, zones, fee schedule questions), the rules
 * that turn state into `ForecastAssumptions`, and the share arithmetic ("spread evenly", "sums to X%").
 *
 * Pure: no I/O, no framework imports; importable from the client form, the server actions' callers and
 * the tests. Nothing here prices anything or invents a number: a blank field is an error the person
 * fixes, never a default. Shares are carried as text and summed as whole hundredths of a percent, so
 * "sums to 100.00%" is an exact check and "spread evenly" always totals exactly 100.00.
 */

// ---------------------------------------------------------------------------
// The context the server loads for the form (re-loaded when the date, origin or rate card changes)
// ---------------------------------------------------------------------------
export interface ForecastServiceOption {
  serviceId: string;
  carrierCode: string;
  serviceCode: string;
  name: string;
  /** Priced without zones: its rate rows carry "ALL". */
  zoneIndependent: boolean;
  /** The service does not bill dimensional weight, so a parcel needs no dimensions for it. */
  dimExempt: boolean;
  /** The zones the rate card prices for this service from the origin ("ALL" for zone-independent services). */
  zones: string[];
}

export interface ForecastPackagingOption {
  value: string;
  label: string;
}

export type ForecastScheduleContext =
  /** The brand has no fee schedule: the forecast covers shipping only. */
  | { status: "none" }
  /** The brand is on a schedule but none of its versions is in effect on the date. */
  | { status: "not_effective"; name: string }
  /** The schedule could not be read; the forecast is not run on a guess. */
  | { status: "unavailable" }
  | {
      status: "ok";
      name: string;
      effectiveDate: string;
      questions: DriverQuestion[];
      /** Packaging types the schedule prices, and whether a catch-all prices the rest. */
      packaging: ForecastPackagingOption[];
      allowOtherPackaging: boolean;
      /** A rule reads items, lines or products per order: the form asks what a typical order holds. */
      readsOrderContent: boolean;
    };

export interface ForecastContext {
  status: "ok";
  asOfDate: string;
  /** The ship-from ZIP the context was loaded for ("" when none is known). */
  originZip: string;
  rateCard: { id: string; name: string; effectiveDate: string; expirationDate: string | null };
  cards: { id: string; name: string }[];
  services: ForecastServiceOption[];
  schedule: ForecastScheduleContext;
  /** Customer-safe notes about the origin or the rate card (never blocking). */
  warnings: string[];
}

export type ForecastContextResult =
  | ForecastContext
  | { status: "no_card" }
  | { status: "no_rates"; cards: { id: string; name: string }[]; message: string }
  | { status: "failed"; message: string };

/** The packaging "leave it out" choice: the parcel carries no packaging type and packaging fees are not computed for it. */
export const PACKAGING_LEAVE_OUT = "";

// ---------------------------------------------------------------------------
// Shares: exact arithmetic in hundredths of a percent
// ---------------------------------------------------------------------------
const SHARE_TEXT = /^\d{1,3}(\.\d{1,2})?$/;

function hundredthsOf(text: string): number | null {
  const t = text.trim();
  if (!SHARE_TEXT.test(t)) return null;
  const [whole = "0", frac = ""] = t.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

function hundredthsText(n: number): string {
  return `${Math.floor(n / 100)}.${String(n % 100).padStart(2, "0")}`;
}

/**
 * `count` shares that add up to exactly 100.00: every row gets the same share rounded down to a
 * hundredth and the leftover hundredths go one each to the first rows (3 rows: 33.34, 33.33, 33.33;
 * 7 rows: 14.29 four times and 14.28 three times).
 */
export function spreadEvenly(count: number): string[] {
  if (!Number.isInteger(count) || count < 1) return [];
  const total = 10_000;
  const base = Math.floor(total / count);
  const extra = total - base * count;
  return Array.from({ length: count }, (_, i) => hundredthsText(base + (i < extra ? 1 : 0)));
}

/** The exact total of the shares as text ("100.00"), or null when any share is blank or not a percentage with up to 2 decimals. */
export function sumShares(shares: string[]): string | null {
  let total = 0;
  for (const s of shares) {
    const n = hundredthsOf(s);
    if (n === null) return null;
    total += n;
  }
  return hundredthsText(total);
}

/** The live "sums to X%" sentence of a distribution; `exact` is true only for 100.00. Never colour-only: the words carry the state. */
export function describeShareSum(shares: string[]): { text: string; exact: boolean } {
  const total = sumShares(shares);
  if (total === null) return { text: "Enter a share for every row. Shares must add up to exactly 100.00%.", exact: false };
  if (total === "100.00") return { text: "Shares add up to 100.00%.", exact: true };
  return { text: `Shares add up to ${total}%; they must add up to exactly 100.00%.`, exact: false };
}

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------
export interface ParcelState {
  weightLb: string;
  lengthIn: string;
  widthIn: string;
  heightIn: string;
  /** A packaging type the schedule prices, or "" = leave packaging fees out for this parcel. */
  packaging: string;
  sharePct: string;
  unknownSize: boolean;
}

export interface ZoneState {
  zone: string;
  sharePct: string;
}

export interface ServiceState {
  serviceId: string;
  sharePct: string;
}

export interface ForecastFormState {
  monthlyOrders: string;
  /** null = today (the browser's local date). */
  asOfDate: string | null;
  originZip: string;
  rateCardId: string;
  parcels: ParcelState[];
  zones: ZoneState[];
  services: ServiceState[];
  residentialPct: string;
  multiPct: string;
  packagesPerOrder: string;
  contentMode: "rows" | "average";
  contentRows: ContentRowState[];
  averageUnits: string;
  averageLines: string;
  fulfillment: FulfillmentFormState;
  priceOnlyCovered: boolean;
}

export const emptyParcel = (sharePct = ""): ParcelState => ({ weightLb: "", lengthIn: "", widthIn: "", heightIn: "", packaging: PACKAGING_LEAVE_OUT, sharePct, unknownSize: false });

/** The questions of a fee schedule as `fulfillmentFromState` needs them (volume and order content are asked elsewhere in a forecast). */
export function fulfillmentContext(ctx: ForecastContext): FulfillmentFormContext {
  return { questions: ctx.schedule.status === "ok" ? ctx.schedule.questions : [], canDeriveVolume: false, showPackaging: false, showContent: false };
}

/** True when the form asks what a typical order holds: a fee rule reads it and fulfillment costs are not skipped. */
export function asksOrderContent(ctx: ForecastContext, skip: boolean): boolean {
  return ctx.schedule.status === "ok" && ctx.schedule.readsOrderContent && !skip;
}

/** Zones to choose from for the services picked so far (all services while none is picked), and whether the zone section is hidden. */
export function availableZones(services: ForecastServiceOption[], selectedIds: string[]): { zones: string[]; hidden: boolean } {
  const picked = services.filter((s) => selectedIds.includes(s.serviceId));
  const considered = picked.length ? picked : services;
  const hidden = picked.length > 0 && picked.every((s) => s.zoneIndependent);
  const zones = new Set<string>();
  for (const s of considered) if (!s.zoneIndependent) for (const z of s.zones) zones.add(z);
  return { zones: [...zones].sort(compareZoneText), hidden };
}

function compareZoneText(a: string, b: string): number {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) return Number(a) - Number(b);
  if (na !== nb) return na ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The state the form opens with. A saved forecast (edit as new) fills every field it can; what the
 * current rate card or fee schedule no longer offers is left blank for the person to choose again,
 * never silently replaced. The as-of date always starts as today. Nothing is prefilled that the person
 * has not said, except "no multi-package orders" (every order ships as one package, stated on screen).
 */
export function initialFormState(ctx: ForecastContext, initial?: ForecastAssumptions | null): ForecastFormState {
  const only = ctx.services.length === 1 ? ctx.services[0]!.serviceId : "";
  const content = initial?.content;
  const rows = content && "rows" in content ? content.rows : null;
  const prevFulfillment = initial?.fulfillment;
  const zoneIds = new Set(ctx.services.flatMap((s) => s.zones));
  const services = initial ? initial.services.map((s) => ({ serviceId: ctx.services.some((o) => o.serviceId === s.serviceId) ? s.serviceId : "", sharePct: s.sharePct })) : [];
  const zones = initial ? initial.zones.filter((z) => z.zone !== "ALL").map((z) => ({ zone: zoneIds.has(z.zone) ? z.zone : "", sharePct: z.sharePct })) : [];
  return {
    monthlyOrders: initial?.monthlyOrders ?? "",
    asOfDate: null,
    originZip: initial?.originZip ?? ctx.originZip,
    rateCardId: ctx.rateCard.id,
    parcels: initial
      ? initial.parcels.map((p) => ({ weightLb: p.weightLb, lengthIn: p.lengthIn ?? "", widthIn: p.widthIn ?? "", heightIn: p.heightIn ?? "", packaging: p.packagingType ?? PACKAGING_LEAVE_OUT, sharePct: p.sharePct, unknownSize: p.unknownSize === true }))
      : [emptyParcel("100.00")],
    zones: zones.length ? zones : [{ zone: "", sharePct: "100.00" }],
    services: services.length ? services : [{ serviceId: only, sharePct: "100.00" }],
    residentialPct: initial?.residentialPct ?? "",
    multiPct: initial?.multiPackage.pct ?? "0",
    packagesPerOrder: String(initial?.multiPackage.packagesPerOrder ?? 2),
    contentMode: content && "averageUnits" in content ? "average" : "rows",
    contentRows: rows ? rows.map((r) => ({ units: String(r.units), lines: String(r.lines), sharePct: r.sharePct })) : [{ ...newContentRow(), sharePct: "100.00" }],
    averageUnits: content && "averageUnits" in content ? content.averageUnits : "",
    averageLines: content && "averageLines" in content ? content.averageLines : "",
    fulfillment: initialFulfillmentState(fulfillmentContext(ctx), prevFulfillment ? { skip: prevFulfillment.skip === true, drivers: prevFulfillment.drivers, orderShares: prevFulfillment.orderShares } : null),
    priceOnlyCovered: false,
  };
}

/**
 * Keeps the form consistent with a freshly loaded context: a service the new date's rate card does not
 * offer and a zone it does not price become blank rows (the person chooses again); a question new to
 * the fee schedule gets an unanswered state, an existing answer is kept.
 */
export function reconcileState(state: ForecastFormState, ctx: ForecastContext): ForecastFormState {
  const serviceIds = new Set(ctx.services.map((s) => s.serviceId));
  const services = state.services.map((s) => (s.serviceId === "" || serviceIds.has(s.serviceId) ? s : { ...s, serviceId: "" }));
  const zoneIds = new Set(availableZones(ctx.services, services.map((s) => s.serviceId)).zones);
  const zones = state.zones.map((z) => (z.zone === "" || zoneIds.has(z.zone) ? z : { ...z, zone: "" }));
  const fresh = initialFulfillmentState(fulfillmentContext(ctx), null);
  const drivers = { ...fresh.drivers };
  const shares = { ...fresh.shares };
  for (const key of Object.keys(drivers)) if (state.fulfillment.drivers[key]) drivers[key] = state.fulfillment.drivers[key]!;
  for (const key of Object.keys(shares)) if (state.fulfillment.shares[key]) shares[key] = state.fulfillment.shares[key]!;
  return { ...state, services, zones, fulfillment: { ...state.fulfillment, drivers, shares } };
}

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------
function lenientSplits(text: string): number {
  const t = text.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return 2;
  const n = Number(t);
  return n === 0 || n === 100 ? 1 : 2;
}

/** "3 parcels × 2 zones × 1 service × 2 residential splits × 1 package class = 12 cells", with whether it is over the limit. */
export function preflight(state: ForecastFormState, ctx: ForecastContext): { counts: ForecastGridCounts; sentence: string; overLimit: boolean } {
  const zoneHidden = availableZones(ctx.services, state.services.map((s) => s.serviceId)).hidden;
  const parcels = Math.max(1, state.parcels.length);
  const zones = zoneHidden ? 1 : Math.max(1, state.zones.length);
  const services = Math.max(1, state.services.length);
  const residentialSplits = lenientSplits(state.residentialPct);
  const packageClasses = lenientSplits(state.multiPct);
  const counts: ForecastGridCounts = { parcels, zones, services, residentialSplits, packageClasses, cells: parcels * zones * services * residentialSplits * packageClasses };
  // The engine's own wording for the product, so the pre-flight and the engine's limit message read alike.
  return { counts, sentence: describeGridProduct(counts), overLimit: counts.cells > FORECAST_LIMITS.cells };
}

// ---------------------------------------------------------------------------
// Problems → field errors
// ---------------------------------------------------------------------------
const LABELS: Record<string, string> = {
  monthlyOrders: "Orders a month",
  asOfDate: "The date",
  originZip: "Ship-from ZIP",
  weightLb: "Weight",
  lengthIn: "Length",
  widthIn: "Width",
  heightIn: "Height",
  sharePct: "Share",
  zone: "Zone",
  serviceId: "Service",
  residentialPct: "Residential share",
  pct: "Multi-package share",
  packagesPerOrder: "Packages per order",
  units: "Items",
  lines: "Lines",
  averageUnits: "Average items",
  averageLines: "Average lines",
  packagingType: "Packaging",
};

function sentence(text: string): string {
  const t = text.trim();
  const cap = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(cap) ? cap : `${cap}.`;
}

/**
 * The engine's problems ("parcels.0.weightLb: must be a number with up to 4 decimals", "zones: shares
 * add up to 90.00%, not 100.00%") as field errors keyed by control ("parcels.0.weightLb", "zones",
 * "parcels.1.dims", …) and general sentences for the rest. Keys, ids and codes never appear in the text.
 */
export function fieldErrorsFromProblems(problems: string[]): { fields: Record<string, string>; general: string[] } {
  const fields: Record<string, string> = {};
  const general: string[] = [];
  for (const problem of problems) {
    const m = /^([A-Za-z0-9_.]+): (.*)$/.exec(problem);
    if (!m || m[1] === "assumptions") {
      general.push(sentence(m ? m[2]! : problem));
      continue;
    }
    const path = m[1]!;
    const message = m[2]!;
    const segments = path.split(".");
    const last = segments[segments.length - 1]!;
    const key = ["lengthIn", "widthIn", "heightIn"].includes(last) && segments[0] === "parcels" ? `parcels.${segments[1]}.dims` : path;
    if (key in fields) continue;
    const label = LABELS[last];
    fields[key] = label && message.startsWith("must") ? sentence(`${label} ${message}`) : sentence(message);
  }
  return { fields, general };
}

// ---------------------------------------------------------------------------
// State → assumptions
// ---------------------------------------------------------------------------
export interface BuildResult {
  assumptions: ForecastAssumptions | null;
  /** Keyed by control: "monthlyOrders", "parcels.0.weightLb", "parcels.0.dims", "zones", "fulfillment.drivers.<key>", … */
  errors: Record<string, string>;
  general: string[];
}

const WHOLE = /^\d{1,5}$/;

/**
 * Form state → `ForecastAssumptions`, or the errors that stop it. Blank required fields are named;
 * everything else is checked by the engine's own validation (`validateForecastAssumptions`), so the
 * form, the preview and the saved forecast agree on what is valid. Row order is kept as typed (the
 * engine sorts canonically), and a row that cannot be built still takes its place so that every error
 * lands on the row it belongs to.
 */
export function buildAssumptions(state: ForecastFormState, ctx: ForecastContext, asOfDate: string): BuildResult {
  const errors: Record<string, string> = {};
  const trim = (s: string) => s.trim();

  const monthlyOrders = trim(state.monthlyOrders);
  if (monthlyOrders === "") errors.monthlyOrders = "Enter how many orders you ship in a month.";
  const originZip = trim(state.originZip);
  if (originZip === "") errors.originZip = "Enter the 5-digit ZIP code you ship from.";
  if (asOfDate === "") errors.asOfDate = "Choose the date to read rates and fees on.";

  const selectedIds = state.services.map((s) => s.serviceId).filter((id) => id !== "");
  const selected = ctx.services.filter((s) => selectedIds.includes(s.serviceId));

  const services: ForecastService[] = state.services.map((row, i) => {
    const option = ctx.services.find((s) => s.serviceId === row.serviceId);
    if (!option) errors[`services.${i}.serviceId`] = "Choose a service.";
    if (trim(row.sharePct) === "") errors[`services.${i}.sharePct`] = "Enter a share of orders.";
    return { serviceId: option?.serviceId ?? row.serviceId, carrierCode: option?.carrierCode ?? "-", serviceCode: option?.serviceCode ?? "-", name: option?.name ?? "-", sharePct: trim(row.sharePct) };
  });

  const zoneSection = availableZones(ctx.services, selectedIds);
  const zoneChoices = new Set(zoneSection.zones);
  const zones: ForecastZone[] = zoneSection.hidden
    ? [{ zone: "ALL", sharePct: "100" }]
    : state.zones.map((row, i) => {
        if (row.zone === "" || !zoneChoices.has(row.zone)) errors[`zones.${i}.zone`] = "Choose a zone.";
        if (trim(row.sharePct) === "") errors[`zones.${i}.sharePct`] = "Enter a share of orders.";
        return { zone: row.zone, sharePct: trim(row.sharePct) };
      });

  const bySize = selected.filter((s) => !s.dimExempt);
  const parcels: ForecastParcel[] = state.parcels.map((row, i) => {
    const parcel: ForecastParcel = { weightLb: trim(row.weightLb), packagingType: row.packaging === PACKAGING_LEAVE_OUT ? null : row.packaging, sharePct: trim(row.sharePct) };
    if (parcel.weightLb === "") errors[`parcels.${i}.weightLb`] = "Enter the parcel's weight in pounds.";
    if (parcel.sharePct === "") errors[`parcels.${i}.sharePct`] = "Enter a share of orders.";
    if (row.unknownSize) {
      parcel.unknownSize = true;
      return parcel;
    }
    const dims = [trim(row.lengthIn), trim(row.widthIn), trim(row.heightIn)];
    if (dims.every((d) => d !== "")) {
      parcel.lengthIn = dims[0]!;
      parcel.widthIn = dims[1]!;
      parcel.heightIn = dims[2]!;
    } else if (dims.some((d) => d !== "")) {
      errors[`parcels.${i}.dims`] = "Give the length, width and height, or leave all three empty.";
    } else if (bySize.length) {
      errors[`parcels.${i}.dims`] = `${bySize.map((s) => s.name).join(", ")} ${bySize.length === 1 ? "prices" : "price"} by size. Give the parcel's length, width and height, or tick "I don't know the size".`;
    }
    return parcel;
  });

  const residentialPct = trim(state.residentialPct);
  if (residentialPct === "") errors.residentialPct = "Enter the share of orders delivered to homes (0 if none).";
  const multiPct = trim(state.multiPct);
  if (multiPct === "") errors["multiPackage.pct"] = "Enter the share of orders that ship as several packages (0 if none).";
  const multiIsZero = multiPct !== "" && /^0+(\.0+)?$/.test(multiPct);
  const packagesText = trim(state.packagesPerOrder);
  let packagesPerOrder = 2;
  if (!multiIsZero) {
    if (!/^\d{1,2}$/.test(packagesText)) errors["multiPackage.packagesPerOrder"] = `Enter a whole number from ${FORECAST_LIMITS.packagesPerOrderMin} to ${FORECAST_LIMITS.packagesPerOrderMax}.`;
    else packagesPerOrder = Number(packagesText);
  }

  let content: ForecastAssumptions["content"] = { rows: [{ units: 1, lines: 1, sharePct: "100" }] };
  const skip = state.fulfillment.skip;
  if (asksOrderContent(ctx, skip)) {
    if (state.contentMode === "average") {
      content = { averageUnits: trim(state.averageUnits), averageLines: trim(state.averageLines) };
      if (content.averageUnits === "") errors["content.averageUnits"] = "Enter the average number of items per order.";
      if (content.averageLines === "") errors["content.averageLines"] = "Enter the average number of order lines per order.";
    } else {
      content = {
        rows: state.contentRows.map((row, i) => {
          const units = trim(row.units);
          const lines = trim(row.lines);
          if (!WHOLE.test(units)) errors[`content.rows.${i}.units`] = "Enter a whole number of items.";
          if (!WHOLE.test(lines)) errors[`content.rows.${i}.lines`] = "Enter a whole number of order lines.";
          if (trim(row.sharePct) === "") errors[`content.rows.${i}.sharePct`] = "Enter a share of orders.";
          return { units: WHOLE.test(units) ? Number(units) : 0, lines: WHOLE.test(lines) ? Number(lines) : 0, sharePct: trim(row.sharePct) };
        }),
      };
    }
  }

  const fulfillment: ForecastFulfillment = { drivers: {}, orderShares: {} };
  if (skip) fulfillment.skip = true;
  else if (ctx.schedule.status === "ok") {
    const built = fulfillmentFromState({ ...state.fulfillment, skip: false }, fulfillmentContext(ctx));
    for (const [key, message] of Object.entries(built.errors)) errors[`fulfillment.${key}`] = message;
    fulfillment.drivers = built.value.drivers ?? {};
    fulfillment.orderShares = built.value.orderShares ?? {};
  }

  const candidate = {
    version: 1,
    monthlyOrders,
    asOfDate,
    originZip,
    parcels,
    zones,
    services,
    residentialPct,
    multiPackage: { pct: multiPct, packagesPerOrder },
    content,
    fulfillment,
  };
  const found = fieldErrorsFromProblems(validateForecastAssumptions(candidate));
  for (const [key, message] of Object.entries(found.fields)) if (!(key in errors)) errors[key] = message;
  const hasErrors = Object.keys(errors).length > 0 || found.general.length > 0;
  return { assumptions: hasErrors ? null : (candidate as unknown as ForecastAssumptions), errors, general: found.general };
}
