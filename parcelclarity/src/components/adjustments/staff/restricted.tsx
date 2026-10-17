import { ButtonLink } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { RESTRICTED_BODY, RESTRICTED_TITLE } from "@/lib/adjustments/staff-copy";

/** What a member without `adjustment.view` reads in place of an adjustments page. It is a page, not a 404, and it shows nothing of the area. */
export function AdjustmentsRestricted() {
  return (
    <Card role="region" aria-label="Adjustments are restricted">
      <CardTitle>{RESTRICTED_TITLE}</CardTitle>
      <CardDescription>{RESTRICTED_BODY}</CardDescription>
      <div className="mt-4">
        <ButtonLink href="/app" variant="secondary">
          Back to overview
        </ButtonLink>
      </div>
    </Card>
  );
}
