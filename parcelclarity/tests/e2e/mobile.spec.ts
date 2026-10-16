import { expect, test, type Page } from "@playwright/test";
import { PASSWORD, loadSharedState, signIn, signUpAndConfirm, uniqueEmail } from "./helpers";
import { expectPhoneLayout } from "./screen-checks";

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

// ---------------------------------------------------------------------------
// Milestone 4 screens at iPhone width. They run on the people and ids of the story told by fees.spec.ts (the desktop
// project runs it first and writes them to tests/e2e/.state/fees.json): a fee schedule, a customer's runs and forecast.
// Each screen must not scroll sideways, keep inputs at 16px and keep every control at 44px.
// ---------------------------------------------------------------------------
interface FeesState {
  adminEmail: string;
  brandAdminEmail: string;
  brandId: string;
  scheduleId: string;
  versionId: string;
  draftVersionId: string;
  datasetId: string;
  runId: string;
  secondRunId: string;
  cleanRunId: string;
  forecastId: string;
  forecastName: string;
}

const feesState = () => {
  const state = loadSharedState<FeesState>("fees");
  for (const key of ["scheduleId", "versionId", "draftVersionId", "datasetId", "runId", "secondRunId", "cleanRunId", "forecastId"] as const) {
    if (!state[key]) throw new Error(`fees.spec.ts did not finish: no ${key} in the shared state.`);
  }
  return state;
};

async function signInTo(page: Page, email: string, home: RegExp) {
  await signIn(page, email, PASSWORD);
  await expect(page).toHaveURL(home);
}

test("the customer's fee schedule, run setup step 2 and run results fit the phone", async ({ page }) => {
  test.setTimeout(240_000);
  const s = feesState();
  await signInTo(page, s.brandAdminEmail, /\/portal$/);
  for (const [name, url] of [
    ["overview", "/portal"],
    ["model hub", "/portal/model"],
    ["fee schedule", "/portal/model/fees"],
    ["run, shipping view", `/portal/model/runs/${s.runId}?view=shipping`],
    ["run, order fees view", `/portal/model/runs/${s.runId}?view=fees`],
    ["run, all-in view", `/portal/model/runs/${s.runId}?view=allin`],
    ["second run, all-in view", `/portal/model/runs/${s.secondRunId}?view=allin`],
    ["clean run, exact account minimum", `/portal/model/runs/${s.cleanRunId}`],
    ["reports", "/portal/reports"],
    ["comparison of two runs", `/portal/reports?a=${s.runId}&b=${s.secondRunId}`],
  ] as const) {
    await page.goto(url);
    await expect(page.locator("main")).toBeVisible();
    await expectPhoneLayout(page, name);
  }
  // The view control and the cards read at 390px: each of the three views is one tap.
  await page.goto(`/portal/model/runs/${s.runId}?view=allin`);
  const views = page.getByRole("navigation", { name: "Show" }).getByRole("link");
  await expect(views).toHaveCount(3);
  for (const box of await views.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()))) expect(box.height).toBeGreaterThanOrEqual(44);

  // Run setup step 2: empty, with its errors, and carried over on a rerun.
  await page.goto(`/portal/model/orders/${s.datasetId}`);
  await expectPhoneLayout(page, "run setup step 1");
  await page.getByRole("button", { name: "Continue to fulfillment costs" }).click();
  await expect(page.getByText("Step 2 of 2")).toBeVisible();
  await expectPhoneLayout(page, "run setup step 2");
  await page.getByRole("button", { name: "Run the model" }).click();
  await expect(page.getByText("4 answers need attention before the run can start.")).toBeVisible();
  await expectPhoneLayout(page, "run setup step 2 with errors");
  await page.goto(`/portal/model/runs/${s.runId}`);
  await page.getByRole("button", { name: "Continue to fulfillment costs" }).click();
  await page.getByRole("group", { name: "Pallets you send in each month", exact: true }).getByLabel("Pallets you send in each month: number of pallets", { exact: true }).fill("6");
  await expect(page.getByText("Changed: pallets you send in each month left out → 6")).toBeVisible();
  await expectPhoneLayout(page, "run again, step 2 with the change line");
});

test("the forecast form and its results, and the calculator with order fees, fit the phone", async ({ page }) => {
  test.setTimeout(240_000);
  const s = feesState();
  await signInTo(page, s.brandAdminEmail, /\/portal$/);
  await page.goto("/portal/model/forecast");
  await expectPhoneLayout(page, "forecast form");
  await page.getByRole("button", { name: "Preview forecast" }).click();
  await expect(page.getByText(/^Fix these \d+ before previewing$/)).toBeVisible();
  await expectPhoneLayout(page, "forecast form with errors");
  // A saved forecast opened as a new one: preview it, and leave a fee out so the "not included" list shows.
  await page.goto(`/portal/model/forecast?from=${s.forecastId}`);
  await expect(page.getByLabel("Orders a month", { exact: true })).toHaveValue("1200");
  await page.getByRole("button", { name: "Preview forecast" }).click();
  await expect(page.getByRole("heading", { name: "Your forecast", level: 2 })).toBeVisible();
  await expectPhoneLayout(page, "forecast preview");
  await page.getByRole("group", { name: "Pallets you send in each month", exact: true }).getByRole("radio", { name: "Not sure, leave it out" }).check();
  await page.getByRole("button", { name: "Preview again" }).click();
  await expect(page.getByRole("heading", { name: "Not included: not computed from what you gave" })).toBeVisible();
  await expectPhoneLayout(page, "forecast preview with a fee left out");
  await page.goto(`/portal/model/forecast/${s.forecastId}`);
  await expect(page.getByRole("heading", { name: s.forecastName, level: 1 })).toBeVisible();
  await expectPhoneLayout(page, "saved forecast");

  await page.goto("/portal/model/calculator");
  const box = page.getByRole("group", { name: "What's in the box" });
  await expect(box).toBeVisible();
  await expectPhoneLayout(page, "calculator with the box block");
  await page.getByLabel("Origin ZIP").fill("90001");
  await page.getByLabel("Destination ZIP").fill("85001");
  await page.getByLabel("Weight", { exact: true }).fill("3");
  await box.getByLabel("Items (units)").fill("3");
  await box.getByLabel("Packaging", { exact: true }).selectOption({ label: "Box" });
  await page.getByRole("button", { name: "Calculate", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^Results: \d+ services$/ })).toBeVisible();
  await expectPhoneLayout(page, "calculator, every service with order fees");
  await page.getByLabel("Service", { exact: true }).selectOption({ label: "UPS Ground" });
  await page.getByRole("button", { name: "Calculate", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Shipping + order fees for this order (monthly charges not included)" })).toBeVisible();
  await expectPhoneLayout(page, "calculator, one service with order fees");
});

test("the 3PL's fee-schedule screens and tab bar fit the phone", async ({ page }) => {
  test.setTimeout(240_000);
  const s = feesState();
  await signInTo(page, s.adminEmail, /\/app$/);
  // An administrator's bar carries every section (nine at least): it scrolls inside itself, each tab stays a real target, and the current tab is in view.
  await page.goto("/app/fee-schedules");
  const tabs = page.getByRole("navigation", { name: "Primary" }).getByRole("link");
  expect(await tabs.count()).toBeGreaterThanOrEqual(9);
  const geometry = await tabs.evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { label: (el.textContent ?? "").trim(), left: r.left, right: r.right, width: r.width, height: r.height, clippedX: el.scrollWidth > el.clientWidth + 1, clippedY: el.scrollHeight > el.clientHeight + 1, current: el.getAttribute("aria-current") === "page" };
    }),
  );
  for (const [i, t] of geometry.entries()) {
    expect(t.height, `${t.label}: tab height`).toBeGreaterThanOrEqual(44);
    expect(t.width, `${t.label}: tab width`).toBeGreaterThanOrEqual(72);
    expect(t.clippedX || t.clippedY, `${t.label}: label clipped`).toBe(false);
    const next = geometry[i + 1];
    if (next) expect(t.right, `${t.label} overlaps ${next.label}`).toBeLessThanOrEqual(next.left + 1);
  }
  const current = geometry.find((t) => t.current);
  expect(current?.label).toBe("Fee schedules");
  expect(current!.left).toBeGreaterThanOrEqual(0);
  expect(current!.right).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  await expectPhoneLayout(page, "/app/fee-schedules");
  await page.getByText("What fee schedules cannot model yet").click();
  await expectPhoneLayout(page, "/app/fee-schedules, what cannot be modeled open");

  await page.goto(`/app/fee-schedules/${s.scheduleId}`);
  await expectPhoneLayout(page, "/app/fee-schedules/[id]");
  await page.getByRole("button", { name: "End…" }).click();
  await expect(page.getByRole("dialog", { name: "End version 1" })).toBeVisible();
  await expectPhoneLayout(page, "end-version dialog");
  await page.keyboard.press("Escape");

  await page.goto(`/app/fee-schedules/${s.scheduleId}/versions/${s.versionId}`);
  await expect(page.getByRole("heading", { name: "Version 1" })).toBeVisible();
  await expectPhoneLayout(page, "the active version");
  const form = page.getByRole("form", { name: "Try an order" });
  await form.getByLabel("Items", { exact: true }).fill("3");
  await form.getByLabel("Package 1: packaging type", { exact: true }).fill("box");
  await page.getByRole("button", { name: "Price this order" }).click();
  await expect(page.getByText("Not computed", { exact: true })).toBeVisible();
  await expectPhoneLayout(page, "the active version with a priced order");

  // The draft: the rule editor with several of its sections, an error summary, and the activation dialog.
  await page.goto(`/app/fee-schedules/${s.scheduleId}/versions/${s.draftVersionId}`);
  await expect(page.getByRole("heading", { name: "Version 2" })).toBeVisible();
  await expectPhoneLayout(page, "a draft version");
  await page.getByRole("button", { name: "Add rule", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Add a rule" })).toBeVisible();
  await expectPhoneLayout(page, "rule editor, empty");
  await page.getByLabel("Preset", { exact: true }).selectOption({ label: "Account minimum" });
  await expectPhoneLayout(page, "rule editor, account minimum");
  await page.getByLabel("Preset", { exact: true }).selectOption({ label: "Long-term storage" });
  await page.getByRole("button", { name: "Save rule" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "This rule cannot be saved yet" })).toBeVisible();
  await expectPhoneLayout(page, "rule editor with errors");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Activate…" }).first().click();
  await expect(page.getByRole("dialog", { name: "Activate version 2" })).toBeVisible();
  await expectPhoneLayout(page, "activation dialog");
  await page.keyboard.press("Escape");

  await page.goto(`/app/customers/${s.brandId}`);
  await expect(page.getByRole("heading", { name: "Fee schedule", exact: true })).toBeVisible();
  await expectPhoneLayout(page, "customer page with its fee schedule");
  for (const [name, url] of [
    ["on behalf: run, all-in view", `/app/customers/${s.brandId}/model/runs/${s.runId}?view=allin`],
    ["on behalf: forecast", `/app/customers/${s.brandId}/model/forecast/${s.forecastId}`],
    ["on behalf: forecast form", `/app/customers/${s.brandId}/model/forecast`],
  ] as const) {
    await page.goto(url);
    await expect(page.locator("main")).toBeVisible();
    await expectPhoneLayout(page, name);
  }
});

