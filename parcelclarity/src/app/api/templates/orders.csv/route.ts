import { NextResponse } from "next/server";
import { getUser } from "@/lib/auth/session";
import { ORDERS_TEMPLATE_CSV } from "@/lib/orders/template";

/** Generic orders template (one row per package); the example row is clearly fictional. */
export async function GET() {
  const user = await getUser();
  if (!user) return new NextResponse("Sign in to download the template.", { status: 401, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  return new NextResponse(ORDERS_TEMPLATE_CSV.replace(/\n/g, "\r\n"), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="parcelclarity-orders-template.csv"',
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
