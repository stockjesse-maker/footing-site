import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { devices, expect, test, type Locator, type Page } from "@playwright/test";
import { signIn, signUpAndConfirm, sql, uniqueEmail } from "./helpers";

// Milestone 3 end to end: a brand customer uploads a FICTIONAL orders file, reviews how it was
// read, prepares it, runs the model at today's rates and reads the results with their coverage
// and exclusions; saves a single-shipment scenario; the 3PL sees the same on the customer's
// behalf; another customer and another 3PL get nothing by URL. The customer-facing rate card is
// built straight in the database (the import wizard is covered by pricing.spec.ts); every price
// in it is a made-up test value.
test.describe.configure({ mode: "serial" });

const FIXTURES = path.resolve(__dirname, "../fixtures/modeling");
const runId = uniqueEmail("m3").slice(3, 11);
const state = {
  company: `Fictional Fulfillment ${runId}`,
  adminEmail: uniqueEmail("m3-admin"),
  brandAdminEmail: uniqueEmail("m3-brand"),
  otherBrandEmail: uniqueEmail("m3-other-brand"),
  otherTenantEmail: uniqueEmail("m3-other-3pl"),
  brandName: `Zeta Fictional Goods ${runId}`,
  otherBrandName: `Omega Fictional Goods ${runId}`,
  cardName: `Fictional Test Card ${runId}`,
  tenantId: "",
  brandId: "",
  otherBrandId: "",
  datasetId: "",
  runId: "",
};

const exactly = (label: string) => new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
/** The big number of a <Stat label="…"> card. */
const stat = (page: Page, label: string): Locator => page.locator("p", { hasText: exactly(label) }).locator("xpath=following-sibling::p[1]");

const uuid = (url: string, after: string) => {
  const m = new RegExp(`${after}/([0-9a-f-]{36})`).exec(url);
  if (!m?.[1]) throw new Error(`No id after ${after} in ${url}`);
  return m[1];
};

/** Fictional price for a bracket: nothing here resembles a real carrier rate. */
const fakePrice = (zone: number, bracketIndex: number) => (7 + zone * 0.5 + bracketIndex).toFixed(2);

/** A customer-facing rate card with UPS Ground, UPS 2nd Day Air and USPS Ground Advantage, zones 2–8, plus one residential rule. */
async function buildRateCard(tenantId: string, brandId: string): Promise<string> {
  const services = await sql<{ id: string; carrier_code: string; code: string }>("select id, carrier_code, code from public.shipping_services where (carrier_code, code) in (('ups','ground'), ('ups','second_day_air'), ('usps','ground_advantage'))");
  const svc = (carrier: string, code: string) => services.find((s) => s.carrier_code === carrier && s.code === code)!.id;
  const [card] = await sql<{ id: string }>("insert into public.rate_cards (tenant_id, name) values ($1, $2) returning id", [tenantId, state.cardName]);
  const [version] = await sql<{ id: string }>("insert into public.rate_card_versions (rate_card_id, tenant_id, version_number) values ($1, $2, 1) returning id", [card!.id, tenantId]);
  const v = version!.id;
  for (const [carrier, code] of [["ups", "ground"], ["ups", "second_day_air"], ["usps", "ground_advantage"]] as const) {
    await sql("insert into public.rate_card_service_terms (version_id, service_id, dim_divisor, weight_rounding) values ($1, $2, 139, $3)", [v, svc(carrier, code), carrier === "usps" ? "postal" : "up_whole_lb"]);
  }
  const rows: string[] = [];
  const lbBrackets: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 10], [10, 20], [20, 50], [50, 70], [70, 150]];
  for (let zone = 2; zone <= 8; zone++) {
    lbBrackets.forEach(([min, max], i) => rows.push(`('${v}', '${svc("ups", "ground")}', '${zone}', ${min}, ${max}, 'lb', ${fakePrice(zone, i)})`));
    [[0, 1], [1, 2], [2, 3], [3, 5]].forEach(([min, max], i) => rows.push(`('${v}', '${svc("ups", "second_day_air")}', '${zone}', ${min}, ${max}, 'lb', ${fakePrice(zone + 10, i)})`));
    [[0, 8], [8, 16]].forEach(([min, max], i) => rows.push(`('${v}', '${svc("usps", "ground_advantage")}', '${zone}', ${min}, ${max}, 'oz', ${fakePrice(zone, i)})`));
    [[1, 2], [2, 5]].forEach(([min, max], i) => rows.push(`('${v}', '${svc("usps", "ground_advantage")}', '${zone}', ${min}, ${max}, 'lb', ${fakePrice(zone, i + 2)})`));
  }
  await sql(`insert into public.rate_card_rows (version_id, service_id, zone, weight_min, weight_max, weight_unit, price) values ${rows.join(", ")}`);
  const chart: [string, string, string][] = [["900", "935", "2"], ["936", "961", "3"], ["962", "994", "4"], ["995", "999", "8"], ["800", "899", "5"], ["600", "799", "6"], ["300", "599", "7"], ["005", "299", "8"]];
  const zones = chart.flatMap(([from, to, zone]) => ["ups", "usps"].map((c) => `('${v}', '${c}', '900', '${from}', '${to}', '${zone}')`));
  await sql(`insert into public.rate_card_zones (version_id, carrier_code, origin_prefix, dest_prefix_from, dest_prefix_to, zone) values ${zones.join(", ")}`);
  await sql("update public.rate_card_versions set status = 'active', effective_date = '2026-01-01', row_count = $2 where id = $1", [v, rows.length]);
  const [rule] = await sql<{ id: string }>("insert into public.surcharge_rules (scope, tenant_id, carrier_code, rule_key, category, name) values ('tenant', $1, 'ups', $2, 'residential', 'Residential surcharge') returning id", [tenantId, `e2e.residential_${runId}`]);
  await sql(
    `insert into public.surcharge_rule_versions (rule_id, tenant_id, version_number, status, charge_class, method, amount, conditions, effective_date, source_reference, verification_status)
     values ($1, $2, 1, 'published', 'definite', 'flat', 5.00, '[{"type":"residential","value":true}]', '2026-01-01', 'FIXTURE: fictional amount for end-to-end tests', 'approved_3pl_config')`,
    [rule!.id, tenantId],
  );
  await sql("insert into public.brand_rate_card_assignments (tenant_id, brand_id, rate_card_id) values ($1, $2, $3)", [tenantId, brandId, card!.id]);
  return card!.id;
}

/** A brand member created without the invitation flow (covered elsewhere): sign-up, then a membership row. */
async function createBrandUser(page: Page, email: string, name: string, brandId: string, tenantId: string) {
  // Invited-style sign-up (no workspace of their own); the membership is then granted directly.
  await signUpAndConfirm(page, { name, email, next: "/accept-invite/e2e-direct-membership" });
  const [user] = await sql<{ id: string }>("select id from auth.users where email = $1", [email]);
  await sql("insert into public.memberships (user_id, tenant_id, brand_id, role_key) values ($1, $2, $3, 'brand_admin')", [user!.id, tenantId, brandId]);
  await page.context().clearCookies();
}

// ---------------------------------------------------------------------------
// 1. Setup: 3PL, customer, rate card
// ---------------------------------------------------------------------------
test("a 3PL with a customer and an assigned rate card exists", async ({ page }) => {
  await signUpAndConfirm(page, { name: "Mia Modeling", email: state.adminEmail, company: state.company });
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/app$/);
  const [tenant] = await sql<{ id: string }>("select id from public.tenants where name = $1", [state.company]);
  state.tenantId = tenant!.id;
  const [brand] = await sql<{ id: string }>("insert into public.brands (tenant_id, name) values ($1, $2) returning id", [state.tenantId, state.brandName]);
  state.brandId = brand!.id;
  const [other] = await sql<{ id: string }>("insert into public.brands (tenant_id, name) values ($1, $2) returning id", [state.tenantId, state.otherBrandName]);
  state.otherBrandId = other!.id;
  await sql("update public.tenants set default_origin_zip = '90001' where id = $1", [state.tenantId]);
  await buildRateCard(state.tenantId, state.brandId);
  await page.context().clearCookies();
  await createBrandUser(page, state.brandAdminEmail, "Bea Brand", state.brandId, state.tenantId);
  await createBrandUser(page, state.otherBrandEmail, "Otto Other", state.otherBrandId, state.tenantId);
});

// ---------------------------------------------------------------------------
// 2. The customer uploads, reviews, prepares and runs
// ---------------------------------------------------------------------------
test("the customer uploads the fixture orders file and reviews how it was read", async ({ page }) => {
  await signIn(page, state.brandAdminEmail);
  await expect(page).toHaveURL(/\/portal$/);
  await expect(page.getByText("No cost models yet")).toBeVisible();
  await page.getByRole("link", { name: "Model Costs" }).first().click();
  await expect(page.getByRole("heading", { name: "Model Costs" })).toBeVisible();
  await expect(page.getByText("No orders files yet")).toBeVisible();

  await page.getByLabel("Orders file", { exact: true }).setInputFiles(path.join(FIXTURES, "orders-generic.csv"));
  await page.getByRole("button", { name: "Upload and review" }).click();
  await expect(page).toHaveURL(/\/portal\/model\/orders\/[0-9a-f-]{36}$/);
  state.datasetId = uuid(page.url(), "orders");

  // Detected as the generic layout with the services mapped; the unknown one stays unmapped.
  await expect(page.getByRole("heading", { name: "How we read your file" })).toBeVisible();
  await expect(page.getByText("Generic orders file")).toBeVisible();
  await expect(page.getByLabel("Order id", { exact: true })).toHaveValue("0");
  await expect(page.getByLabel("Package weight", { exact: true })).toHaveValue("8");
  await expect(page.getByLabel("Shipments", { exact: true })).toHaveValue("by_shipment_id");
  await expect(page.getByRole("combobox", { name: /^"UPS Ground"/ })).not.toHaveValue("");
  await expect(page.getByRole("combobox", { name: /^"Pony Express"/ })).toHaveValue("");

  await page.getByRole("button", { name: "Save and check the file" }).click();
  await expect(page.getByRole("heading", { name: "Does this look right?" })).toBeVisible();
  // Rows, orders, shipments, packages and items are counted separately.
  await expect(page.getByText("24 orders · 25 shipments · 26 packages · 28 items from 28 rows")).toBeVisible();
  await expect(page.getByText("20 of 24 orders can be priced (83.3%)")).toBeVisible();
  // Each issue row names the problem and, behind "Where", the orders and rows it was found in.
  await expect(page.getByRole("cell", { name: /The shipping service in the file is not mapped/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: /No package weight\./ })).toBeVisible();
  await page.getByRole("cell", { name: /No package weight\./ }).getByText("Where").click();
  await expect(page.getByText(/Order A-10\d\d(, row \d+)?: No package weight/).first()).toBeVisible();
  const [ds] = await sql<{ status: string }>("select status from public.order_datasets where id = $1", [state.datasetId]);
  expect(ds?.status).toBe("validated");

  await page.getByRole("button", { name: "Looks right — prepare for modeling" }).click();
  await expect(page.getByText("Ready to model. Choose the rates below.")).toBeVisible();
  await expect(page.getByText("24 orders · 25 shipments · 26 packages, ready to model.")).toBeVisible();
  const [counts] = await sql<{ status: string; order_count: number; shipment_count: number; package_count: number; line_count: number }>("select status, order_count, shipment_count, package_count, line_count from public.order_datasets where id = $1", [state.datasetId]);
  expect(counts).toEqual({ status: "ready", order_count: 24, shipment_count: 25, package_count: 26, line_count: 28 });
});

test("the model runs at today's rates and reports coverage, exclusions and estimates honestly", async ({ page }) => {
  await signIn(page, state.brandAdminEmail);
  await expect(page).toHaveURL(/\/portal$/);
  await page.goto(`/portal/model/orders/${state.datasetId}`);
  await expect(page.getByRole("heading", { name: "Run the model" })).toBeVisible();
  await expect(page.getByLabel("Rate card", { exact: true })).toHaveValue(/[0-9a-f-]{36}/);
  await expect(page.getByLabel("Rates in effect on", { exact: true })).not.toHaveValue("");
  // The file carries residential flags and origins, so nothing has to be assumed.
  await expect(page.getByText("What the file does not say")).toHaveCount(0);
  await page.getByRole("button", { name: "Run the model" }).click();
  await expect(page).toHaveURL(/\/portal\/model\/runs\/[0-9a-f-]{36}$/);
  state.runId = uuid(page.url(), "runs");

  // Progress first, then the results once every shipment is priced.
  await expect(page.getByText("Keep this page open")).toBeVisible();
  await expect(page.getByText("Estimated shipping cost per order")).toBeVisible({ timeout: 90_000 });
  await expect(stat(page, "Orders modeled")).toHaveText("75.0%");
  await expect(page.getByText("18 of 24 orders", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Estimates, not an invoice.")).toBeVisible();
  // Every exclusion is named in plain language, with counts; the file itself is linked for fixing.
  for (const reason of ["Heavier than the rate card's top bracket", "Destination not covered by the zone chart", "Shipping service not mapped to one of your services", "No package weight", "No destination ZIP code", "Rows of the same package disagree on weight or size"]) {
    await expect(page.getByText(reason, { exact: true }).first()).toBeVisible();
  }
  await expect(page.getByRole("link", { name: "Review how the file was read" })).toHaveAttribute("href", `/portal/model/orders/${state.datasetId}`);
  // Breakdowns and the surcharge table carry rule names, never keys or ids.
  await expect(page.getByRole("heading", { name: "By service" })).toBeVisible();
  await expect(page.getByText("Residential surcharge (your 3PL)")).toBeVisible();
  await expect(page.getByText(/e2e\.residential/)).toHaveCount(0);
  // The package without dimensions was priced on actual weight and flagged.
  await expect(page.getByText("No dimensions, so dimensional weight was not checked: 1 shipment")).toBeVisible();
  // The fixture carries a residential column, so nothing about home/business delivery was assumed.
  await expect(page.getByText(/priced assuming (home|business) deliveries/)).toHaveCount(0);
  const [run] = await sql<{ status: string; modeled_orders: number; ok_shipments: number; unavailable_shipments: number; total_shipments: number }>("select status, modeled_orders, ok_shipments, unavailable_shipments, total_shipments from public.simulation_runs where id = $1", [state.runId]);
  // 25 shipments: 18 orders priced (19 shipments), 6 orders excluded (6 shipments).
  expect(run).toEqual({ status: "completed", modeled_orders: 18, ok_shipments: 19, unavailable_shipments: 6, total_shipments: 25 });

  // Shipment table pages and filters, and the customer export.
  await page.getByRole("link", { name: "Not priced" }).click();
  await expect(page.getByRole("cell", { name: "A-1020" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "A-1001" })).toHaveCount(0);
  const csv = await page.request.get(`/api/runs/${state.runId}/results.csv`);
  expect(csv.status()).toBe(200);
  const body = await csv.text();
  expect(body.startsWith("# Estimates from")).toBe(true);
  expect(body).toContain("order_id,shipment_id,ship_date,rates_of,");
  expect(body).toContain(",in_totals,reason");
  const dataLines = body.split("\r\n").filter((l) => l.startsWith("A-"));
  expect(dataLines.length).toBe(25);
  // 19 priced shipments in 18 modeled orders: every priced row is in the totals here (no order lost a sibling shipment).
  expect(dataLines.filter((l) => l.includes(",priced,yes,")).length).toBe(19);
  expect(body).not.toContain("e2e.residential");
});

test("the customer saves a single shipment as a scenario and sees it on the overview", async ({ page }) => {
  await signIn(page, state.brandAdminEmail);
  await expect(page).toHaveURL(/\/portal$/);
  await page.goto("/portal/model/calculator");
  await expect(page.getByRole("heading", { name: "Price one shipment" })).toBeVisible();
  await expect(page.getByLabel("Version", { exact: true })).toHaveCount(0); // customers never pick versions
  await page.getByLabel("Origin ZIP").fill("90001");
  await page.getByLabel("Destination ZIP").fill("85001");
  await page.getByLabel("Weight", { exact: true }).fill("3");
  // Comparing every service (the default) renders the same customer view as a single service: no keys, ids, versions or verification state.
  await page.getByRole("button", { name: "Calculate", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^Results: \d+ services$/ })).toBeVisible();
  await page.locator("summary", { hasText: "UPS Ground" }).first().click();
  await expect(page.getByText("Priced on your rate card").first()).toBeVisible();
  await expect(page.getByText(/@v\d/)).toHaveCount(0);
  await expect(page.getByText(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)).toHaveCount(0);
  await expect(page.getByText(/^Version \d+$/)).toHaveCount(0);
  await expect(page.getByText("References", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Engine", { exact: true })).toHaveCount(0);
  await page.getByLabel("Service", { exact: true }).selectOption({ label: "UPS Ground" });
  await page.getByRole("button", { name: "Calculate", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Result: UPS Ground" })).toBeVisible();
  await expect(page.getByText("Priced on your rate card")).toBeVisible();
  await expect(page.getByText(/@v\d/)).toHaveCount(0); // no rule keys for customers
  await expect(page.getByText("Engine", { exact: true })).toHaveCount(0);
  await page.getByLabel("Scenario name").fill("Typical 3 lb order to Phoenix");
  await page.getByRole("button", { name: "Save scenario" }).click();
  await expect(page.getByText("Saved. Find it under Saved scenarios.")).toBeVisible();

  await page.goto("/portal");
  await expect(page.getByText("Shipping, from your latest model")).toBeVisible();
  await expect(stat(page, "Estimated shipping cost per order")).toHaveText(/^\$\d+\.\d{2}$/);
  await expect(page.getByRole("link", { name: "Typical 3 lb order to Phoenix" })).toBeVisible();
  await page.goto("/portal/reports");
  await expect(page.getByRole("link", { name: "Compare" }).first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// 3. The 3PL on the customer's behalf; isolation
// ---------------------------------------------------------------------------
test("the 3PL sees the customer's shared models on their behalf and can price for them", async ({ page }) => {
  await signIn(page, state.adminEmail);
  await expect(page).toHaveURL(/\/app$/);
  await page.goto(`/app/customers/${state.brandId}`);
  await page.getByRole("link", { name: "Open cost models →" }).click();
  await expect(page.getByRole("heading", { name: `Model costs for ${state.brandName}` })).toBeVisible();
  await expect(page.getByText("Latest model")).toBeVisible();
  await expect(page.getByRole("link", { name: "orders-generic", exact: true })).toBeVisible();
  await page.goto(`/app/customers/${state.brandId}/model/runs/${state.runId}`);
  await expect(stat(page, "Orders modeled")).toHaveText("75.0%");
  // Staff pricing on behalf: the customer's rate card, saved results stay private until shared.
  await page.goto(`/app/customers/${state.brandId}/model/calculator`);
  await page.getByLabel("Origin ZIP").fill("90001");
  await page.getByLabel("Destination ZIP").fill("85001");
  await page.getByLabel("Service", { exact: true }).selectOption({ label: "UPS Ground" });
  await page.getByLabel("Weight", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Calculate", exact: true }).click();
  await page.getByLabel("Scenario name").fill("Staff what-if");
  await page.getByRole("button", { name: "Save scenario" }).click();
  await expect(page.getByText("Saved. Find it under Saved scenarios.")).toBeVisible();
  const [project] = await sql<{ shared_with_brand: boolean }>("select shared_with_brand from public.simulation_projects where brand_id = $1 and name = 'Staff what-if'", [state.brandId]);
  expect(project?.shared_with_brand).toBe(false);
});

test("another customer and another 3PL cannot reach the models by URL", async ({ browser }) => {
  const other = await browser.newContext({ baseURL: "http://localhost:3000" });
  const page = await other.newPage();
  await signIn(page, state.otherBrandEmail);
  await expect(page).toHaveURL(/\/portal$/);
  await expect(page.getByRole("link", { name: "Typical 3 lb order to Phoenix" })).toHaveCount(0);
  for (const p of [`/portal/model/runs/${state.runId}`, `/portal/model/orders/${state.datasetId}`]) {
    const res = await page.goto(p);
    expect(res?.status(), p).toBe(404);
    await expect(page.getByText("Orders modeled"), p).toHaveCount(0);
  }
  const csv = await page.request.get(`/api/runs/${state.runId}/results.csv`);
  expect(csv.status()).toBe(404);
  await other.close();

  const stranger = await browser.newContext({ baseURL: "http://localhost:3000" });
  const sp = await stranger.newPage();
  await signUpAndConfirm(sp, { name: "Stan Stranger", email: state.otherTenantEmail, company: `Other Fictional 3PL ${runId}` });
  await sp.getByRole("button", { name: "Create workspace" }).click();
  await expect(sp).toHaveURL(/\/app$/);
  for (const p of [`/app/customers/${state.brandId}/model`, `/app/customers/${state.brandId}/model/runs/${state.runId}`]) {
    const res = await sp.goto(p);
    expect(res?.status(), p).toBe(404);
    await expect(sp.getByText(state.brandName), p).toHaveCount(0);
  }
  await stranger.close();
});

// ---------------------------------------------------------------------------
// 4. Phone layout and automated accessibility on the customer's modeling pages
// ---------------------------------------------------------------------------
test("the customer's modeling pages fit a phone, keep tap targets at 44px and pass automated accessibility checks", async ({ browser }) => {
  const phone = await browser.newContext({ ...devices["iPhone 14"], baseURL: "http://localhost:3000" });
  const page = await phone.newPage();
  await signIn(page, state.brandAdminEmail);
  await expect(page).toHaveURL(/\/portal$/);
  const check = async (label: string) => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${label}: horizontal scroll`).toBe(true);
    const sizes = await page.locator("input:not([type=hidden]), select, textarea").evaluateAll((els) => els.map((el) => parseFloat(getComputedStyle(el).fontSize)));
    if (sizes.length) expect(Math.min(...sizes), `${label}: input font size`).toBeGreaterThanOrEqual(16);
    // A radio or checkbox is tapped through its label, so the label's box is the target.
    const smallTargets = await page.locator("button, a, input:not([type=hidden]), select, summary").evaluateAll((els) =>
      els
        .filter((el) => !el.classList.contains("sr-only"))
        .map((el) => {
          const type = (el as HTMLInputElement).type;
          const target = (type === "radio" || type === "checkbox") && el.closest("label") ? el.closest("label")! : el;
          return { el, rect: target.getBoundingClientRect() };
        })
        .filter(({ rect }) => rect.width > 0 && rect.height > 0 && rect.height < 44)
        .map(({ el }) => el.outerHTML.slice(0, 100)),
    );
    expect(smallTargets, `${label}: touch targets under 44px`).toEqual([]);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => `${label}: ${v.id} ${v.help}\n${v.nodes.map((n) => `  ${n.target.join(" ")} :: ${n.any[0]?.message ?? ""}`).join("\n")}`)).toEqual([]);
  };
  await page.goto("/portal/model");
  await expect(page.getByRole("heading", { name: "Model Costs" })).toBeVisible();
  await check("/portal/model");
  await page.goto("/portal/model/calculator");
  await page.getByLabel("Origin ZIP").fill("90001");
  await page.getByLabel("Destination ZIP").fill("85001");
  await page.getByLabel("Weight", { exact: true }).fill("3");
  await page.getByRole("button", { name: "Calculate", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^Results: \d+ services$/ })).toBeVisible();
  await page.locator("summary", { hasText: "UPS Ground" }).first().click();
  await expect(page.getByText("Priced on your rate card").first()).toBeVisible();
  await check("/portal/model/calculator (comparison expanded)");
  await page.goto(`/portal/model/orders/${state.datasetId}`);
  await expect(page.getByText("Does this look right?")).toBeVisible();
  await check("/portal/model/orders/[id]");
  await page.goto(`/portal/model/runs/${state.runId}`);
  await expect(page.getByText("Estimated shipping cost per order")).toBeVisible();
  await check("/portal/model/runs/[id]");
  await page.goto("/portal/reports");
  await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();
  await check("/portal/reports");
  await phone.close();
});
