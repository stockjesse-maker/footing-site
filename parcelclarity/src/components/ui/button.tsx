import type { ButtonHTMLAttributes } from "react";
import Link from "next/link";
import { cn } from "./cn";
import { Spinner } from "./spinner";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "md" | "lg" | "sm";

const base =
  "inline-flex items-center justify-center gap-2 rounded-control font-medium transition-colors select-none " +
  "disabled:cursor-not-allowed disabled:opacity-50 active:scale-[0.99] motion-reduce:active:scale-100";
const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover",
  secondary: "bg-raised text-fg border border-line-strong hover:bg-surface",
  ghost: "text-accent-text hover:bg-accent-soft",
  danger: "bg-danger text-white hover:opacity-90",
};
const sizes: Record<Size, string> = {
  sm: "min-h-9 px-3 text-sm",
  md: "min-h-11 px-4 text-[15px]", // 44px minimum touch target
  lg: "min-h-12 px-6 text-base",
};

export function buttonClasses(variant: Variant = "primary", size: Size = "md", className?: string) {
  return cn(base, variants[variant], sizes[size], className);
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export function Button({ variant = "primary", size = "md", loading, className, children, disabled, type = "button", ...rest }: ButtonProps) {
  return (
    <button type={type} className={buttonClasses(variant, size, className)} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function ButtonLink({ href, variant = "primary", size = "md", className, children }: { href: string; variant?: Variant; size?: Size; className?: string; children: React.ReactNode }) {
  return (
    <Link href={href} className={buttonClasses(variant, size, className)}>
      {children}
    </Link>
  );
}
