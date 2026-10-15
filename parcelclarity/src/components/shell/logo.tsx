import { cn } from "@/components/ui/cn";

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-8", className)} aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--pc-accent)" />
      <path d="M9 12.2 16 8.5l7 3.7v7.6L16 23.5 9 19.8z" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M9.4 12.4 16 16l6.6-3.6M16 16v7.2" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5 font-semibold tracking-tight", className)}>
      <LogoMark />
      <span className="text-[17px]">ParcelClarity</span>
    </span>
  );
}
