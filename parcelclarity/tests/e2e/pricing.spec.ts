import fs from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { signIn, signUpAndConfirm, sql, uniqueEmail } from "./helpers";

// Milestone 2 end to end, as one continuous story for a fresh 3PL: a rate card is created, the
// FICTIONAL fixture rate card is imported through the wizard, service terms and a zone chart are
// set, the version is activated, surcharge rules are published, the calculator reproduces the
// independently derived golden expectations, and a brand customer is assigned the card. Then the
// negative side: another 3PL cannot reach any of it by URL, and a file that is not a rate card is
// refused without creating a version. None of the amounts are real carrier rates.
test.describe.configure({ mode: "serial" });

// ---------------------------------------------------------------------------
// Fixtures and golden data (never edited here; see tests/fixtures/pricing)
// ---------------------------------------------------------------------------
const FIXTURES = path.resolve(__dirname, "../fixtures/pricing");

interface GoldenLine {
  label: string;
  packageIndex: number | null;
  amount: string;
  counted: boolean;
  chargeClass: "definite" | "estimated" | "conditional";
}
interface Golden {
  status: "ok" | "unavailable";
  unavailableReason: string | null;
  zone: string | null;
  packages: { index: number; billableLb: string; basis: string }[];
  lines: GoldenLine[];
  totals: { definite: string; estimated: string; expected: string; conditionalExposure: string };
  warnings: string[];
}
interface ScenarioPackage {
  weight: string;
  weightUnit: "lb" | "oz";
  length?: string;
  width?: string;
  height?: string;
}
interface Scenario {
  id: string;
  context: Record<string, unknown>;
  input: {
    shipDate: string;
    originZip: string;
    destinationZip?: string;
    destinationZone?: string;
    residential: boolean;
    carrierCode: string;
    serviceCode: string;
    packages: ScenarioPackage[];
  };
}

const expectedJson = JSON.parse(fs.readFileSync(path.join(FIXTURES, "expected.json"), "utf8")) as Record<string, Golden | string>;
const scenariosJson = JSON.parse(fs.readFileSync(path.join(FIXTURES, "scenarios.json"), "utf8")) as { scenarios: Scenario[] };

function scenario(id: string): { input: Scenario["input"]; golden: Golden } {
  const s = scenariosJson.scenarios.find((x) => x.id === id);
  const g = expectedJson[id];
  if (!s || !g || typeof g === "string") throw new Error(`Scenario ${id} is missing from the fixtures`);
  return { input: s.input, golden: g };
}

/** The fixture rules the UI reproduces for these scenarios (fictional amounts from fixture-rules.json). */
const RULES = {
  residential: { name: "Residential surcharge", amount: "5.00" },
  fuel: { name: "Fuel surcharge", percent: "15.50", categories: ["Residential delivery", "Delivery area (DAS)", "Extended delivery area", "Additional handling", "Oversize / large package", "Peak / demand"] },
  addressCorrection: { name: "Address correction (if needed)", amount: "21.00" },
};
const CLASS_LABEL: Record<GoldenLine["chargeClass"], string> = { definite: "Definite", estimated: "Estimated", conditional: "Conditional" };
const SOURCE = "FIXTURE: fictional amount for end-to-end tests, not a real carrier rate";
const EFFECTIVE = "2026-01-01"; // covers every fixture ship date regardless of the day the suite runs
const money = (amount: string) => `$${amount}`;

// ---------------------------------------------------------------------------
// Shared state across the serial story
// ---------------------------------------------------------------------------
const runId = uniqueEmail("run").slice(4, 12);
const state = {
  company: `Fictional Fulfillment ${runId}`,
  adminEmail: uniqueEmail("pricing-admin"),
  otherAdminEmail: uniqueEmail("pricing-other"),
  cardName: `Fictional Test Card ${runId}`,
  brandName: `Zeta Fictional Goods ${runId}`,
  rateCardId: "",
  importId: "",
  versionId: "",
  ruleIds: {} as Record<keyof typeof RULES, string>,
  brandPath: "",
};

interface ServiceRow {
  id: string;
  carrier_code: string;
  code: string;
}
const catalog: Record<string, string> = {};

const exactly = (label: string) => new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
/** The big number of a <Stat label="…"> card. */
const stat = (page: Page, label: string): Locator => page.locator("p", { hasText: exactly(label) }).locator("xpath=following-sibling::p[1]");
/** The value of a labelled <dt>/<dd> pair in a result card. */
const detail = (page: Page, label: string): Locator => page.locator("dt", { hasText: exactly(label) }).locator("xpath=following-sibling::dd[1]");

const uuid = (url: string, after: string) => {
  const m = new RegExp(`${after}/([0-9a-f-]{36})`).exec(url);
  if (!m?.[1]) throw new Error(`No id after ${after} in ${url}`);
  return m[1];
};

test.beforeAll(async () => {
  const rows = await sql<ServiceRow>("select id, carrier_code, code from public.shipping_services where (carrier_code, code) in (('ups','ground'), ('ups','second_day_air'), ('usps','ground_advantage'))");
  for (const r of rows) catalog[`${r.carrier_code}/${r.code}`] = r.id;
  expect(Object.keys(catalog)).toHaveLength(3);
});

// ---------------------------------------------------------------------------
// 1. Rate card + import wizard
// ---------------------------------------------------------------------------
test("a 3PL admin creates a rate card and imports the fixture file through the wizard", async ({ page }) => {
  test.slow();
  await signUpAndConfirm(page, { name: "Pricing Pat", email: state.adminEmail, company: state.company });
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/app$/);

  await page.getByRole("link", { name: "Rate cards" }).first().click();
  await expect(page.getByRole("heading", { name: "Rate cards", exact: true })).toBeVisible();
  await expect(page.getByText("No rate cards yet")).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill(state.cardName);
  await page.getByLabel("Description (optional)").fill("Fictional rates for the end-to-end suite");
  await page.getByRole("button", { name: "Create rate card" }).click();
  await expect(page).toHaveURL(/\/app\/rate-cards\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: state.cardName })).toBeVisible();
  await expect(page.getByText("No versions yet")).toBeVisible();
  state.rateCardId = uuid(page.url(), "rate-cards");

  // Step 1: upload.
  await page.getByRole("link", { name: "Import a new version" }).click();
  await expect(page.getByRole("heading", { name: "Import rates", exact: true })).toBeVisible();
  await page.getByLabel("Rate file").setInputFiles(path.join(FIXTURES, "fixture-rate-card.csv"));
  await page.getByRole("button", { name: "Upload and detect columns" }).click();
  await expect(page).toHaveURL(/\/import\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "Review import" })).toBeVisible();
  state.importId = uuid(page.url(), "import");

  // Step 2: the detected mapping is right, so the administrator confirms it as proposed.
  await expect(page.getByLabel("File layout")).toHaveValue("long");
  await expect(page.getByLabel("Service", { exact: true })).toHaveValue("1");
  await expect(page.getByLabel("Zone", { exact: true })).toHaveValue("3");
  await expect(page.getByLabel("Weight to")).toHaveValue("5");
  await expect(page.getByLabel("Price", { exact: true })).toHaveValue("7");
  await expect(page.getByLabel("Weight unit (optional)")).toHaveValue("6");
  await expect(page.getByText("high match")).toHaveCount(3);
  await expect(page.getByRole("combobox", { name: /^UPS Ground/ })).toHaveValue(catalog["ups/ground"]!);
  await expect(page.getByRole("combobox", { name: /^UPS 2nd Day Air/ })).toHaveValue(catalog["ups/second_day_air"]!);
  await expect(page.getByRole("combobox", { name: /^USPS Ground Advantage/ })).toHaveValue(catalog["usps/ground_advantage"]!);
  await page.getByRole("button", { name: "Validate", exact: true }).click();

  // Step 3: review. Every row validates; the only warnings are the missing DIM divisors.
  await expect(page.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
  await expect(page.getByText("The file validates")).toBeVisible();
  await expect(stat(page, "Rate rows")).toHaveText("1,852");
  await expect(stat(page, "Errors")).toHaveText("0");
  await expect(page.getByText("DIM divisor missing")).toHaveCount(3);
  for (const name of ["UPS Ground", "UPS 2nd Day Air", "USPS Ground Advantage"]) await expect(page.getByRole("listitem").filter({ hasText: name }).first()).toBeVisible();

  await page.getByRole("button", { name: "Create draft version" }).click();
  await expect(page).toHaveURL(/\/versions\/[0-9a-f-]{36}$/, { timeout: 45_000 });
  state.versionId = uuid(page.url(), "versions");
  await expect(page.getByRole("heading", { name: "Version 1", exact: true })).toBeVisible();
  await expect(page.getByText("This is a draft")).toBeVisible();
  await expect(stat(page, "Rate rows")).toHaveText("1,852");
  await expect(stat(page, "Services")).toHaveText("3");
  await expect(page.getByText("No zone chart on this version")).toBeVisible();

  const [version] = await sql<{ status: string; row_count: number; rows: number; terms: number }>(
    "select v.status, v.row_count, (select count(*)::int from public.rate_card_rows r where r.version_id = v.id) as rows, (select count(*)::int from public.rate_card_service_terms t where t.version_id = v.id) as terms from public.rate_card_versions v where v.id = $1",
    [state.versionId],
  );
  expect(version).toMatchObject({ status: "draft", row_count: 1852, rows: 1852, terms: 3 });
  const [imp] = await sql<{ status: string; version_id: string }>("select status, version_id from public.rate_card_imports where id = $1", [state.importId]);
  expect(imp).toEqual({ status: "imported", version_id: state.versionId });
});

// ---------------------------------------------------------------------------
// 2. Service terms, zone chart, activation
// ---------------------------------------------------------------------------
test("the draft gets service terms and a zone chart, then is activated", async ({ page }) => {
  await signIn(page, state.adminEmail);
  await expect(page).toHaveURL(/\/app$/);
  await page.goto(`/app/rate-cards/${state.rateCardId}/versions/${state.versionId}`);
  await expect(page.getByRole("heading", { name: "Version 1", exact: true })).toBeVisible();

  // Terms for UPS Ground as the fixture states them: divisor 139, whole-pound rounding, $8.50 minimum.
  const ground = page.locator("form").filter({ has: page.locator(`input[name="serviceId"][value="${catalog["ups/ground"]}"]`) });
  await expect(ground.getByLabel("DIM divisor", { exact: true })).toHaveValue("");
  await ground.getByLabel("DIM divisor", { exact: true }).fill("139");
  await ground.getByLabel("Dimension rounding").selectOption({ label: "Nearest whole inch" });
  await ground.getByLabel("Billable weight rounding").selectOption({ label: "Up to the next whole pound" });
  await ground.getByLabel("Minimum charge (USD)").fill("8.50");
  await ground.getByRole("button", { name: "Save terms" }).click();
  await expect(ground.getByText("Saved.")).toBeVisible();
  await expect(page.getByText("DIM divisor 139")).toBeVisible();
  const [terms] = await sql<{ divisor_ok: boolean; weight_rounding: string; min_ok: boolean }>(
    "select dim_divisor = 139 as divisor_ok, weight_rounding, min_charge = 8.50 as min_ok from public.rate_card_service_terms where version_id = $1 and service_id = $2",
    [state.versionId, catalog["ups/ground"]],
  );
  expect(terms).toEqual({ divisor_ok: true, weight_rounding: "up_whole_lb", min_ok: true });

  // Zone chart from the fixture (18 rows).
  await page.getByLabel("Zone chart file").setInputFiles(path.join(FIXTURES, "fixture-zone-chart.csv"));
  await page.getByRole("button", { name: "Upload zone chart" }).click();
  await expect(page.getByText("Zone chart replaced: 18 rows.")).toBeVisible();
  await expect(stat(page, "Zone chart entries")).toHaveText("18");
  await expect(page.getByRole("table", { name: "Zone chart sample" })).toBeVisible();
  await expect(page.getByText("No zone chart on this version")).toHaveCount(0);
  expect((await sql<{ n: number }>("select count(*)::int as n from public.rate_card_zones where version_id = $1", [state.versionId]))[0]?.n).toBe(18);

  // Activation locks the terms and puts the prices into effect from a date that covers the golden ship dates.
  await page.getByLabel("Effective date").fill(EFFECTIVE);
  await page.getByRole("button", { name: "Activate version" }).click();
  // The activation card is replaced by the active state: locked terms, an "end this version" card, the activation time.
  await expect(page.getByText("Locked because the version is no longer a draft.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "End this version" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Activate this version" })).toHaveCount(0);
  await expect(page.getByText("This is a draft")).toHaveCount(0);
  await expect(page.getByText("Effective Jan 1, 2026")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save terms" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Test in calculator" })).toBeVisible();
  const [active] = await sql<{ status: string; effective_date: string; expiration_date: string | null }>("select status, effective_date::text, expiration_date::text from public.rate_card_versions where id = $1", [state.versionId]);
  expect(active).toEqual({ status: "active", effective_date: EFFECTIVE, expiration_date: null });

  await page.goto("/app/rate-cards");
  const row = page.getByRole("listitem").filter({ hasText: state.cardName });
  await expect(row.getByText("In effect", { exact: true })).toBeVisible();
  await expect(row.getByText("Version 1 in effect · From Jan 1, 2026, no end date")).toBeVisible();
  await expect(row.getByText("0 customers")).toBeVisible();
});

// ---------------------------------------------------------------------------
// 3. Surcharge rules
// ---------------------------------------------------------------------------
async function createRule(
  page: Page,
  rule: { name: string; category: string; chargeClass?: "definite" | "conditional"; flat?: string; percent?: string; baseCategories?: string[]; residentialOnly?: boolean; perShipment?: boolean },
): Promise<string> {
  await page.goto("/app/surcharges/new");
  await expect(page.getByRole("heading", { name: "New surcharge rule" })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill(rule.name);
  await page.getByLabel("Carrier", { exact: true }).selectOption({ label: "UPS" });
  await page.getByLabel("Category", { exact: true }).selectOption(rule.category);
  await page.getByLabel("Charge class").selectOption(rule.chargeClass ?? "definite");
  if (rule.percent !== undefined) {
    await page.getByLabel("How it is calculated").selectOption("percent");
    await page.getByLabel("Percentage", { exact: true }).fill(rule.percent);
    await page.getByLabel("Applied to").selectOption("base_plus_categories");
    const group = page.getByRole("group", { name: "Surcharge categories included in the base" });
    for (const label of rule.baseCategories ?? []) await group.getByLabel(label, { exact: true }).check();
  } else {
    await page.getByLabel("How it is calculated").selectOption("flat");
    await page.getByLabel("Amount (USD)").fill(rule.flat ?? "");
  }
  if (rule.perShipment) await page.getByLabel("Charge once per package").uncheck();
  if (rule.residentialOnly) {
    await page.getByRole("button", { name: "Add condition" }).click();
    await expect(page.getByLabel("Condition", { exact: true })).toHaveValue("residential");
    await expect(page.getByLabel("Address type")).toHaveValue("true");
    await expect(page.getByText("Delivery address is residential", { exact: true })).toBeVisible();
  }
  await page.getByLabel("Effective from").fill(EFFECTIVE);
  await page.getByLabel("Source reference").fill(SOURCE);
  await page.getByRole("button", { name: "Create rule" }).click();
  await expect(page).toHaveURL(/\/app\/surcharges\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: rule.name })).toBeVisible();
  await expect(page.getByText("Nothing is published yet.")).toBeVisible();
  await expect(page.getByText("draft", { exact: true })).toBeVisible();

  // Drafts never price anything; publishing is an explicit, confirmed step.
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByRole("group", { name: "Confirm: Publish" }).getByRole("button", { name: "Publish version" }).click();
  await expect(page.getByText("In effect today")).toBeVisible();
  await expect(page.getByText("published", { exact: true })).toBeVisible();
  await expect(page.getByText("Nothing is published yet.")).toHaveCount(0);
  return uuid(page.url(), "surcharges");
}

test("the 3PL creates and publishes its residential, fuel and address-correction rules", async ({ page }) => {
  test.slow();
  await signIn(page, state.adminEmail);
  await expect(page).toHaveURL(/\/app$/);
  await page.goto("/app/surcharges");
  await expect(page.getByText("No rules yet")).toBeVisible();
  await expect(stat(page, "Rules in effect today")).toHaveText("0");

  state.ruleIds.residential = await createRule(page, { name: RULES.residential.name, category: "residential", flat: RULES.residential.amount, residentialOnly: true });
  state.ruleIds.fuel = await createRule(page, { name: RULES.fuel.name, category: "fuel", percent: RULES.fuel.percent, baseCategories: RULES.fuel.categories });
  state.ruleIds.addressCorrection = await createRule(page, { name: RULES.addressCorrection.name, category: "address_correction", chargeClass: "conditional", flat: RULES.addressCorrection.amount, perShipment: true });

  const rows = await sql<{ id: string; rule_key: string; carrier_code: string; scope: string; status: string; verification_status: string; percent: string | null; amount: string | null }>(
    "select r.id, r.rule_key, r.carrier_code, r.scope, v.status, v.verification_status, v.percent::text, v.amount::text from public.surcharge_rules r join public.surcharge_rule_versions v on v.rule_id = r.id where r.id = any($1::uuid[]) order by r.rule_key",
    [Object.values(state.ruleIds)],
  );
  expect(rows).toHaveLength(3);
  for (const r of rows) expect(r).toMatchObject({ carrier_code: "ups", scope: "tenant", status: "published", verification_status: "approved_3pl_config" });
  expect(rows.find((r) => r.id === state.ruleIds.fuel)?.percent).toBe("15.5000");
  expect(rows.find((r) => r.id === state.ruleIds.residential)?.amount).toBe("5.0000");

  await page.goto("/app/surcharges");
  await expect(stat(page, "Rules in effect today")).toHaveText("3");
  for (const r of Object.values(RULES)) await expect(page.getByRole("listitem").filter({ hasText: r.name }).getByText("In effect today")).toBeVisible();
});

// ---------------------------------------------------------------------------
// 4. Calculator against the golden expectations
// ---------------------------------------------------------------------------
async function fillShipment(page: Page, input: Scenario["input"]) {
  await page.getByLabel("Ship date").fill(input.shipDate);
  await page.getByLabel("Origin ZIP").fill(input.originZip);
  const destination = page.getByRole("group", { name: "Destination" });
  if (input.destinationZip) {
    await destination.getByText("ZIP", { exact: true }).click();
    await page.getByLabel("Destination ZIP").fill(input.destinationZip);
  } else {
    await destination.getByText("Zone", { exact: true }).click();
    await page.getByLabel("Destination zone").fill(input.destinationZone ?? "");
  }
  const residential = page.getByRole("switch", { name: "Residential address" });
  if ((await residential.isChecked()) !== input.residential) await page.getByText("Residential address", { exact: true }).click();
  await expect(residential).toBeChecked({ checked: input.residential });
  expect(input.packages).toHaveLength(1);
  const pkg = input.packages[0]!;
  await page.getByLabel("Weight", { exact: true }).fill(pkg.weight);
  await page.getByLabel("Unit", { exact: true }).selectOption(pkg.weightUnit);
  await page.getByLabel("Length (in)").fill(pkg.length ?? "");
  await page.getByLabel("Width (in)").fill(pkg.width ?? "");
  await page.getByLabel("Height (in)").fill(pkg.height ?? "");
}

async function expectGoldenResult(page: Page, golden: Golden, ruleKeys: string[]) {
  await expect(page.getByRole("heading", { name: "Result: UPS Ground" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Version 1", { exact: true })).toBeVisible();
  await expect(page.getByText("No price available")).toHaveCount(0);
  await expect(stat(page, "Expected shipping cost")).toHaveText(money(golden.totals.expected));
  await expect(stat(page, "Definite")).toHaveText(money(golden.totals.definite));
  await expect(stat(page, "Estimated")).toHaveText(money(golden.totals.estimated));
  await expect(stat(page, "Possible adjustments")).toHaveText(money(golden.totals.conditionalExposure));
  await expect(page.getByText("Estimates are based on the published rate card")).toBeVisible();

  // Zone from the uploaded chart, billable weight with its basis.
  await expect(page.getByText(`Zone ${golden.zone}`, { exact: true })).toBeVisible();
  await expect(page.getByText("From the rate card zone chart", { exact: true })).toBeVisible();
  const billable = golden.packages[0]!;
  await expect(detail(page, "Billable")).toHaveText(`${billable.billableLb.replace(/\.0+$/, "")} lb`);
  await expect(page.getByText(billable.basis === "dim" ? "Dimensional weight" : "Actual weight", { exact: true })).toBeVisible();

  // Every golden line, with its amount, class and whether it counts.
  const charges = page.getByRole("region", { name: "Itemized charges" });
  await expect(charges.getByRole("listitem")).toHaveCount(golden.lines.length);
  for (const line of golden.lines) {
    const row = charges.getByRole("listitem").filter({ hasText: line.label });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(money(line.amount));
    await expect(row.getByText(CLASS_LABEL[line.chargeClass], { exact: true })).toBeVisible();
    if (line.counted) await expect(row).not.toContainText("(not counted)");
    else await expect(row).toContainText("(not counted)");
    if (line.chargeClass === "conditional") await expect(row.getByText("Only if it occurs after shipping")).toBeVisible();
  }
  await expect(page.getByRole("region", { name: "Warnings" })).toHaveCount(golden.warnings.length ? 1 : 0);
  const references = page.getByRole("region", { name: "References" });
  for (const key of ruleKeys) await expect(references.getByText(`${key}@v1`)).toBeVisible();
  await expect(references.getByText("Approved 3PL configuration")).toHaveCount(ruleKeys.length);
}

test("the calculator reproduces the golden scenarios and is honest when no rate exists", async ({ page }) => {
  test.slow();
  await signIn(page, state.adminEmail);
  await expect(page).toHaveURL(/\/app$/);
  await page.getByRole("link", { name: "Calculator" }).first().click();
  await expect(page.getByRole("heading", { name: "Calculator", exact: true })).toBeVisible();
  await expect(page.getByLabel("Rate card", { exact: true }).locator("option:checked")).toHaveText(state.cardName);
  await expect(page.getByLabel("Version", { exact: true })).toHaveValue("");
  await page.getByLabel("Service", { exact: true }).selectOption({ label: "UPS Ground" });
  const keys = (await sql<{ rule_key: string }>("select rule_key from public.surcharge_rules where id = any($1::uuid[])", [Object.values(state.ruleIds)])).map((r) => r.rule_key);
  expect(keys).toHaveLength(3);

  // Residential delivery: base, residential, fuel on both, address correction as exposure only.
  const residential = scenario("ground_residential");
  await fillShipment(page, residential.input);
  await page.getByRole("button", { name: "Calculate", exact: true }).click();
  await expectGoldenResult(page, residential.golden, keys);

  // Minimum charge: the bracket price is below the service minimum set in the terms.
  const minimum = scenario("ground_minimum_charge");
  await fillShipment(page, minimum.input);
  await page.getByRole("button", { name: "Calculate", exact: true }).click();
  await expectGoldenResult(page, minimum.golden, keys.filter((k) => !k.includes("residential")));

  // A zone the card does not carry: unavailable with the reason, no extrapolation, no totals.
  const unavailable = scenario("unavailable_zone_not_on_card");
  await fillShipment(page, unavailable.input);
  await page.getByRole("button", { name: "Calculate", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Result: UPS Ground" })).toBeVisible();
  const alert = page.getByRole("status").filter({ hasText: "No price available" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("No rate for this zone");
  await expect(alert).toContainText(unavailable.golden.unavailableReason ?? "");
  await expect(page.getByText("Expected shipping cost")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Itemized charges" })).toHaveCount(0);

  // Each calculation is recorded in the activity log against the version used.
  const logged = await sql<{ n: number }>("select count(*)::int as n from public.audit_events where action = 'simulation.single_shipment' and entity_id = $1", [state.versionId]);
  expect(logged[0]?.n).toBe(3);
});

// ---------------------------------------------------------------------------
// 5. Brand assignment
// ---------------------------------------------------------------------------
test("a brand customer is assigned the rate card and the assignment shows on both sides", async ({ page }) => {
  await signIn(page, state.adminEmail);
  await expect(page).toHaveURL(/\/app$/);
  await page.getByRole("link", { name: "Customers" }).first().click();
  await page.getByLabel("Brand name").fill(state.brandName);
  await page.getByRole("button", { name: "Add customer" }).click();
  await expect(page.getByRole("heading", { name: state.brandName })).toBeVisible();
  state.brandPath = new URL(page.url()).pathname;

  await expect(page.getByText("No rate cards assigned")).toBeVisible();
  await page.getByLabel("Rate card", { exact: true }).selectOption({ label: state.cardName });
  await page.getByRole("button", { name: "Assign rate card" }).click();
  // The assign form gives way to the assignment itself (the only active card is now taken).
  const assigned = page.getByRole("listitem").filter({ hasText: state.cardName });
  await expect(assigned).toHaveCount(1);
  await expect(assigned.getByRole("link", { name: state.cardName })).toBeVisible();
  await expect(assigned.getByText("All services on the card")).toBeVisible();
  await expect(assigned.getByText("active", { exact: true })).toBeVisible();
  await expect(assigned.getByRole("button", { name: "Unassign" })).toBeVisible();
  await expect(page.getByText("No rate cards assigned")).toHaveCount(0);
  await expect(page.getByText("Every active rate card is already assigned to this customer.")).toBeVisible();

  const brandId = state.brandPath.split("/").pop();
  const assignments = await sql<{ n: number }>("select count(*)::int as n from public.brand_rate_card_assignments where brand_id = $1 and rate_card_id = $2 and unassigned_at is null and allowed_service_ids is null", [brandId, state.rateCardId]);
  expect(assignments[0]?.n).toBe(1);

  // The rate card page lists the customer; the index counts it.
  await page.goto(`/app/rate-cards/${state.rateCardId}`);
  const customerRow = page.getByRole("listitem").filter({ hasText: state.brandName });
  await expect(customerRow.getByRole("link", { name: state.brandName })).toBeVisible();
  await expect(customerRow.getByText("All services on the card")).toBeVisible();
  await expect(page.getByText("No customers assigned")).toHaveCount(0);
  await page.goto("/app/rate-cards");
  await expect(page.getByRole("listitem").filter({ hasText: state.cardName }).getByText("1 customer")).toBeVisible();
});

// ---------------------------------------------------------------------------
// 6. Another tenant cannot reach any of it by URL
// ---------------------------------------------------------------------------
test("an unrelated 3PL admin gets not-found pages for the first tenant's pricing URLs", async ({ browser }) => {
  const other = await browser.newContext({ baseURL: "http://localhost:3000" });
  const page = await other.newPage();
  await signUpAndConfirm(page, { name: "Olive Other", email: state.otherAdminEmail, company: `Other Fictional 3PL ${runId}` });
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/app$/);

  const paths = [
    `/app/rate-cards/${state.rateCardId}`,
    `/app/rate-cards/${state.rateCardId}/import`,
    `/app/rate-cards/${state.rateCardId}/import/${state.importId}`,
    `/app/rate-cards/${state.rateCardId}/versions/${state.versionId}`,
    ...Object.values(state.ruleIds).map((id) => `/app/surcharges/${id}`),
    state.brandPath,
  ];
  for (const p of paths) {
    const res = await page.goto(p);
    expect(res?.status(), p).toBe(404);
    await expect(page.getByText(state.cardName), p).toHaveCount(0);
    await expect(page.getByText(state.brandName), p).toHaveCount(0);
    await expect(page.getByText("1,852"), p).toHaveCount(0);
  }

  // Their own lists are honestly empty: nothing of the other tenant leaks into them.
  await page.goto("/app/rate-cards");
  await expect(page.getByText("No rate cards yet")).toBeVisible();
  await page.goto(`/app/calculator?rateCardId=${state.rateCardId}&versionId=${state.versionId}`);
  await expect(page.getByText("No rate cards to price against")).toBeVisible();
  await expect(page.getByText(state.cardName)).toHaveCount(0);
  await page.goto("/app/surcharges");
  await expect(page.getByText("No rules yet")).toBeVisible();
  for (const r of Object.values(RULES)) await expect(page.getByText(r.name)).toHaveCount(0);
  await other.close();
});

// ---------------------------------------------------------------------------
// 7. A file that is not a rate card
// ---------------------------------------------------------------------------
test("a text file that is not a rate card is refused honestly and creates no version", async ({ page }) => {
  await signIn(page, state.adminEmail);
  await expect(page).toHaveURL(/\/app$/);
  await page.goto(`/app/rate-cards/${state.rateCardId}/import`);
  await expect(page.getByRole("heading", { name: "Import rates", exact: true })).toBeVisible();

  // Wrong file type: refused at upload with the reason, nothing stored.
  await page.getByLabel("Rate file").setInputFiles({ name: "rates.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 this is not a spreadsheet") });
  await page.getByRole("button", { name: "Upload and detect columns" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Only .csv and .xlsx files are supported." })).toBeVisible();
  await expect(page).toHaveURL(/\/import$/);

  // A text file whose columns look right but whose content is not a rate card: validation names every problem.
  const notes = ["service,zone,weight,price", "Not a rate card,n/a,heavy,free", "Still not a rate card,?,?,?", ""].join("\n");
  await page.getByLabel("Rate file").setInputFiles({ name: "not-a-rate-card.txt", mimeType: "text/plain", buffer: Buffer.from(notes) });
  await page.getByRole("button", { name: "Upload and detect columns" }).click();
  await expect(page).toHaveURL(/\/import\/[0-9a-f-]{36}$/);
  const badImportId = uuid(page.url(), "import");
  expect(badImportId).not.toBe(state.importId);
  await expect(page.getByText("not-a-rate-card.txt · CSV · 1 sheet")).toBeVisible();
  await expect(page.getByText("unmapped", { exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "Validate", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Fix the errors, then validate again" })).toBeVisible();
  await expect(stat(page, "Errors")).toHaveText("2");
  await expect(page.getByText('Service "Not a rate card" is not mapped to a known service.')).toBeVisible();
  await expect(page.getByText('Service "Still not a rate card" is not mapped to a known service.')).toBeVisible();
  await expect(page.getByText("The file validates")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create draft version" })).toBeDisabled();
  await expect(page.getByText("Resolve the errors above first.")).toBeVisible();

  const [imp] = await sql<{ status: string; version_id: string | null }>("select status, version_id from public.rate_card_imports where id = $1", [badImportId]);
  expect(imp).toEqual({ status: "mapped", version_id: null });
  const versions = await sql<{ id: string; status: string }>("select id, status from public.rate_card_versions where rate_card_id = $1", [state.rateCardId]);
  expect(versions).toEqual([{ id: state.versionId, status: "active" }]);

  // Discarding leaves the rate card untouched.
  await page.getByRole("button", { name: "Discard import" }).click();
  await page.getByRole("group", { name: "Confirm: Discard import" }).getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.getByText("This import was discarded")).toBeVisible();
  expect((await sql<{ status: string }>("select status from public.rate_card_imports where id = $1", [badImportId]))[0]?.status).toBe("discarded");
  expect((await sql<{ n: number }>("select count(*)::int as n from public.rate_card_versions where rate_card_id = $1", [state.rateCardId]))[0]?.n).toBe(1);
  await page.goto(`/app/rate-cards/${state.rateCardId}`);
  await expect(page.getByText("Imports in progress")).toHaveCount(0);
  await expect(page.getByRole("listitem").filter({ hasText: "Version 1" }).getByText("In effect today")).toBeVisible();
});
