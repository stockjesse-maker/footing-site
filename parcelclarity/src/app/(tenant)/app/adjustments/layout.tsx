import type { Metadata } from "next";
import type { ReactNode } from "react";
import { adjustmentAccess } from "@/components/adjustments/staff/access";
import { AdjustmentsRestricted } from "@/components/adjustments/staff/restricted";
import { AdjustmentTabs } from "@/components/adjustments/staff/tabs";
import { PageHeader } from "@/components/ui/page-header";
import { ADJUSTMENTS_DESCRIPTION, ADJUSTMENTS_TITLE } from "@/lib/adjustments/staff-copy";

export const metadata: Metadata = { title: ADJUSTMENTS_TITLE };

/**
 * The shell of the Adjustments area: the one h1, and the five tabs (Overview, Policies, History, Examples, Risk). A member who does not
 * hold `adjustment.view` reads the "only administrators" notice in place of the area: a page, not a 404. Every page below checks the same
 * permission again before it reads anything (a layout does not protect its pages), and the actions and the database check it a third time.
 * Pages under this layout use h2 and below.
 */
export default async function AdjustmentsLayout({ children }: { children: ReactNode }) {
  const access = await adjustmentAccess();
  if (!access.canView) {
    return (
      <>
        <PageHeader title={ADJUSTMENTS_TITLE} />
        <AdjustmentsRestricted />
      </>
    );
  }
  return (
    <>
      <PageHeader title={ADJUSTMENTS_TITLE} description={ADJUSTMENTS_DESCRIPTION} />
      <AdjustmentTabs />
      {children}
    </>
  );
}
