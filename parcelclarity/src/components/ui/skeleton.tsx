import { cn } from "./cn";

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-control bg-line motion-reduce:animate-none", className)} />;
}
