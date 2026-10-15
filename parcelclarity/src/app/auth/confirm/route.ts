import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { safeNext } from "@/lib/auth/safe-redirect";
import { createClient } from "@/lib/supabase/server";

const TYPES: readonly EmailOtpType[] = ["signup", "invite", "magiclink", "recovery", "email_change", "email"];

/**
 * Single landing route for every emailed auth link (confirmation, recovery).
 *  - `?code=`        PKCE: default Supabase templates. Works only in the browser that requested the email.
 *  - `?token_hash=`  Recommended templates (see DEPLOYMENT.md). Works when the email is opened on another device.
 * `next` is restricted to same-site paths. Any failure lands on the login page with a generic error.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = safeNext(searchParams.get("next"), type === "recovery" ? "/reset-password" : "/");
  const supabase = await createClient();

  const code = searchParams.get("code");
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, origin));
  }

  const tokenHash = searchParams.get("token_hash");
  if (!code && tokenHash && type && TYPES.includes(type)) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) return NextResponse.redirect(new URL(next, origin));
  }
  return NextResponse.redirect(new URL("/login?error=link", origin));
}
