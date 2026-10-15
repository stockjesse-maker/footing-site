import { expect, test, type Page } from "@playwright/test";
import { signUpAndConfirm, uniqueEmail } from "./helpers";

// iPhone 14 emulation (viewport, touch, UA) on Chromium. This does NOT replace testing on a real
// iPhone in Safari; see IMPLEMENTATION_STATUS.md.
const noHorizontalScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

test("installability metadata is served", async ({ page, request }) => {
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest).toMatchObject({ name: "ParcelClarity", display: "standalone", start_url: "/" });
  const purposes = manifest.icons.map((i: { purpose: string }) => i.purpose);
  expect(purposes).toEqual(expect.arrayContaining(["any", "maskable"]));
  for (const icon of manifest.icons) expect((await request.get(icon.src)).status()).toBe(200);
  expect((await request.get("/icons/apple-touch-icon.png")).status()).toBe(200);
  expect((await request.get("/sw.js")).headers()["content-type"]).toContain("javascript");
  expect((await request.get("/offline.html")).status()).toBe(200);

  await page.goto("/login");
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /viewport-fit=cover/);
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"], meta[name="mobile-web-app-capable"]').first()).toHaveAttribute("content", "yes");
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", /apple-touch-icon/);
});

test("auth screens fit the phone and inputs never trigger iOS zoom", async ({ page }) => {
  for (const path of ["/login", "/signup", "/forgot-password"]) {
    await page.goto(path);
    await noHorizontalScroll(page);
    const sizes = await page.locator("input:not([type=hidden])").evaluateAll((els) => els.map((el) => parseFloat(getComputedStyle(el).fontSize)));
    expect(Math.min(...sizes), path).toBeGreaterThanOrEqual(16); // iOS zooms into inputs below 16px
    const smallTargets = await page.locator("button, a, input:not([type=hidden])").evaluateAll((els) =>
      els
        .filter((el) => !el.classList.contains("sr-only")) // the skip link is intentionally hidden until focused
        .map((el) => ({ el, rect: el.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 0 && rect.height > 0 && rect.height < 44)
        .map(({ el }) => el.outerHTML.slice(0, 80)),
    );
    expect(smallTargets, `${path} touch targets under 44px`).toEqual([]);
  }
});

test("3PL app shows a bottom tab bar on phones and stays within the viewport", async ({ page }) => {
  await signUpAndConfirm(page, { name: "Mia Mobile", email: uniqueEmail("mobile"), company: "Pocket Freight" });
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await noHorizontalScroll(page);
  const tabs = page.getByRole("navigation", { name: "Primary" });
  await expect(tabs).toBeVisible();
  await expect(tabs.getByRole("link", { name: "Customers" })).toBeVisible();
  const box = await tabs.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box!.y + box!.height).toBeGreaterThanOrEqual(viewport.height - 1); // pinned to the bottom edge
  for (const path of ["/app/customers", "/app/settings", "/app/team"]) {
    await page.goto(path);
    await noHorizontalScroll(page);
  }
  await page.goto("/app/customers");
  await page.getByLabel("Brand name").fill("Phone Brand");
  await page.getByRole("button", { name: "Add customer" }).click();
  await expect(page.getByRole("heading", { name: "Phone Brand" })).toBeVisible();
  await noHorizontalScroll(page);
});
