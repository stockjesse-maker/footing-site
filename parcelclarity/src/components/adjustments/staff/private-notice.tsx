import { Badge } from "@/components/ui/badge";
import { cn } from "@/components/ui/cn";
import { PRIVATE_NOTICE } from "@/lib/adjustments/staff-copy";

/** "Only your team can see this. Customers never do." The same sentence on every history page and on the Overview. */
export function PrivateNotice({ className }: { className?: string }) {
  return (
    <p className={cn("flex flex-wrap items-center gap-2 rounded-control bg-surface px-3 py-2 text-sm text-muted", className)}>
      <Badge tone="neutral" className="bg-raised">
        Private
      </Badge>
      <span>{PRIVATE_NOTICE}</span>
    </p>
  );
}
