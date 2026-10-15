import type { CookieOptions } from "@supabase/ssr";

/**
 * Session cookies are only ever read on the server (there is no browser-side Supabase client),
 * so they can be HttpOnly: injected script cannot read the tokens. If a browser client is ever
 * introduced, this must be revisited deliberately.
 */
export function hardenCookie(options: CookieOptions | undefined): CookieOptions {
  return { ...options, httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: options?.path ?? "/" };
}
