import { NextResponse } from "next/server";
import { ADJUSTMENTS_TEMPLATE_CSV, ADJUSTMENTS_TEMPLATE_FILENAME } from "@/lib/adjustments/template";
import { getUser } from "@/lib/auth/session";

/**
 * Adjustment-history template. Mirrors the rate-card template route: a signed-in user may download it (no permission is needed, it is
 * static text), anyone else gets 401. The two example rows are fictional and say so; the importer refuses them if they are uploaded.
 */
export async function GET() {
  const user = await getUser();
  if (!user) return new NextResponse("Sign in to download the template.", { status: 401, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  return new NextResponse(ADJUSTMENTS_TEMPLATE_CSV.replace(/\n/g, "\r\n"), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${ADJUSTMENTS_TEMPLATE_FILENAME}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
