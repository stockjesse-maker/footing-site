import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { Client } from "pg";

const MAIL_DIR = process.env.PC_MAIL_DIR ?? "/var/lib/parcelclarity-stack/mail";
const DB_URL = process.env.PC_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54322/postgres";
export const PASSWORD = "correct-horse-battery-staple";

export const uniqueEmail = (label: string) => `${label}-${randomUUID().slice(0, 8)}@example.test`;

// State handed from one spec file to another (fees.spec.ts writes it, mobile.spec.ts reads it): the people and ids of the
// Milestone 4 story, so the phone checks run on the same screens without building a second 3PL.
const STATE_DIR = path.resolve(__dirname, ".state");

export function saveSharedState(name: string, state: object) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(STATE_DIR, `${name}.json`), JSON.stringify(state, null, 2));
}

export function loadSharedState<T extends object>(name: string): T {
  const file = path.join(STATE_DIR, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`No shared state "${name}": run tests/e2e/${name}.spec.ts first (it writes ${file}).`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function decodeQuotedPrintable(input: string): string {
  return input.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** Waits for a message to `email` captured by the local SMTP sink and returns its decoded body. */
export async function waitForMail(email: string, subjectIncludes: string): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const files = fs.existsSync(MAIL_DIR) ? fs.readdirSync(MAIL_DIR).sort().reverse() : [];
    for (const f of files) {
      const raw = fs.readFileSync(path.join(MAIL_DIR, f), "utf8");
      if (raw.includes(`X-Rcpt-To: ${email}`) && raw.includes(`Subject: ${subjectIncludes}`)) return decodeQuotedPrintable(raw);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No "${subjectIncludes}" email for ${email} arrived in ${MAIL_DIR}`);
}

export async function firstLink(email: string, subjectIncludes: string): Promise<string> {
  const body = await waitForMail(email, subjectIncludes);
  const match = /href="([^"]+)"/.exec(body);
  if (!match?.[1]) throw new Error("No link found in email");
  return match[1].replace(/&amp;/g, "&");
}

export async function sql<T extends object = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    return (await client.query(text, params)).rows as T[];
  } finally {
    await client.end();
  }
}

/** Creates an account through the real sign-up form and confirms it through the real email link. */
export async function signUpAndConfirm(page: Page, opts: { name: string; email: string; company?: string; next?: string }) {
  await page.goto(opts.next ? `/signup?next=${encodeURIComponent(opts.next)}` : "/signup");
  await page.getByLabel("Your name").fill(opts.name);
  if (opts.company) await page.getByLabel("Company name").fill(opts.company);
  await page.getByLabel("Email").fill(opts.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText(`Check ${opts.email} for a confirmation link`)).toBeVisible();
  const link = await firstLink(opts.email, "Confirm your email");
  await page.goto(link);
}

export async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}
