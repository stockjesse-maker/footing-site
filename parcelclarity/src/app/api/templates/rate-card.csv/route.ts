import { NextResponse } from "next/server";
import { getUser } from "@/lib/auth/session";

/**
 * Long-layout rate card template. Every value is a placeholder (prices are 0.00) so the file can
 * never be mistaken for real rates; a 3PL replaces the rows with its own customer-facing prices.
 * CSV has no comment syntax, so the rows themselves carry the explanation.
 */
const HEADER = "carrier,service,origin_zip,zone,weight_min,weight_max,weight_unit,price,min_charge,dim_divisor";
const ROWS = ["UPS,UPS Ground,,2,0,1,lb,0.00,,", "UPS,UPS Ground,,2,1,2,lb,0.00,,"];
const TEMPLATE = `${[HEADER, ...ROWS].join("\r\n")}\r\n`;

export async function GET() {
  const user = await getUser();
  if (!user) return new NextResponse("Sign in to download the template.", { status: 401, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  return new NextResponse(TEMPLATE, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="parcelclarity-rate-card-template.csv"',
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
