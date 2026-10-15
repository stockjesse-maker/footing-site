import { z } from "zod";

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Enter your email address.")
  .max(254)
  .pipe(z.email("Enter a valid email address."));

// bcrypt (used by Supabase Auth) silently ignores bytes past 72, so cap the length instead of truncating.
export const passwordSchema = z
  .string()
  .min(10, "Use at least 10 characters.")
  .refine((v) => new TextEncoder().encode(v).length <= 72, "Use at most 72 characters.");

export const nameSchema = z.string().trim().min(1, "Enter a name.").max(120, "Use at most 120 characters.");

export const uuidSchema = z.uuid();

export type FieldErrors = Record<string, string>;

export function fieldErrors(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}
