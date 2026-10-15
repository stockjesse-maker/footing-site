import type { FieldErrors } from "@/lib/auth/validation";

export interface ActionState {
  ok: boolean;
  message?: string;
  errors?: FieldErrors;
  /** Present only when an invitation email could not be delivered, so the admin can share the link manually. */
  inviteLink?: string;
  /** Echoed non-secret form values so a failed submit does not clear the form. Never passwords. */
  values?: Record<string, string>;
}

export const initialState: ActionState = { ok: false };
