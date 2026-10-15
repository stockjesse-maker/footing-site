import type { ReactNode } from "react";
import { Logo } from "@/components/shell/logo";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="safe-top safe-bottom flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <main id="main">{children}</main>
        <p className="mt-8 text-center text-xs text-muted">Know what fulfillment and shipping will cost before you ship.</p>
      </div>
    </div>
  );
}
