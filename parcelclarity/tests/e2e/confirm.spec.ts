import { expect, test } from "@playwright/test";
import { PASSWORD, signUpAndConfirm, uniqueEmail } from "./helpers";

// The token-hash route works when an email is opened on a different device from the one that
// requested it (PKCE codes cannot). We mint a genuine recovery token through the Auth admin API,
// exactly what Supabase's email templates in DEPLOYMENT.md embed.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

test.skip(!SERVICE_KEY, "SUPABASE_SERVICE_ROLE_KEY is required to mint a recovery token (see .env.local from stack:up)");

async function mintRecoveryToken(email: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY!, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "recovery", email }),
  });
  expect(res.ok).toBe(true);
  return (await res.json()).hashed_token as string;
}

test("recovery via token hash works in a browser that never requested it", async ({ browser }) => {
  const email = uniqueEmail("crossdevice");
  const setup = await browser.newContext({ baseURL: "http://localhost:3000" });
  const setupPage = await setup.newPage();
  await signUpAndConfirm(setupPage, { name: "Cass Device", email, company: "Cross Device Freight" });
  await setupPage.getByRole("button", { name: "Create workspace" }).click();
  await expect(setupPage).toHaveURL(/\/app$/);
  await setup.close();

  const tokenHash = await mintRecoveryToken(email);
  const otherDevice = await browser.newContext({ baseURL: "http://localhost:3000" });
  const page = await otherDevice.newPage();
  await page.goto(`/auth/confirm?token_hash=${tokenHash}&type=recovery`);
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  await page.getByLabel("New password", { exact: true }).fill(`${PASSWORD}-2`);
  await page.getByLabel("Confirm new password").fill(`${PASSWORD}-2`);
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.getByText("Your password was updated.")).toBeVisible();
  await otherDevice.close();
});

test("token links are single-use, reject garbage, and cannot redirect off-site", async ({ browser }) => {
  const email = uniqueEmail("redirects");
  const setup = await browser.newContext({ baseURL: "http://localhost:3000" });
  await signUpAndConfirm(await setup.newPage(), { name: "Rae Direct", email, company: "Redirect Freight" });
  await setup.close();

  const ctx = await browser.newContext({ baseURL: "http://localhost:3000" });
  const page = await ctx.newPage();
  const tokenHash = await mintRecoveryToken(email);
  await page.goto(`/auth/confirm?token_hash=${tokenHash}&type=recovery&next=https://evil.example/phish`);
  expect(new URL(page.url()).origin).toBe("http://localhost:3000"); // off-site `next` is ignored
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();

  const second = await browser.newContext({ baseURL: "http://localhost:3000" });
  const p2 = await second.newPage();
  await p2.goto(`/auth/confirm?token_hash=${tokenHash}&type=recovery`); // already used
  await expect(p2).toHaveURL(/\/login\?error=link/);
  await p2.goto("/auth/confirm?token_hash=garbage&type=recovery");
  await expect(p2).toHaveURL(/\/login\?error=link/);
  await p2.goto("/auth/confirm?token_hash=x&type=unsupported");
  await expect(p2).toHaveURL(/\/login\?error=link/);
  await p2.goto("/auth/confirm?code=not-a-real-code&next=https://evil.example");
  await expect(p2).toHaveURL(/\/login\?error=link/);
  await second.close();
  await ctx.close();
});
