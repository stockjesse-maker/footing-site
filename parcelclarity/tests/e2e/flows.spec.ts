import { expect, test } from "@playwright/test";
import { PASSWORD, firstLink, signIn, signUpAndConfirm, sql, uniqueEmail } from "./helpers";

// One continuous story across two browser contexts: a 3PL signs up, adds a customer,
// invites the brand's admin; the brand admin joins; then isolation, status and
// recovery behaviour is checked against the real Auth + Postgres stack.
test.describe.configure({ mode: "serial" });

const runId = uniqueEmail("run").slice(4, 12);
const state = {
  company: `Northwind ${runId}`,
  tenantAdminEmail: uniqueEmail("pl-admin"),
  brandAdminEmail: uniqueEmail("brand-admin"),
  otherAdminEmail: uniqueEmail("other-admin"),
  platformEmail: uniqueEmail("platform"),
  brandPath: "",
  inviteLink: "",
};

test("a 3PL signs up, confirms by email, and creates a workspace", async ({ page }) => {
  await signUpAndConfirm(page, { name: "Pat Planner", email: state.tenantAdminEmail, company: state.company });
  await expect(page).toHaveURL(/\/onboarding/);
  await expect(page.getByLabel("Company name")).toHaveValue(state.company); // prefilled from sign-up
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("Active customers")).toBeVisible();
});

test("the 3PL adds a customer and invites its administrator", async ({ page }) => {
  await signIn(page, state.tenantAdminEmail);
  await expect(page).toHaveURL(/\/app$/);
  await page.getByRole("link", { name: "Customers" }).first().click();
  await page.getByLabel("Brand name").fill("Alpha Apparel");
  await page.getByRole("button", { name: "Add customer" }).click();
  await expect(page.getByRole("heading", { name: "Alpha Apparel" })).toBeVisible();
  state.brandPath = new URL(page.url()).pathname;

  await page.getByLabel("Email address").fill(state.brandAdminEmail);
  await page.getByLabel("Role").selectOption({ label: "Brand administrator" });
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByText("email delivery is not configured")).toBeVisible();
  state.inviteLink = await page.getByLabel(/Invitation link/).inputValue();
  expect(state.inviteLink).toMatch(/\/accept-invite\?token=/);
  await expect(page.getByText(state.brandAdminEmail)).toBeVisible(); // listed as pending

  // Inviting the same address twice is refused with a clear message.
  await page.getByLabel("Email address").fill(state.brandAdminEmail);
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByText("already a pending invitation")).toBeVisible();
});

test("the invited brand admin creates an account, accepts, and lands in the brand portal", async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: "http://localhost:3000" });
  const page = await ctx.newPage();
  await page.goto(state.inviteLink);
  await expect(page.getByText("You've been invited")).toBeVisible();
  await page.getByRole("link", { name: "Create an account" }).click();
  await expect(page.getByLabel("Company name")).toHaveCount(0); // invitees don't create a 3PL workspace

  await page.getByLabel("Your name").fill("Bea Brand");
  await page.getByLabel("Email").fill(state.brandAdminEmail);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText(`Check ${state.brandAdminEmail}`)).toBeVisible();
  await page.goto(await firstLink(state.brandAdminEmail, "Confirm your email"));

  // The confirmation link returns to the invitation, which needs one explicit click.
  await expect(page.getByRole("heading", { name: "Accept your invitation" })).toBeVisible();
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(page).toHaveURL(/\/portal$/);
  await expect(page.getByRole("heading", { name: /Welcome, Bea/ })).toBeVisible();
  await expect(page.getByText("Alpha Apparel").first()).toBeVisible();
  await expect(page.getByText(`Provided by ${state.company}`).first()).toBeVisible();

  // Primary navigation is exactly what the spec calls for.
  const nav = page.getByRole("navigation", { name: "Primary" }).first();
  for (const name of ["Overview", "Model Costs", "Reports", "Account"]) await expect(nav.getByRole("link", { name })).toBeVisible();

  // Reusing the same invitation link is refused.
  await page.goto(state.inviteLink);
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(page.getByText("invalid, has expired, or was sent to a different email")).toBeVisible();
  await ctx.close();
});

test("a brand user cannot reach the 3PL portal or another tenant's customer by URL", async ({ browser }) => {
  // Second, unrelated 3PL.
  const other = await browser.newContext({ baseURL: "http://localhost:3000" });
  const otherPage = await other.newPage();
  await signUpAndConfirm(otherPage, { name: "Olive Other", email: state.otherAdminEmail, company: "Southpoint Fulfillment" });
  await otherPage.getByRole("button", { name: "Create workspace" }).click();
  await expect(otherPage).toHaveURL(/\/app$/);

  // Guessing the first tenant's customer URL yields a 404, not data.
  const res = await otherPage.goto(state.brandPath);
  expect(res?.status()).toBe(404);
  await expect(otherPage.getByText("Alpha Apparel")).toHaveCount(0);
  await expect(otherPage.getByText(state.brandAdminEmail)).toHaveCount(0);
  await other.close();

  // The brand admin is bounced out of every 3PL route and out of platform tools.
  const brand = await browser.newContext({ baseURL: "http://localhost:3000" });
  const page = await brand.newPage();
  await signIn(page, state.brandAdminEmail);
  await expect(page).toHaveURL(/\/portal$/);
  for (const path of ["/app", "/app/customers", state.brandPath, "/app/team", "/app/audit"]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/portal$/);
  }
  expect((await page.goto("/platform"))?.status()).toBe(404);
  await brand.close();
});

test("wrong credentials give one generic message; recovery by email works end to end", async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: "http://localhost:3000" });
  const page = await ctx.newPage();
  await signIn(page, state.tenantAdminEmail, "wrong-password-123");
  await expect(page.getByText("Incorrect email or password.")).toBeVisible();
  await signIn(page, uniqueEmail("nobody"), PASSWORD);
  await expect(page.getByText("Incorrect email or password.")).toBeVisible(); // same message: no account enumeration

  await page.goto("/forgot-password");
  // Unknown addresses get the identical response (no account enumeration).
  await page.getByLabel("Email").fill(uniqueEmail("ghost"));
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByText("If that email address has an account")).toBeVisible();
  // The real request comes last: the PKCE verifier cookie belongs to the most recent request.
  await page.getByLabel("Email").fill(state.tenantAdminEmail);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByText("If that email address has an account")).toBeVisible();

  await page.goto(await firstLink(state.tenantAdminEmail, "Reset your password"));
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  await page.getByLabel("New password", { exact: true }).fill("a-brand-new-passphrase-1");
  await page.getByLabel("Confirm new password").fill("something-different-99");
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.getByText("Passwords do not match.")).toBeVisible();
  // Password fields are cleared after a failed submit and never echoed back, so fill both again.
  await page.getByLabel("New password", { exact: true }).fill("a-brand-new-passphrase-1");
  await page.getByLabel("Confirm new password").fill("a-brand-new-passphrase-1");
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page).toHaveURL(/\/app/);
  await expect(page.getByText("Your password was updated.")).toBeVisible();
  await ctx.close();

  const fresh = await browser.newContext({ baseURL: "http://localhost:3000" });
  const p2 = await fresh.newPage();
  await signIn(p2, state.tenantAdminEmail, PASSWORD); // old password no longer works
  await expect(p2.getByText("Incorrect email or password.")).toBeVisible();
  await signIn(p2, state.tenantAdminEmail, "a-brand-new-passphrase-1");
  await expect(p2).toHaveURL(/\/app/);
  await fresh.close();
});

test("suspending a customer cuts off its users immediately and reactivation restores them", async ({ browser }) => {
  const admin = await browser.newContext({ baseURL: "http://localhost:3000" });
  const adminPage = await admin.newPage();
  await signIn(adminPage, state.tenantAdminEmail, "a-brand-new-passphrase-1");
  const brand = await browser.newContext({ baseURL: "http://localhost:3000" });
  const brandPage = await brand.newPage();
  await signIn(brandPage, state.brandAdminEmail);
  await expect(brandPage).toHaveURL(/\/portal$/);

  await adminPage.goto(state.brandPath);
  await adminPage.getByRole("button", { name: "Suspend access" }).click();
  await adminPage.getByRole("group", { name: "Confirm: Suspend access" }).getByRole("button", { name: "Suspend" }).click();
  await expect(adminPage.getByText("This customer is suspended")).toBeVisible();

  await brandPage.goto("/portal");
  await expect(brandPage).toHaveURL(/\/access-suspended$/);
  await expect(brandPage.getByText("Access is currently suspended")).toBeVisible();

  await adminPage.getByRole("button", { name: "Reactivate" }).click();
  await adminPage.getByRole("group", { name: "Confirm: Reactivate" }).getByRole("button", { name: "Reactivate" }).click();
  await expect(adminPage.getByText("This customer is suspended")).toHaveCount(0);
  await brandPage.goto("/portal");
  await expect(brandPage).toHaveURL(/\/portal$/);

  // Activity log recorded it, attributed to the real person.
  await adminPage.goto("/app/audit");
  await expect(adminPage.getByText("Customer status changed").first()).toBeVisible();
  await expect(adminPage.getByText("Pat Planner").first()).toBeVisible();
  // ...and the brand user cannot open it.
  await brandPage.goto("/app/audit");
  await expect(brandPage).toHaveURL(/\/portal$/);
  await admin.close();
  await brand.close();
});

test("a platform administrator can suspend a tenant but sees none of its customers", async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: "http://localhost:3000" });
  const page = await ctx.newPage();
  await signUpAndConfirm(page, { name: "Pia Platform", email: state.platformEmail, company: "Platform Ops" });
  await sql("insert into public.platform_admins (user_id) select id from auth.users where email = $1", [state.platformEmail]);
  await page.goto("/");
  await expect(page).toHaveURL(/\/platform$/);
  const row = page.getByRole("listitem").filter({ hasText: state.company });
  await expect(row).toBeVisible();
  await expect(page.getByText("Alpha Apparel")).toHaveCount(0); // tenant data is not exposed

  await row.getByRole("button", { name: "Suspend" }).click();
  await row.getByRole("group", { name: "Confirm: Suspend" }).getByRole("button", { name: "Suspend tenant" }).click();
  await expect(row.getByText("suspended")).toBeVisible();

  const tenantUser = await browser.newContext({ baseURL: "http://localhost:3000" });
  const tp = await tenantUser.newPage();
  await signIn(tp, state.tenantAdminEmail, "a-brand-new-passphrase-1");
  await expect(tp).toHaveURL(/\/access-suspended$/);

  await row.getByRole("button", { name: "Restore" }).click();
  await row.getByRole("group", { name: "Confirm: Restore" }).getByRole("button", { name: "Restore" }).click();
  await expect(row.getByText("active")).toBeVisible();
  await tp.goto("/");
  await expect(tp).toHaveURL(/\/app$/);
  await ctx.close();
  await tenantUser.close();
});
