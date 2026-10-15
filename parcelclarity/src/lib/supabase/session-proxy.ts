import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { publicEnv } from "@/lib/env";
import { hardenCookie } from "@/lib/supabase/cookie-options";

/** Refreshes the Supabase session cookie and returns the verified user (validated by the Auth server). */
export async function refreshSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(publicEnv.NEXT_PUBLIC_SUPABASE_URL, publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, hardenCookie(options));
      },
    },
  });
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { response, user };
}
