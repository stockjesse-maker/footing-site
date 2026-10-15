import { NextResponse, type NextRequest } from "next/server";
import { refreshSession } from "@/lib/supabase/session-proxy";

// Optimistic gate only: it keeps the session fresh and bounces signed-out visitors
// to the login page. Real authorization happens in server code (src/lib/auth) and in
// PostgreSQL Row Level Security, never here.
const PROTECTED_PREFIXES = ["/app", "/portal", "/platform", "/onboarding"];
const AUTH_PAGES = ["/login", "/signup", "/forgot-password"];

export async function proxy(request: NextRequest) {
  const { response, user } = await refreshSession(request);
  const { pathname, search } = request.nextUrl;

  const redirectTo = (path: string, params?: Record<string, string>) => {
    const url = request.nextUrl.clone();
    url.pathname = path;
    url.search = params ? `?${new URLSearchParams(params).toString()}` : "";
    const redirect = NextResponse.redirect(url);
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  };

  if (!user && PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return redirectTo("/login", { next: `${pathname}${search}` });
  }
  if (user && AUTH_PAGES.includes(pathname)) {
    return redirectTo("/");
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icons/|manifest.webmanifest|sw.js|offline.html).*)"],
};
