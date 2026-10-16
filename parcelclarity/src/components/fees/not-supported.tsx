import { cn } from "@/components/ui/cn";

/**
 * What a fee schedule cannot express. The wording is design section 0's deferred list, unchanged,
 * so staff know before they author a schedule which charges must be quoted outside the tool.
 */
export const NOT_SUPPORTED_ITEMS: readonly string[] = [
  "seasonal windows inside a version (use a version per season)",
  "weight- or value-based handling fees",
  "discounts/credits (amounts ≥ 0 only)",
  "fees as a percent of another fee",
  "per-hour special projects (quoted outside the tool)",
  "inventory dimensions / per-SKU storage from dimensions",
  "peak-based storage billing (quantities are average occupancy)",
  "nested minimums (sets must be disjoint)",
  "per-receipt size lists (receipt fees assume equal receipts)",
  "return shipping postage",
  "delivery-area/remote surcharges in forecasts (need ZIP codes)",
  "dependent mixes (segments)",
  "prospects without a brand record",
  "spreadsheet import of fee schedules",
];

export function NotSupportedPanel({ className }: { className?: string }) {
  return (
    <details className={cn("rounded-card border border-line bg-raised shadow-card", className)}>
      <summary className="flex min-h-11 cursor-pointer items-center px-4 py-2 text-[15px] font-medium sm:px-6">What fee schedules cannot model yet</summary>
      <div className="border-t border-line px-4 py-4 sm:px-6">
        <p className="text-sm text-muted">
          Charges like these cannot be written as rules. Quote them to your customer outside ParcelClarity, and do not approximate them with a different rule: a figure the tool shows should always
          be one you can stand behind.
        </p>
        <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm">
          {NOT_SUPPORTED_ITEMS.map((item) => (
            <li key={item} className="first-letter:uppercase">
              {item}
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
