import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { publicEnv } from "@/lib/env";
import { hardenCookie } from "@/lib/supabase/cookie-options";

/**
 * Supabase client bound to the signed-in user's session. Every query runs with the
 * user's JWT, so PostgreSQL Row Level Security is always in force. There is
 * deliberately no service-role client in this milestone.
 */
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(publicEnv.NEXT_PUBLIC_SUPABASE_URL, publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, hardenCookie(options));
        } catch {
          // Called from a Server Component, where cookies are read-only. The proxy refreshes sessions.
        }
      },
    },
  });
}
