import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { signIn, signUpAndConfirm, uniqueEmail } from "./helpers";

// Automated WCAG 2.1 A/AA checks with axe-core. Automated checks catch roughly a third of
// accessibility issues; the manual review is tracked in IMPLEMENTATION_STATUS.md.
async function expectNoSeriousViolations(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${label}: ${v.id} ${v.help}\n${v.nodes.map((n) => `  ${n.target.join(" ")} :: ${n.any[0]?.message ?? ""}`).join("\n")}`)).toEqual([]);
}

test.describe.configure({ mode: "serial" });
const email = uniqueEmail("a11y");

test("public pages have no serious accessibility violations", async ({ page }) => {
  for (const path of ["/login", "/signup", "/forgot-password"]) {
    await page.goto(path);
    await expectNoSeriousViolations(page, path);
  }
});

test("signed-in 3PL pages have no serious accessibility violations", async ({ page }) => {
  await signUpAndConfirm(page, { name: "Ada Access", email, company: "Accessible Freight" });
  await expectNoSeriousViolations(page, "/onboarding");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expectNoSeriousViolations(page, "/app");
  await page.getByLabel("Brand name").count(); // customers page below
  for (const path of ["/app/customers", "/app/team", "/app/audit", "/app/settings"]) {
    await page.goto(path);
    await expectNoSeriousViolations(page, path);
  }
  await page.goto("/app/customers");
  await page.getByLabel("Brand name").fill("A11y Brand");
  await page.getByRole("button", { name: "Add customer" }).click();
  await expect(page.getByRole("heading", { name: "A11y Brand" })).toBeVisible();
  await expectNoSeriousViolations(page, "/app/customers/[id]");
});

test("keyboard users can reach the sign-in form and focus is visible", async ({ page }) => {
  await signIn(page, email); // proves the form works by keyboard-equivalent fill; below checks focus ring
  await page.context().clearCookies();
  await page.goto("/login");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Email")).toBeFocused();
  const outline = await page.getByLabel("Email").evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe("none");
});
