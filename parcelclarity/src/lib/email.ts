import "server-only";
import { serverEnv } from "@/lib/env";

export type EmailResult = "sent" | "not_configured" | "failed";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

interface Message {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Sends transactional email through Resend when RESEND_API_KEY is set. When it is not,
 * nothing is sent and the caller is told so, so the UI can say it plainly. There is no
 * silent fake transport.
 */
export async function sendEmail(message: Message): Promise<EmailResult> {
  const { RESEND_API_KEY, EMAIL_FROM } = serverEnv();
  if (!RESEND_API_KEY || !EMAIL_FROM) return "not_configured";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: EMAIL_FROM, to: [message.to], subject: message.subject, html: message.html, text: message.text }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
