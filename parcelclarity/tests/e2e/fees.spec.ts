import fs from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { saveSharedState, signIn, signUpAndConfirm, sql, uniqueEmail } from "./helpers";
import { expectNoHorizontalScroll, expectNoSeriousViolations } from "./screen-checks";

// Milestone 4 end to end, as one story with FICTIONAL data. A 3PL builds a fee schedule rule by rule in the
// editor, tries an order, activates it for a date and assigns it to a customer. The customer uploads the
// orders fixture, answers the fulfillment questions (a number, "not sure", "we don't use this"), runs the model,
// and reads order fees, monthly charges, the account minimum and what is not included, with the headline label
// that says what is left out. A second run with receiving answered completes the label. The customer then
// forecasts from assumptions and compares the forecast with the file run. The 3PL sees the same on the
// customer's behalf; another customer and another 3PL get nothing by URL. Every amount is made up for the test.
test.describe.configure({ mode: "serial" });

const FIXTURES = path.resolve(__dirname, "../fixtures/modeling");
const rid = uniqueEmail("m4").slice(3, 11);

/** Everything the 3PL types as a key, a group name or a staff note. None of it may reach a customer page or export. */
const KEYS = {
  pick: `k${rid}_pick`,
  addl: `k${rid}_addl`,
  box: `k${rid}_box`,
  mailer: `k${rid}_mailer`,
  other: `k${rid}_other`,
  handling: `k${rid}_handling`,
  storage: `k${rid}_storage`,
  longTerm: `k${rid}_longterm`,
  receiving: `k${rid}_receiving`,
  returns: `k${rid}_returns`,
  admin: `k${rid}_admin`,
  minimum: `k${rid}_minimum`,
  qStorage: `q${rid}_pallets`,
  qLongTerm: `q${rid}_longterm`,
  qReceiving: `q${rid}_received`,
  qReturns: `q${rid}_returns`,
  group: `g${rid}_pack`,
};
const NOTES_SENTINEL = `NOTES-SENTINEL-${rid}-never-shown-to-customers`;
const SOURCE_SENTINEL = `SOURCE-SENTINEL-${rid}-contract-clause-9`;

const state = {
  company: `Fictional Fulfillment ${rid}`,
  adminEmail: uniqueEmail("m4-admin"),
  brandAdminEmail: uniqueEmail("m4-brand"),
  otherBrandEmail: uniqueEmail("m4-other-brand"),
  otherTenantEmail: uniqueEmail("m4-other-3pl"),
  brandName: `Zeta Fictional Goods ${rid}`,
  otherBrandName: `Omega Fictional Goods ${rid}`,
  cardName: `Fictional Test Card ${rid}`,
  scheduleName: `Standard fulfillment ${rid}`,
  scheduleDescription: `Pick, pack, storage and account fees ${rid}`,
  tenantId: "",
  brandId: "",
  otherBrandId: "",
  scheduleId: "",
  versionId: "",
  draftVersionId: "",
  datasetId: "",
  cleanDatasetId: "",
  cleanRunId: "",
  runId: "",
  secondRunId: "",
  forecastId: "",
  forecastName: `1,200 a month, zones 2 and 4 ${rid}`,
};

const exactly = (label: string) => new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
const uuid = (url: string, after: string) => {
  const m = new RegExp(`${after}/([0-9a-f-]{36})`).exec(url);
  if (!m?.[1]) throw new Error(`No id after ${after} in ${url}`);
  return m[1];
};
/** The big number of a <Stat label="…"> card. */
const stat = (page: Page, label: string | RegExp): Locator => page.locator("p", { hasText: typeof label === "string" ? exactly(label) : label }).locator("xpath=following-sibling::p[1]");
const label = (page: Page | Locator, text: string) => page.getByLabel(text, { exact: true });

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
  const [rule] = await sql<{ id: string }>("insert into public.surcharge_rules (scope, tenant_id, carrier_code, rule_key, category, name) values ('tenant', $1, 'ups', $2, 'residential', 'Residential surcharge') returning id", [tenantId, `e2e.residential_m4_${rid}`]);
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
  await signUpAndConfirm(page, { name, email, next: "/accept-invite/e2e-direct-membership" });
  const [user] = await sql<{ id: string }>("select id from auth.users where email = $1", [email]);
  await sql("insert into public.memberships (user_id, tenant_id, brand_id, role_key) values ($1, $2, $3, 'brand_admin')", [user!.id, tenantId, brandId]);
  await page.context().clearCookies();
}

/** Signs in and waits until the app has landed on the person's home page, so a following navigation cannot cancel the sign-in. */
async function signInAs(page: Page, email: string, home: RegExp) {
  await signIn(page, email);
  await expect(page).toHaveURL(home);
}
const asStaff = (page: Page) => signInAs(page, state.adminEmail, /\/app$/);
const asBrand = (page: Page) => signInAs(page, state.brandAdminEmail, /\/portal$/);

function persist() {
  saveSharedState("fees", { ...state, rid, keys: KEYS, notesSentinel: NOTES_SENTINEL, sourceSentinel: SOURCE_SENTINEL });
}

// ---------------------------------------------------------------------------
// 0. Setup: 3PL, customers, rate card (the pricing import is covered by pricing.spec.ts)
// ---------------------------------------------------------------------------
test("a 3PL with two customers and an assigned rate card exists", async ({ page }) => {
  await signUpAndConfirm(page, { name: "Fay Fees", email: state.adminEmail, company: state.company });
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
  persist();
});

// ---------------------------------------------------------------------------
// 1. The 3PL builds, tries, activates and assigns a fee schedule
// ---------------------------------------------------------------------------
interface RuleSpec {
  /** The preset to start from; "Start from scratch" when absent. */
  preset?: string;
  name: string;
  key: string;
  amountLabel?: string;
  amount?: string;
  /** Anything else to do in the open form before saving. */
  extra?: (page: Page) => Promise<void>;
}

async function addRule(page: Page, r: RuleSpec) {
  await page.getByRole("button", { name: "Add rule", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Add a rule" })).toBeVisible();
  if (r.preset) await label(page, "Preset").selectOption({ label: r.preset });
  await label(page, "Name").fill(r.name);
  await label(page, "Key (staff only)").fill(r.key);
  if (r.amountLabel && r.amount) await label(page, r.amountLabel).fill(r.amount);
  await r.extra?.(page);
  await page.getByRole("button", { name: "Save rule" }).click();
  // The editor closes once the rule is saved and the rule appears in the list.
  await expect(page.getByRole("button", { name: `Edit: ${r.name}` })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Add a rule" })).toHaveCount(0);
}

test("the 3PL creates a fee schedule and adds its rules in the editor", async ({ page }) => {
  await signIn(page, state.adminEmail);
  await expect(page).toHaveURL(/\/app$/);
  await page.goto("/app/fee-schedules");
  await expect(page.getByRole("heading", { name: "Fee schedules", level: 1 })).toBeVisible();
  await expect(page.getByText("No fee schedules yet")).toBeVisible();
  // What a schedule cannot express is stated up front, before anything is authored.
  await page.getByText("What fee schedules cannot model yet").click();
  await expect(page.getByText("Seasonal windows inside a version (use a version per season)")).toBeVisible();

  // A duplicate or empty name is refused before anything is created; then the schedule is created.
  await label(page, "Name").fill(state.scheduleName);
  await label(page, "Description (optional)").fill(state.scheduleDescription);
  await page.getByRole("button", { name: "Create fee schedule" }).click();
  await expect(page).toHaveURL(/\/app\/fee-schedules\/[0-9a-f-]{36}$/);
  state.scheduleId = uuid(page.url(), "fee-schedules");
  await expect(page.getByRole("heading", { name: state.scheduleName })).toBeVisible();
  await page.getByRole("link", { name: "Version 1" }).first().click();
  await expect(page).toHaveURL(/\/versions\/[0-9a-f-]{36}$/);
  state.versionId = uuid(page.url(), "versions");
  await expect(page.getByRole("heading", { name: "Version 1" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No rules yet" })).toBeVisible();
  persist();

  // 1. Per-order pick: first pick included ($2.00 an order), with a staff-only source note.
  await addRule(page, {
    preset: "First pick included",
    name: "Pick & pack, per order",
    key: KEYS.pick,
    amountLabel: "Amount per order (USD)",
    amount: "2.00",
    extra: async (p) => {
      await label(p, "Description (optional)").fill("Covers picking and packing the first item of every order.");
      await label(p, "Where this number comes from (optional)").fill(SOURCE_SENTINEL);
    },
  });
  // 2. Additional units, first one included.
  await addRule(page, { preset: "Additional units", name: "Each additional item", key: KEYS.addl, amountLabel: "Amount per item (USD)", amount: "0.50" });

  // 3. Packaging by type with a catch-all: the three compete in one group, lowest priority number wins.
  const packaging = (name: string, key: string, amount: string, types: string, priority: string): RuleSpec => ({
    name,
    key,
    extra: async (p) => {
      await label(p, "Category").selectOption({ label: "Packaging" });
      await label(p, "Charged per").selectOption({ label: "Per package" });
      await label(p, "Amount per package (USD)").fill(amount);
      await p.getByText("Only some orders (optional)").click();
      await label(p, "Packaging types this applies to").fill(types);
      await p.getByText("Alternatives (optional)").click();
      await label(p, "Group name (staff only)").fill(KEYS.group);
      await label(p, "Priority (lowest number wins)").fill(priority);
    },
  });
  await addRule(page, packaging("Box packaging", KEYS.box, "0.75", "box", "1"));
  await addRule(page, packaging("Mailer packaging", KEYS.mailer, "0.25", "mailer", "2"));
  await addRule(page, packaging("Other packaging", KEYS.other, "1.00", "*", "3"));

  // 4. Percent of shipping.
  await addRule(page, { preset: "Percent of shipping", name: "Shipping handling", key: KEYS.handling, extra: async (p) => label(p, "Percentage").fill("5") });

  // 5. Monthly storage per pallet, with its long-term rule (the pallets held past 180 days replace the standard rate).
  await addRule(page, {
    preset: "Monthly storage per pallet",
    name: "Pallet storage",
    key: KEYS.storage,
    amountLabel: "Amount per pallet per month (USD)",
    amount: "18.00",
    extra: async (p) => {
      await label(p, "Question key (staff only)").fill(KEYS.qStorage);
      await label(p, "Help with the question (optional)").fill("Count each pallet position you use, averaged over the month.");
    },
  });
  await addRule(page, {
    preset: "Long-term storage",
    name: "Long-term pallet storage",
    key: KEYS.longTerm,
    amountLabel: "Amount per pallet per month (USD)",
    amount: "27.00",
    extra: async (p) => {
      await label(p, "Question key (staff only)").fill(KEYS.qLongTerm);
      await expect(label(p, "Part of the standard rule")).toHaveValue(/.+/); // the preset found the standard storage rule
    },
  });
  // 6. Receiving per pallet.
  await addRule(page, { preset: "Receiving per pallet", name: "Pallet receiving", key: KEYS.receiving, amountLabel: "Amount per pallet per month (USD)", amount: "12.00", extra: async (p) => label(p, "Question key (staff only)").fill(KEYS.qReceiving) });
  // 7. Returns rate.
  await addRule(page, { preset: "Returns per order", name: "Returns processing", key: KEYS.returns, amountLabel: "Amount per return (USD)", amount: "3.00", extra: async (p) => label(p, "Question key (staff only)").fill(KEYS.qReturns) });
  // 8. Flat monthly fee.
  await addRule(page, { preset: "Flat monthly fee", name: "Account administration", key: KEYS.admin, amountLabel: "Amount per month (USD)", amount: "75.00" });
  // 9. Account minimum: no category ticked, so every fee except flat monthly fees counts toward it.
  await addRule(page, { preset: "Account minimum", name: "Monthly account minimum", key: KEYS.minimum, amountLabel: "Minimum per month (USD)", amount: "500.00" });

  // The rules read back in the customer's words, in the editor's list and in the preview, and the staff-only parts are labelled.
  const rules = page.locator("#rules-heading").locator("xpath=ancestor::section[1]");
  await expect(rules.getByText("$2.00 per order.", { exact: true })).toBeVisible();
  await expect(rules.getByText(`Key (staff only): ${KEYS.pick}`)).toBeVisible();
  await expect(rules.getByText(`Source (staff only): ${SOURCE_SENTINEL}`)).toBeVisible();
  const preview = page.locator('section[aria-labelledby="preview-heading"]');
  await expect(preview.getByRole("heading", { name: "Pick & pack", level: 3 })).toBeVisible();
  await expect(preview.getByText("$2.00 per order.", { exact: true })).toBeVisible();
  await expect(preview.getByText("$0.50 per item after the first item in each order.", { exact: true })).toBeVisible();
  await expect(preview.getByText("$0.75 per package, only for packaging: box.", { exact: true })).toBeVisible();
  await expect(preview.getByText("$1.00 per package, only for any other packaging.", { exact: true })).toBeVisible();
  await expect(preview.getByText("5% of the shipping cost of each order.", { exact: true })).toBeVisible();
  await expect(preview.getByText("$18.00 per pallet per month.", { exact: true })).toBeVisible();
  await expect(preview.getByText("$27.00 per pallet per month for pallets held longer than 180 days (instead of the standard rate).", { exact: true })).toBeVisible();
  await expect(preview.getByText(/^\$3\.00 per return/)).toBeVisible();
  await expect(preview.getByText("$75.00 a month.", { exact: true })).toBeVisible();
  await expect(preview.getByText(/If the fees counted toward the minimum in a month add up to less than \$500\.00/)).toBeVisible();
  await expect(preview.getByText("Depends on what you tell us: Pallets of your products stored, on average")).toBeVisible();
  // The customer's preview never prints keys, notes or sources.
  for (const secret of [...Object.values(KEYS), SOURCE_SENTINEL]) await expect(preview.getByText(secret, { exact: false }), secret).toHaveCount(0);

  // Staff notes are kept apart from everything customers read.
  await page.getByRole("textbox", { name: "Staff notes" }).fill(NOTES_SENTINEL);
  await page.getByRole("button", { name: "Save notes" }).click();
  await expect(page.getByText("Saved.", { exact: false }).last()).toBeVisible();
  await expect(preview.getByText(NOTES_SENTINEL)).toHaveCount(0);
});

test("the 3PL tries an order: a line amount, and a reason for what cannot be computed (never $0)", async ({ page }) => {
  await asStaff(page);
  await page.goto(`/app/fee-schedules/${state.scheduleId}/versions/${state.versionId}`);
  const form = page.getByRole("form", { name: "Try an order" });
  await label(form, "Items").fill("3");
  await label(form, "Package 1: packaging type").fill("box");
  // No shipping cost entered: the percent-of-shipping fee cannot be computed.
  await page.getByRole("button", { name: "Price this order" }).click();
  const outcome = page.locator('section[aria-labelledby="try-result-heading"]');
  await expect(outcome.getByRole("heading", { name: "What this order would be charged in order fees" })).toBeVisible();
  // The first list is the charged lines; the lists after it are what was not computed and what was replaced.
  const charged = outcome.getByRole("list").first().getByRole("listitem");
  const pick = charged.filter({ hasText: "Pick & pack, per order" });
  await expect(pick).toContainText("$2.00");
  await expect(pick).toContainText("1 order × $2.00 = $2.00");
  await expect(pick).toContainText("Definite");
  // 3 items, the first included: 2 × $0.50.
  await expect(charged.filter({ hasText: "Each additional item" })).toContainText("2 items × $0.50 = $1.00");
  // The box rule won the packaging group for the one box.
  await expect(charged.filter({ hasText: "Box packaging" })).toContainText("$0.75");
  await expect(charged.filter({ hasText: "Mailer packaging" })).toHaveCount(0); // the alternatives that lost are named below, not charged
  await expect(outcome.getByText("Not computed", { exact: true })).toBeVisible();
  await expect(outcome.getByText("Shipping handling", { exact: true })).toBeVisible();
  await expect(outcome.getByText(": needs the order's shipping cost.", { exact: false })).toBeVisible();
  await expect(outcome.getByText("These are left out of the amounts above, not counted as $0.")).toBeVisible();
  await expect(outcome.getByText("Some fees could not be computed", { exact: false })).toBeVisible();
  await expect(outcome.getByText("Not charged: an alternative applies")).toBeVisible();
  await expect(outcome.getByText("Other packaging, instead of Box packaging.")).toBeVisible(); // the catch-all lost to the box rule
  await expect(outcome.getByText("Mailer packaging", { exact: false })).toHaveCount(0); // a rule for another type never applied
  await expect(outcome.getByText("$3.75").first()).toBeVisible(); // 2.00 + 1.00 + 0.75 definite

  // Now the shipping cost is known: 5% of $10.00 is $0.50 and nothing is left uncomputed.
  await label(form, "Shipping cost of the order (USD)").fill("10.00");
  await expect(outcome.getByText("You changed the order or the rules after pricing it", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Price this order" }).click();
  await expect(charged.filter({ hasText: "Shipping handling" })).toContainText("$0.50");
  await expect(outcome.getByText("Every applicable fee was computed.")).toBeVisible();
  await expect(outcome.getByText("Not computed", { exact: true })).toHaveCount(0);
  await expect(outcome.getByText("$4.25").first()).toBeVisible();
});

test("the 3PL activates the version with an effective date and assigns the schedule to the customer", async ({ page }) => {
  await asStaff(page);
  await page.goto(`/app/fee-schedules/${state.scheduleId}`);
  await page.getByRole("button", { name: "Activate…" }).click();
  const dialog = page.getByRole("dialog", { name: "Activate version 1" });
  await expect(dialog).toBeVisible();
  await label(dialog, "Effective date").fill("2026-01-01");
  await dialog.getByRole("button", { name: "Activate version" }).click();
  // The draft row turns into an active row: assert the row, not the transient dialog message.
  await expect(page.getByText("In effect today")).toBeVisible();
  await expect(page.getByText("active", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Activate…" })).toHaveCount(0);
  const [version] = await sql<{ status: string; effective_date: string; rule_count: number }>("select status, effective_date::text, rule_count from public.fee_schedule_versions where id = $1", [state.versionId]);
  expect(version).toEqual({ status: "active", effective_date: "2026-01-01", rule_count: 12 });
  // An active version's rules no longer change in the editor.
  await page.goto(`/app/fee-schedules/${state.scheduleId}/versions/${state.versionId}`);
  await expect(page.getByRole("button", { name: "Add rule", exact: true })).toHaveCount(0);

  await page.goto(`/app/customers/${state.brandId}`);
  await expect(page.getByRole("heading", { name: "Fee schedule", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No fee schedule assigned" })).toBeVisible();
  await page.getByRole("combobox", { name: "Fee schedule" }).selectOption({ label: state.scheduleName });
  await page.getByRole("button", { name: "Assign", exact: true }).click();
  await expect(page.getByText("Version 1 in effect", { exact: false })).toBeVisible();
  await page.goto(`/app/fee-schedules/${state.scheduleId}`);
  await expect(page.getByRole("link", { name: state.brandName })).toBeVisible();
  persist();
});


// ---------------------------------------------------------------------------
// What a customer must never receive, and the arithmetic every figure is checked against
// ---------------------------------------------------------------------------
const RULE_KEYS = [KEYS.pick, KEYS.addl, KEYS.box, KEYS.mailer, KEYS.other, KEYS.handling, KEYS.storage, KEYS.longTerm, KEYS.receiving, KEYS.returns, KEYS.admin, KEYS.minimum, KEYS.group];
const QUESTION_KEYS = [KEYS.qStorage, KEYS.qLongTerm, KEYS.qReceiving, KEYS.qReturns];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/**
 * Nothing the 3PL typed for its own eyes reaches the customer. On what the person can read (the page text and the
 * names the page gives its controls): no rule key, question key, group name, staff note, source, rule or version id,
 * or version number. In the raw page the browser receives: no staff note or source, and no rule key or group name
 * (an answer to a fee-schedule question is posted by its question key, so those keys travel inside the page's own form
 * state; they are asserted absent from the readable page, not from the form).
 */
async function expectNoInternals(page: Page, where: string) {
  const text = await page.locator("body").innerText();
  const names = await page.locator("[aria-label], [title], [alt]").evaluateAll((els) => els.flatMap((el) => [el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("alt")]).filter(Boolean).join("\n"));
  const readable = `${text}\n${names}`;
  for (const secret of [...RULE_KEYS, ...QUESTION_KEYS, NOTES_SENTINEL, SOURCE_SENTINEL]) expect(readable, `${where}: "${secret}" is readable`).not.toContain(secret);
  expect(readable, `${where}: a version number`).not.toMatch(/\bversions?\s*#?\d+/i);
  expect(readable, `${where}: a rule or version reference`).not.toMatch(/@v\d|rule[_ ]?id|version[_ ]?id/i);
  expect(readable, `${where}: an id`).not.toMatch(UUID);
  const html = await page.content();
  for (const secret of [...RULE_KEYS, NOTES_SENTINEL, SOURCE_SENTINEL]) expect(html, `${where}: "${secret}" is in the page the browser received`).not.toContain(secret);
}

/** The same sweep on a page fetched without a browser (no scripts run): the markup and the embedded payload. */
async function expectNoInternalsInSource(page: Page, url: string) {
  const res = await page.request.get(url);
  expect(res.status(), url).toBe(200);
  const html = await res.text();
  for (const secret of [...RULE_KEYS, NOTES_SENTINEL, SOURCE_SENTINEL]) expect(html, `${url}: "${secret}" is in the page source`).not.toContain(secret);
}

/** Round to cents the way the product does for a displayed figure (half up, once). */
const cents = (value: number) => (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2);

// The period of the fixture file, worked out by hand: 23 orders carry a date (A-1024's "not a date" has none), from Mar 2 to Apr 1 2026.
// March 2–31 is 30 of 31 days and April 1 is 1 of 30 days, so the file spans 30/31 + 1/30 = 1.001075 months.
const ORDERS_IN_PERIOD = 23;
const MONTHS = 1.001075;
// Fees of the 18 orders that could be shipped-priced, worked out by hand from the schedule and the fixture:
//   pick 18 × $2.00 = $36.00; 8 additional items (A-1001 +1, A-1004 +2, A-1006 +1, A-1011 +1, A-1016 +1, A-1017 +2) × $0.50 = $4.00;
//   16 box packages × $0.75 = $12.00 and 4 mailers × $0.25 = $1.00 (the catch-all never applies); 5% of the shipping on top.
const FIXED_ORDER_FEES = 36 + 4 + 12 + 1;

// ---------------------------------------------------------------------------
// 2. The customer uploads the fixture file, answers the fulfillment questions and runs the model
// ---------------------------------------------------------------------------
test("the customer finds the fee schedule and uploads the fixture orders file", async ({ page }) => {
  await asBrand(page);
  await page.goto("/portal/model");
  await page.getByRole("link", { name: /See your fee schedule/ }).click();
  await expect(page).toHaveURL(/\/portal\/model\/fees$/);
  await expect(page.getByRole("heading", { name: "Your fee schedule", level: 1 })).toBeVisible();

  await page.goto("/portal/model");
  await label(page, "Orders file").setInputFiles(path.join(FIXTURES, "orders-generic.csv"));
  await page.getByRole("button", { name: "Upload and review" }).click();
  await expect(page).toHaveURL(/\/portal\/model\/orders\/[0-9a-f-]{36}$/);
  state.datasetId = uuid(page.url(), "orders");
  await page.getByRole("button", { name: "Save and check the file" }).click();
  await expect(page.getByRole("heading", { name: "Does this look right?" })).toBeVisible();
  await page.getByRole("button", { name: "Looks right — prepare for modeling" }).click();
  await expect(page.getByText("Ready to model. Choose the rates below.")).toBeVisible();
  persist();
});

const question = (page: Page, name: string) => page.getByRole("group", { name, exact: true });
const STORAGE_Q = "Pallets of your products stored, on average";
const LONG_TERM_Q = "Of those, pallets held longer than 180 days";
const RECEIVING_Q = "Pallets you send in each month";
const RETURNS_Q = "Out of every 100 orders, how many come back?";
/** The number box of a question about a quantity, named "<question>: number of <unit>". */
const answerBox = (page: Page, q: string, unit: string) => question(page, q).getByLabel(`${q}: number of ${unit}`, { exact: true });

test("run setup step 2 asks the fee schedule's questions, refuses a blank or impossible answer, and starts the run", async ({ page }) => {
  test.setTimeout(180_000);
  await asBrand(page);
  await page.goto(`/portal/model/orders/${state.datasetId}`);
  await expect(page.getByText("Step 1 of 2")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Shipping settings" })).toBeVisible();
  await page.getByRole("button", { name: "Continue to fulfillment costs" }).click();
  await expect(page.getByText("Step 2 of 2")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Fulfillment costs" })).toBeVisible();
  await expect(page.getByText(`Your fee schedule ${state.scheduleName} (in effect from Jan 1, 2026) charges for things your orders file does not say.`, { exact: false })).toBeVisible();
  await expect(label(page, "Skip fulfillment costs (shipping only)")).not.toBeChecked();

  // The volume sentence is the file's own period, worked out above: 23 dated orders over Mar 2 – Apr 1 (1 month), about 23 a month.
  await expect(page.getByText("Your file has 23 orders over Mar 2, 2026–Apr 1, 2026 (1 month): about 23 orders a month.")).toBeVisible();
  await expect(page.getByText("1 order has no date and is not counted in the volume.")).toBeVisible();
  await expect(page.getByRole("radio", { name: "Use this volume" })).toBeChecked();

  // One question per driver, in the 3PL's words with its rate and help; no question key anywhere.
  await expect(question(page, STORAGE_Q)).toContainText("Count each pallet position you use, averaged over the month.");
  await expect(question(page, STORAGE_Q)).toContainText("Pallet storage: $18.00 per pallet per month.");
  await expect(question(page, LONG_TERM_Q)).toContainText("Long-term pallet storage: $27.00 per pallet per month.");
  await expect(question(page, LONG_TERM_Q)).toContainText("Held longer than 180 days. This is part of pallets of your products stored, on average above, not in addition to it.");
  await expect(question(page, RECEIVING_Q)).toContainText("Pallet receiving: $12.00 per pallet");
  await expect(question(page, RETURNS_Q)).toContainText("Returns processing: $3.00 per return");
  await expectNoInternals(page, "run setup step 2");

  // A blank number with no choice never reaches the server: every question is marked and the run does not start.
  await page.getByRole("button", { name: "Run the model" }).click();
  await expect(page.getByText("4 answers need attention before the run can start.")).toBeVisible();
  await expect(page.getByText("Choose one: enter a number, Not sure (leave it out), or We don't use this.")).toHaveCount(4);
  await expect(page).toHaveURL(/\/portal\/model\/orders\//);

  // An impossible number is named on its question: long-term pallets cannot exceed the pallets stored.
  await answerBox(page, STORAGE_Q, "pallets").fill("12");
  await answerBox(page, LONG_TERM_Q, "pallets").fill("15");
  await question(page, RECEIVING_Q).getByRole("radio", { name: "Not sure, leave it out" }).check();
  await answerBox(page, RETURNS_Q, "percent of orders").fill("abc");
  await page.getByRole("button", { name: "Run the model" }).click();
  await expect(page.getByText("This cannot be more than the total you entered for pallets of your products stored, on average (12).")).toBeVisible();
  await expect(page.getByText("Enter a number (up to 4 decimals).")).toBeVisible();
  await expect(page.getByText("2 answers need attention before the run can start.")).toBeVisible();
  await expect(page).toHaveURL(/\/portal\/model\/orders\//);

  // The real answers: storage as a number, long-term as a number, receiving "not sure" (left out), returns "we don't use this" (zero, by choice).
  await answerBox(page, LONG_TERM_Q, "pallets").fill("4");
  await question(page, RETURNS_Q).getByRole("radio", { name: "We don't use this" }).check();
  await expect(page.getByText(/answers? need attention/)).toHaveCount(0);
  await page.getByRole("button", { name: "Run the model" }).click();
  await expect(page).toHaveURL(/\/portal\/model\/runs\/[0-9a-f-]{36}$/);
  state.runId = uuid(page.url(), "runs");
  await expect(page.getByText("Keep this page open")).toBeVisible();
  // Receiving was left out, so the all-in is not complete and the page opens on Shipping.
  await expect(page.getByRole("group", { name: "Estimated shipping cost per order" })).toBeVisible({ timeout: 120_000 });
  const [run] = await sql<{ status: string; modeled_orders: number; monthly_orders: string; volume_basis: string }>("select status, modeled_orders, monthly_orders::text, volume_basis from public.simulation_runs where id = $1", [state.runId]);
  expect(run).toMatchObject({ status: "completed", modeled_orders: 18, volume_basis: "file" });
  expect(Number(run!.monthly_orders)).toBeCloseTo(ORDERS_IN_PERIOD / MONTHS, 3);
  persist();
});

/** The Show control of a run page: a link per view, the selected one marked. */
const viewLink = (page: Page, name: "Shipping" | "Order fees" | "All-in") => page.getByRole("navigation", { name: "Show" }).getByRole("link", { name });
const headline = (page: Page, name: string | RegExp) => page.getByRole("group", { name });
const part = (group: Locator, name: RegExp) => group.locator("dt", { hasText: name }).locator("xpath=following-sibling::dd[1]");

test("the all-in headline says what is left out: 'At least', 'without receiving', with the parts and the minimum", async ({ page }) => {
  await asBrand(page);
  await page.goto(`/portal/model/runs/${state.runId}`);
  await expect(headline(page, "Estimated shipping cost per order")).toBeVisible();
  await expect(viewLink(page, "Shipping")).toHaveAttribute("aria-current", "true");
  // The shipping spend over the 18 orders that could be priced (the one figure taken from the page; shipping itself is covered by modeling.spec.ts).
  const spendText = await stat(page, "Projected shipping spend").innerText();
  const shippingSpend = Number(spendText.replace(/[$,]/g, ""));
  expect(shippingSpend).toBeGreaterThan(0);

  await viewLink(page, "All-in").click();
  await expect(page).toHaveURL(/view=allin/);
  const h = headline(page, "All-in cost per order, without receiving");
  await expect(h).toBeVisible();
  await expect(h).toContainText("At least");
  // Per order over the 23 orders of the period: shipping and order fees as totals, monthly charges as the month's $327.00 (storage 8 × $18.00 + long-term 4 × $27.00 + administration $75.00; returns 0 by choice) over 1.001075 months.
  const orderFees = FIXED_ORDER_FEES + 0.05 * shippingSpend;
  const shippingPart = shippingSpend / ORDERS_IN_PERIOD;
  const feesPart = orderFees / ORDERS_IN_PERIOD;
  const monthlyPart = (327 * MONTHS) / ORDERS_IN_PERIOD;
  await expect(part(h, /^Shipping/)).toHaveText(`$${cents(shippingPart)}`);
  await expect(part(h, /^Order fees/)).toHaveText(`$${cents(feesPart)}`);
  await expect(part(h, /^Monthly charges, spread over your orders/)).toHaveText(`$${cents(monthlyPart)}`);
  await expect(h).toContainText(`$${cents(shippingPart + feesPart + monthlyPart)}`);
  await expect(h).toContainText("23 orders a month over Mar 2, 2026–Apr 1, 2026 (1 month)");
  await expect(h).toContainText("Each figure is rounded to cents once, so the parts can differ from the total by a cent.");
  // Coverage is 75%: the monthly figures count only the orders that could be priced, and the headline says the real cost is at least this.
  await expect(page.getByText("Only 75.0% of your orders could be priced, so the monthly figures count just those orders: the real cost is at least this.")).toBeVisible();
  // The account minimum is not folded in: it is an upper bound (receiving left out, coverage short, one order undated), said beside the figure.
  await expect(h).toContainText(/The account minimum could add up to \$\d[\d,]*\.\d{2} a month \(about \$\d+\.\d{2} per order\) on top of this\. It could not be worked out exactly: Pallet receiving is not modeled, only 72\.7% of the orders shipped in Mar 2026 could be priced and 1 order has no date\./);
  // What is left out, with its rate and a way to add it.
  await expect(h).toContainText("Not included, because no numbers were given");
  await expect(h).toContainText("Pallet receiving: $12.00 per pallet");

  // Provenance: whose schedule and rates, and who entered the assumptions.
  await expect(page.getByText(`${state.company} fee schedule '${state.scheduleName}', in effect from Jan 1, 2026.`)).toBeVisible();
  await expect(page.getByText(/^Assumptions entered by you on [A-Z][a-z]{2} \d{1,2}, \d{4}\.$/)).toBeVisible();
  await expect(page.getByText("Estimates, not an invoice.", { exact: false }).first()).toBeVisible();
  await expectNoInternals(page, "run, all-in view");
  await expectNoInternalsInSource(page, `/portal/model/runs/${state.runId}?view=allin`);
});

test("order fees, monthly charges, the account minimum and what is not included are each shown with their numbers", async ({ page }) => {
  await asBrand(page);
  await page.goto(`/portal/model/runs/${state.runId}?view=shipping`);
  const shippingSpend = Number((await stat(page, "Projected shipping spend").innerText()).replace(/[$,]/g, ""));
  await page.goto(`/portal/model/runs/${state.runId}?view=allin`);

  // Order fees: every order-scope charge with the orders it applied to, each amount worked out by hand above.
  const fees = page.getByRole("region", { name: "Order fees by charge" });
  const row = (name: string) => fees.getByRole("row").filter({ has: page.getByRole("cell", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\&]/g, "\\$&")}`) }) });
  const cell = (name: string, index: number) => row(name).getByRole("cell").nth(index);
  await expect(cell("Pick & pack, per order", 0)).toContainText("$2.00 per order.");
  await expect(cell("Pick & pack, per order", 1)).toHaveText("18");
  await expect(cell("Pick & pack, per order", 2)).toHaveText("$36.00");
  await expect(cell("Each additional item", 1)).toHaveText("6");
  await expect(cell("Each additional item", 2)).toHaveText("$4.00");
  await expect(cell("Box packaging", 1)).toHaveText("15");
  await expect(cell("Box packaging", 2)).toHaveText("$12.00"); // 16 boxes: A-1006 shipped two
  await expect(cell("Mailer packaging", 1)).toHaveText("4");
  await expect(cell("Mailer packaging", 2)).toHaveText("$1.00");
  await expect(cell("Other packaging", 1)).toHaveText("0");
  await expect(cell("Other packaging", 4)).toContainText("18 orders charged under another fee instead");
  // 5% of the $300.50-ish shipping of the 18 orders, split by whether each order's shipping was certain or assumed, each part rounded once.
  await expect(cell("Shipping handling", 1)).toHaveText("18");
  const handlingTotal = Number((await cell("Shipping handling", 2).innerText()).replace(/[$,]/g, "")) + Number((await cell("Shipping handling", 3).innerText()).replace(/[$,]/g, ""));
  expect(Math.abs(handlingTotal - 0.05 * shippingSpend)).toBeLessThanOrEqual(0.011);
  await expect(fees.getByRole("row", { name: /^All order fees/ })).toContainText("18 orders");
  await expect(page.getByText("Priced for 18 of 18 orders that could be priced, an average of", { exact: false })).toBeVisible();
  await expect(fees.getByRole("columnheader", { name: "From your fee schedule" })).toBeVisible();
  // Nothing is ever "not computed" for an order fee here: the file carries items and packaging, and shipping priced for every order in the table.
  await expect(row("Pick & pack, per order").getByRole("cell").nth(4)).toHaveText("—");

  // Monthly charges: dollars a month first, whatever you ship; each line with the number the customer gave echoed back.
  await expect(page.getByText("At least $327.00 a month, whatever you ship", { exact: true })).toBeVisible();
  await expect(page.getByText("plus $0.00 a month in charges that grow with your orders", { exact: true })).toBeVisible();
  const monthly = page.getByRole("region", { name: "Monthly charges" });
  const mrow = (name: string) => monthly.getByRole("row").filter({ has: page.getByRole("cell", { name: new RegExp(`^${name}`) }) });
  await expect(mrow("Pallet storage")).toContainText("8 pallets × $18.00 = $144.00 a month."); // 12 stored, 4 of them long-term and priced below
  await expect(mrow("Pallet storage")).toContainText("Based on assumptions");
  await expect(mrow("Long-term pallet storage")).toContainText("4 pallets × $27.00 = $108.00 a month.");
  await expect(mrow("Returns processing")).toContainText("0 returns × $3.00 = $0.00 a month.");
  await expect(mrow("Account administration")).toContainText("$75.00 a month.");
  await expect(mrow("Account administration")).toContainText("From your fee schedule");
  await expect(page.getByText(`Spread over your orders, that is at least $${cents(monthlyAt(327))} per order at 23 orders a month. This is monthly charges shared across orders, not a per-order fee.`, { exact: false })).toBeVisible();
  await expect(page.getByText("Pallet receiving: $12.00 per pallet", { exact: false }).filter({ hasText: "Not included in the totals." })).toBeVisible();
  // The sensitivity table: the all-in at other volumes is a lower bound too.
  const volumes = page.getByRole("region", { name: "All-in cost per order at other volumes" });
  await expect(volumes.getByRole("row", { name: /^Your volume/ })).toContainText("At least");
  await expect(volumes.getByRole("row", { name: /^2× your volume/ })).toContainText("46");

  // The account minimum: not worked out exactly, so it is "Up to" and kept out of the all-in; every fee that counts toward it is marked.
  const minimum = page.getByRole("heading", { name: "Account minimum", level: 2 }).locator("xpath=ancestor::*[contains(@class,'space-y-5')][1]");
  await expect(minimum.getByRole("heading", { name: "Monthly account minimum", level: 3 })).toBeVisible();
  await expect(minimum.getByText("Up to", { exact: true })).toBeVisible();
  await expect(minimum).toContainText(/This minimum could add up to \$\d[\d,]*\.\d{2} a month\. It is not included in the all-in figure because it could not be worked out exactly: Pallet receiving is not modeled, only 72\.7% of the orders shipped in Mar 2026 could be priced and 1 order has no date\./);
  await expect(minimum).not.toContainText("Fees counted toward the minimum:"); // the exact sentence needs an exact minimum
  for (const counted of ["Pick & pack, per order", "Each additional item", "Box packaging", "Mailer packaging", "Other packaging", "Shipping handling", "Pallet storage", "Long-term pallet storage", "Returns processing"]) {
    await expect(minimum.getByRole("listitem").filter({ hasText: counted }).first()).toContainText("Counted");
  }
  await expect(minimum.getByRole("listitem").filter({ hasText: "Pallet receiving" })).toContainText("Not modeled");
  // The administration fee is a flat monthly fee: it never counts toward the minimum.
  await expect(minimum.getByRole("listitem").filter({ hasText: "Account administration" })).toHaveCount(0);

  // Not included, in three groups.
  const notIncluded = page.getByRole("heading", { name: "Not included", level: 2 }).locator("xpath=ancestor::*[contains(@class,'space-y-4')][1]");
  await expect(notIncluded.getByRole("heading", { name: "Left out because no numbers were given" })).toBeVisible();
  await expect(notIncluded.getByRole("listitem").filter({ hasText: "Pallet receiving: $12.00 per pallet" })).toBeVisible();
  await expect(notIncluded.getByRole("heading", { name: "Not on your fee schedule" })).toBeVisible();
  await expect(notIncluded).toContainText("Kitting & assembly: Your fee schedule has no kitting & assembly charge.");
  await expect(notIncluded).toContainText("Labeling: Your fee schedule has no labeling charge.");
  await expect(notIncluded.getByRole("heading", { name: "Never included" })).toBeVisible();
  await expect(notIncluded).toContainText("Carrier adjustments billed after shipping, such as address corrections and reweighs.");
  await expect(notIncluded).toContainText("Taxes.");
  await expect(notIncluded).toContainText("Return shipping.");

  // Every "Add" link names its charge and goes to the run-again form.
  const add = page.getByRole("link", { name: "Add numbers for Pallet receiving" });
  expect(await add.count()).toBeGreaterThanOrEqual(3);
  expect(await add.evaluateAll((els) => els.map((el) => el.getAttribute("href")))).toEqual(Array(await add.count()).fill("#run-again"));
  await add.first().click();
  await expect(page).toHaveURL(/#run-again$/);
  await expect(page.locator("#run-again")).toBeVisible();
});

/** Monthly charges per order the way the run page spreads them: the month's dollars over the 23 orders of a 1.001075-month period. */
const monthlyAt = (monthly: number) => (monthly * MONTHS) / ORDERS_IN_PERIOD;

test("the view control switches between Shipping, Order fees and All-in, and the orders table has no all-in column", async ({ page }) => {
  await asBrand(page);
  await page.goto(`/portal/model/runs/${state.runId}`);
  await expect(viewLink(page, "Shipping")).toHaveAttribute("aria-current", "true");
  await expect(viewLink(page, "All-in")).not.toHaveAttribute("aria-current", "true");
  await expect(page.getByText("Shipping is the shipping charge from the rate card only. Order fees add the charges that depend on each order", { exact: false })).toBeVisible();
  await expect(headline(page, "Estimated shipping cost per order")).toContainText("Based on 18 of 24 orders (75.0%)");

  await viewLink(page, "Order fees").click();
  await expect(page).toHaveURL(/view=fees/);
  await expect(viewLink(page, "Order fees")).toHaveAttribute("aria-current", "true");
  await expect(viewLink(page, "Shipping")).not.toHaveAttribute("aria-current", "true");
  // Receiving is a monthly charge, so it does not make the order-fee figure a lower bound.
  const fees = headline(page, "Order fees per order");
  await expect(fees).toBeVisible();
  await expect(fees).toContainText("Fees priced for 18 of 18 orders that could be priced");
  await expect(fees).not.toContainText("At least");
  await expect(headline(page, /All-in cost per order/)).toHaveCount(0);
  // The Order fees view lists each charge with its amount: the pick rule is 18 orders × $2.00.
  const feesTable = page.getByRole("region", { name: "Order fees by charge" });
  const pickRow = feesTable.getByRole("row").filter({ has: page.getByRole("cell", { name: /^Pick & pack, per order/ }) });
  await expect(pickRow.getByRole("cell").nth(1)).toHaveText("18");
  await expect(pickRow.getByRole("cell").nth(2)).toHaveText("$36.00");
  await expect(fees).toContainText("$3.78"); // fees of $68.03 over the 18 orders (53.00 fixed + 5% of $300.50)

  await viewLink(page, "All-in").click();
  await expect(page).toHaveURL(/view=allin/);
  await expect(headline(page, "All-in cost per order, without receiving")).toBeVisible();
  await expect(headline(page, "Order fees per order")).toHaveCount(0);

  await viewLink(page, "Shipping").click();
  await expect(headline(page, "Estimated shipping cost per order")).toBeVisible();

  // The orders table: what is per order (items, lines, packages, shipping, order fees, their sum) and nothing allocated.
  const orders = page.getByRole("region", { name: "Orders", exact: true });
  const headers = await orders.getByRole("columnheader").allInnerTexts();
  expect(headers.map((x) => x.trim())).toEqual(["Order", "Units", "Lines", "Packages", "Shipping", "Order fees", "Shipping + order fees", "Fees"]);
  for (const forbidden of [/all-in/i, /allocat/i, /monthly/i, /storage/i, /receiving/i]) expect(headers.join(" ")).not.toMatch(forbidden);
  await expect(page.getByText("Monthly charges are not per-order fees and are not shown here.")).toBeVisible();
  // Two orders worked out by hand. A-1001: 3 lb UPS Ground to zone 5, DIM 480/139 → 4 lb, $12.50 + $5.00 home delivery = $17.50;
  // fees $2.00 + 1 extra item $0.50 + box $0.75 + 5% of $17.50 ($0.875) = $4.125 → $4.13; together $21.63.
  const a1001 = orders.getByRole("row", { name: /^A-1001/ });
  await expect(a1001.getByRole("cell")).toHaveText(["A-1001", "2", "1", "1", "$17.50", "$4.13", "$21.63", "Priced"]);
  // A-1006: two packages (28 lb zone 7 $17.50, 19 lb zone 7 $16.50, each + $5.00 home delivery) = $44.00;
  // fees $2.00 + 1 extra item $0.50 + 2 boxes $1.50 + 5% of $44.00 ($2.20) = $6.20; together $50.20.
  const a1006 = orders.getByRole("row", { name: /^A-1006/ });
  await expect(a1006.getByRole("cell")).toHaveText(["A-1006", "2", "2", "2", "$44.00", "$6.20", "$50.20", "Priced"]);
  // An order whose shipping could not be priced (A-1020 weighs 195 lb, over the rate card's top bracket) is still listed, honestly:
  // shipping "Not priced", the fees that do not need shipping as a lower bound (pick $2.00 + the catch-all $1.00 for a crate), the sum "Not computed", never $0.
  const a1020 = orders.getByRole("row", { name: /^A-1020/ });
  await expect(a1020.getByRole("cell").nth(4)).toHaveText("Not priced");
  await expect(a1020.getByRole("cell").nth(5)).toHaveText("At least $3.00");
  await expect(a1020.getByRole("cell").nth(6)).toHaveText("Not computed");
  await expect(a1020.getByRole("cell").nth(7)).toContainText("Partly priced");
  await expect(a1020.getByRole("cell").nth(7)).toContainText("Not computed: Shipping handling");
});

test("the downloads carry no per-order allocated column, and monthly.csv carries the period and volume", async ({ page }) => {
  await asBrand(page);
  await page.goto(`/portal/model/runs/${state.runId}?view=allin`);
  const download = async (name: string) => {
    const [d] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name }).click()]);
    return { filename: d.suggestedFilename(), body: fs.readFileSync((await d.path())!, "utf8") };
  };

  const orders = await download("Download the per-order CSV");
  expect(orders.filename).toMatch(/^parcelclarity-orders-[0-9a-f]{8}\.csv$/);
  const orderLines = orders.body.split("\r\n");
  expect(orderLines[0]).toMatch(/^# Estimates for ".+" from .+ and .+ fee schedule '.+', in effect from Jan 1, 2026, not an invoice\. Amounts in USD\.$/);
  expect(orders.body).toContain("# Monthly charges are not per-order fees and are not in this file: they are in monthly.csv.");
  expect(orders.body).toContain("# All-in cost per order, without receiving: At least ");
  const header = orderLines.find((l) => l.startsWith("order_id,"));
  expect(header).toBe("order_id,order_date,units,lines,packages,shipments,shipping_expected,order_fees,shipping_plus_fees,fee_status,not_computed");
  expect(header).not.toMatch(/alloc|all_in|allin|monthly|storage|receiving/i);
  const rows = orderLines.filter((l) => /^A-\d+,/.test(l));
  expect(rows).toHaveLength(24); // every order of the file, one row each
  expect(rows).toContain("A-1001,2026-03-02,2,1,1,1,17.50,4.13,21.63,priced,");
  expect(rows).toContain("A-1006,2026-03-04,2,2,2,1,44.00,6.20,50.20,priced,");
  // A-1024 has no date but priced; A-1020 could not be priced for shipping: blank shipping and sum, a lower bound for the fees, the missing fee named.
  expect(rows).toContain("A-1024,,1,1,1,1,17.50,3.63,21.13,priced,");
  expect(rows).toContain("A-1020,2026-03-11,1,1,1,1,,3.00,,partly_priced,Shipping handling");
  for (const secret of [...RULE_KEYS, ...QUESTION_KEYS, NOTES_SENTINEL, SOURCE_SENTINEL]) expect(orders.body).not.toContain(secret);

  const monthly = await download("Download the monthly charges CSV");
  expect(monthly.filename).toMatch(/^parcelclarity-monthly-[0-9a-f]{8}\.csv$/);
  const lines = monthly.body.split("\r\n");
  expect(lines.find((l) => l.startsWith("row_type,"))).toBe("row_type,name,period,status,quantity,unit_amount,amount,class,note");
  // The period and the volume the charges are spread over.
  expect(monthly.body).toContain("# Basis: 23 orders a month over Mar 2, 2026–Apr 1, 2026 (1 month).");
  expect(monthly.body).toContain("# These are monthly amounts. They are not per-order fees and are not in orders.csv.");
  expect(lines).toContain("charge,Pallet storage,a month,priced,8,18.00,144.00,based_on_assumptions,8 pallets × $18.00 = $144.00 a month.");
  expect(lines).toContain("charge,Long-term pallet storage,a month,priced,4,27.00,108.00,based_on_assumptions,4 pallets × $27.00 = $108.00 a month.");
  expect(lines).toContain("charge,Returns processing,a month,priced,0,3.00,0.00,based_on_assumptions,0 returns × $3.00 = $0.00 a month.");
  expect(lines).toContain("charge,Account administration,a month,priced,1,75.00,75.00,from_fee_schedule,$75.00 a month.");
  // Receiving was left out: listed with its rate, blank, never zero.
  expect(lines).toContain("charge,Pallet receiving,a month,not_modeled,,,,,No number was given. Rate: $12.00 per pallet per month.");
  expect(lines).toContain("total,Monthly charges priced,a month,priced,,,327.00,,Charges that are not modeled are not in this total");
  expect(lines.find((l) => l.startsWith("minimum,Monthly account minimum,,up_to,"))).toMatch(/Could add up to \$\d[\d,]*\.\d{2} a month; not included in any all-in figure \(Pallet receiving is not modeled/);
  for (const secret of [...RULE_KEYS, ...QUESTION_KEYS, NOTES_SENTINEL, SOURCE_SENTINEL]) expect(monthly.body).not.toContain(secret);
});

// ---------------------------------------------------------------------------
// 3. Run again with receiving answered
// ---------------------------------------------------------------------------
test("running again with receiving answered completes the label, and the diff line names the change", async ({ page }) => {
  test.setTimeout(180_000);
  await asBrand(page);
  await page.goto(`/portal/model/runs/${state.runId}`);
  await page.locator("#run-again").scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Continue to fulfillment costs" }).click();
  await expect(page.getByText("Step 2 of 2")).toBeVisible();
  // Every answer of the last run is carried over.
  await expect(answerBox(page, STORAGE_Q, "pallets")).toHaveValue("12");
  await expect(answerBox(page, LONG_TERM_Q, "pallets")).toHaveValue("4");
  await expect(question(page, RECEIVING_Q).getByRole("radio", { name: "Not sure, leave it out" })).toBeChecked();
  await expect(question(page, RETURNS_Q).getByRole("radio", { name: "We don't use this" })).toBeChecked();
  await expect(page.getByText("Your fulfillment answers are the same as in the last run.")).toBeVisible();
  await answerBox(page, RECEIVING_Q, "pallets").fill("6");
  await expect(page.getByText("Changed: pallets you send in each month left out → 6")).toBeVisible();
  await page.getByRole("button", { name: "Run again with these settings" }).click();
  await expect(page).not.toHaveURL(new RegExp(state.runId));
  await expect(page).toHaveURL(/\/portal\/model\/runs\/[0-9a-f-]{36}/);
  state.secondRunId = uuid(page.url(), "runs");
  expect(state.secondRunId).not.toBe(state.runId);
  await expect(page.getByText("Estimated shipping cost per order").first()).toBeVisible({ timeout: 120_000 });
  persist();
  const spend = Number((await stat(page, "Projected shipping spend").innerText()).replace(/[$,]/g, ""));

  await viewLink(page, "All-in").click();
  // Nothing the schedule prices is left out any more, so the label is the plain one. The figure is still "At least":
  // the account minimum can only be an upper bound for this file (6 of 24 orders cannot be priced; one has no date).
  const h = headline(page, "All-in cost per order");
  await expect(h).toBeVisible();
  await expect(headline(page, /without/)).toHaveCount(0);
  await expect(h).not.toContainText("Not included, because no numbers were given");
  const total = spend / ORDERS_IN_PERIOD + (FIXED_ORDER_FEES + 0.05 * spend) / ORDERS_IN_PERIOD + monthlyAt(399);
  await expect(h).toContainText(`$${cents(total)}`);
  await expect(part(h, /^Monthly charges, spread over your orders/)).toHaveText(`$${cents(monthlyAt(399))}`);
  await expect(h).toContainText(/The account minimum could add up to \$\d[\d,]*\.\d{2} a month/);
  await expect(h).toContainText("only 72.7% of the orders shipped in Mar 2026 could be priced and 1 order has no date");
  await expect(h).not.toContainText("Pallet receiving is not modeled");
  // Receiving now counts toward the minimum, and the monthly charges include it.
  await expect(page.getByText("At least $327.00 a month, whatever you ship")).toHaveCount(0);
  await expect(page.getByText("$399.00 a month, whatever you ship", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Monthly charges" })).toContainText("6 pallets × $12.00 = $72.00 a month.");
  const minimum = page.getByRole("heading", { name: "Account minimum", level: 2 }).locator("xpath=ancestor::*[contains(@class,'space-y-5')][1]");
  await expect(minimum.getByRole("listitem").filter({ hasText: "Pallet receiving" })).toContainText("Counted");
  await expect(page.getByRole("link", { name: "Add numbers for Pallet receiving" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Left out because no numbers were given" })).toHaveCount(0);
  // The upper bound shrinks by what receiving now adds to the fees counted toward the minimum.
  const upTo = async () => {
    const t = await minimum.getByText(/This minimum could add up to/).innerText();
    return Number(/\$([\d,]+\.\d{2})/.exec(t)![1]!.replace(/,/g, ""));
  };
  const second = await upTo();
  await page.goto(`/portal/model/runs/${state.runId}?view=allin`);
  const first = Number(/\$([\d,]+\.\d{2})/.exec(await page.getByText(/This minimum could add up to/).innerText())![1]!.replace(/,/g, ""));
  expect(second).toBeLessThan(first);
  expect(first - second).toBeCloseTo(72, 0); // $6 pallets × $12.00, counted toward the minimum, to within the rounding of the monthly average

  // The first run is unchanged; a rerun is a new run, and the file's monthly csv shows the receiving line now.
  const csv = await (await page.request.get(`/api/runs/${state.secondRunId}/monthly.csv`)).text();
  expect(csv).toContain("charge,Pallet receiving,a month,priced,6,12.00,72.00,based_on_assumptions,6 pallets × $12.00 = $72.00 a month.");
  expect(csv).toContain("total,Monthly charges priced,a month,priced,,,399.00,,");
  await expectNoInternals(page, "first run after a rerun");
});

// ---------------------------------------------------------------------------
// 3b. Step 2 asks the questions of the date chosen in step 1
// ---------------------------------------------------------------------------
test("choosing another date in step 1 reads that date's fee schedule: a date before it has no questions, a date it covers keeps the answers", async ({ page }) => {
  test.setTimeout(120_000);
  await asBrand(page);
  await page.goto(`/portal/model/orders/${state.datasetId}`);
  // The schedule is in effect from Jan 1, 2026: on Jun 1, 2025 there is none, and the form says so instead of asking today's questions.
  await label(page, "Rates in effect on").fill("2025-06-01");
  await page.getByRole("button", { name: "Continue to fulfillment costs" }).click();
  await expect(page.getByText("No fee schedule is in effect for you on Jun 1, 2025, so there are no fulfillment questions for that date.")).toBeVisible();
  await expect(question(page, STORAGE_Q)).toHaveCount(0);
  // No answers travel for a date with no fee schedule.
  await expect(page.locator('input[name="fulfillment"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Run the model" })).toBeEnabled();

  // A date the version covers: its questions come back, and what was typed survives going back and choosing another covered date.
  await page.getByRole("button", { name: "Back to shipping settings" }).click();
  await label(page, "Rates in effect on").fill("2026-02-10");
  await page.getByRole("button", { name: "Continue to fulfillment costs" }).click();
  await expect(question(page, STORAGE_Q)).toBeVisible();
  await expect(page.getByText(`Your fee schedule ${state.scheduleName} (in effect from Jan 1, 2026)`, { exact: false })).toBeVisible();
  await expect(page.locator('input[name="fulfillment"]')).toHaveCount(1);
  await answerBox(page, STORAGE_Q, "pallets").fill("9");
  await page.getByRole("button", { name: "Back to shipping settings" }).click();
  await label(page, "Rates in effect on").fill("2026-03-01");
  await page.getByRole("button", { name: "Continue to fulfillment costs" }).click();
  await expect(answerBox(page, STORAGE_Q, "pallets")).toHaveValue("9");
  await expectNoInternals(page, "run setup step 2 for another date");
});

// ---------------------------------------------------------------------------
// 4. The customer forecasts from assumptions
// ---------------------------------------------------------------------------
const parcel = (page: Page, n: number) => page.getByRole("group", { name: `Parcel ${n}`, exact: true });
const FORECAST_SENTENCE = "Forecast from your assumptions at 1,200 orders a month. Each figure is the expected value over the mix you described; not a prediction for any month and not an invoice.";
/** A table of a forecast result, by its caption. */
const table = (page: Page, caption: string) => page.getByRole("region", { name: caption, exact: true });

test("the customer builds a forecast from assumptions: errors are named, a missing answer is 'at least', the full forecast is worked out by hand", async ({ page }) => {
  test.setTimeout(180_000);
  await asBrand(page);
  await page.goto("/portal/model/forecast");
  await expect(page.getByRole("heading", { name: "Forecast from your assumptions", level: 1 })).toBeVisible();

  // Nothing is prefilled that the person has not said, and an empty form names what is missing instead of previewing.
  await page.getByRole("button", { name: "Preview forecast" }).click();
  await expect(page.getByText(/^Fix these \d+ before previewing$/)).toBeVisible();
  // Each problem is named in the summary and again on its own field.
  await expect(page.getByText("Enter how many orders you ship in a month.")).toHaveCount(2);
  await expect(page.getByText("Choose a service.").first()).toBeVisible();

  // Volume, then two parcels (with their size, because UPS Ground prices by size, and their packaging), one service, two zones.
  await label(page, "Orders a month").fill("1200");
  await expect(label(page, "Ship-from ZIP code")).toHaveValue("90001");
  const p1 = parcel(page, 1);
  await p1.getByLabel("Weight (lb)").fill("1");
  await p1.getByLabel("Length (in)").fill("8");
  await p1.getByLabel("Width (in)").fill("6");
  await p1.getByLabel("Height (in)").fill("4");
  await p1.getByLabel("Packaging").selectOption({ label: "Box" });
  await p1.getByLabel("Share of orders (%)").fill("60");
  await page.getByRole("button", { name: "Add a parcel" }).click();
  const p2 = parcel(page, 2);
  await p2.getByLabel("Weight (lb)").fill("3");
  await p2.getByLabel("Length (in)").fill("10");
  await p2.getByLabel("Width (in)").fill("8");
  await p2.getByLabel("Height (in)").fill("6");
  await p2.getByLabel("Packaging").selectOption({ label: "Mailer" });
  await p2.getByLabel("Share of orders (%)").fill("50");
  // A distribution has to add up to exactly 100.00; nothing is normalised behind the person's back.
  await expect(page.getByText("Shares add up to 110.00%; they must add up to exactly 100.00%.")).toBeVisible();
  await page.getByRole("button", { name: "Spread evenly: parcel shares" }).click();
  await expect(p1.getByLabel("Share of orders (%)")).toHaveValue("50.00");
  await expect(page.getByText("Shares add up to 110.00%")).toHaveCount(0);

  await page.getByRole("group", { name: "Service 1", exact: true }).getByLabel("Service").selectOption({ label: "UPS Ground" });
  await page.getByRole("button", { name: "Spread evenly: service shares" }).click();
  // The zones are the ones the rate card prices for the chosen service.
  const zoneOptions = await page.getByRole("group", { name: "Zone 1", exact: true }).getByLabel("Zone", { exact: true }).locator("option").allInnerTexts();
  expect(zoneOptions).toEqual(["Choose a zone", "Zone 2", "Zone 3", "Zone 4", "Zone 5", "Zone 6", "Zone 7", "Zone 8"]);
  await page.getByRole("group", { name: "Zone 1", exact: true }).getByLabel("Zone", { exact: true }).selectOption({ label: "Zone 2" });
  await page.getByRole("button", { name: "Add a zone" }).click();
  await page.getByRole("group", { name: "Zone 2", exact: true }).getByLabel("Zone", { exact: true }).selectOption({ label: "Zone 4" });
  await page.getByRole("button", { name: "Spread evenly: zone shares" }).click();
  await label(page, "Orders delivered to homes (%)").fill("20");
  // What is in a typical order: two rows.
  const o1 = page.getByRole("group", { name: "Order type 1", exact: true });
  await o1.getByLabel("Items").fill("1");
  await o1.getByLabel("Lines").fill("1");
  await o1.getByLabel("% of orders").fill("60");
  await page.getByRole("button", { name: "Add a row" }).click();
  const o2 = page.getByRole("group", { name: "Order type 2", exact: true });
  await o2.getByLabel("Items").fill("3");
  await o2.getByLabel("Lines").fill("2");
  await o2.getByLabel("% of orders").fill("40");
  // Fulfillment answers: receiving left out for now.
  await answerBox(page, STORAGE_Q, "pallets").fill("12");
  await answerBox(page, LONG_TERM_Q, "pallets").fill("4");
  await question(page, RECEIVING_Q).getByRole("radio", { name: "Not sure, leave it out" }).check();
  await question(page, RETURNS_Q).getByRole("radio", { name: "We don't use this" }).check();
  // The pre-flight line names what will be priced: 2 parcels × 2 zones × 1 service × home or not × one package class.
  await expect(page.getByText("This forecast prices 2 parcels × 2 zones × 1 service × 2 residential splits × 1 package class = 8 cells.")).toBeVisible();

  await page.getByRole("button", { name: "Preview forecast" }).click();
  await expect(page.getByRole("heading", { name: "Your forecast", level: 2 })).toBeVisible();
  await expect(page.getByText(FORECAST_SENTENCE)).toBeVisible();
  // Worked out by hand. Shipping: each parcel is billed up to a whole lb from its size (8×6×4 → 2 lb, 10×8×6 → 4 lb); UPS Ground price = 7 + 0.5 × zone + bracket index
  // (2 lb zone 2 $9.00, zone 4 $10.00; 4 lb zone 2 $11.00, zone 4 $12.00), average over parcels and zones $10.50, plus the $5.00 home-delivery surcharge on 20% of orders: $11.50 a order.
  // Order fees: pick $2.00 + (40% of orders have 3 items: 2 × $0.50) $0.40 + packaging (box $0.75 on half, mailer $0.25 on half) $0.50 + 5% of $11.50 ($0.575) = $3.475.
  const summary = page.getByRole("region", { name: "Forecast headline" });
  await expect(summary).toContainText("All-in cost per order, without receiving");
  await expect(summary).toContainText("At least");
  await expect(summary).toContainText("$15.25"); // 11.50 + 3.475 + 327 / 1,200 (0.2725)
  await expect(summary).toContainText("Counted so far: shipping $11.50 + order fees $3.48 + monthly charges $0.27 (spread over 1,200 orders a month, the volume you gave).");
  await expect(summary).toContainText("At least $18,297.00 a month, $219,564.00 a year if every month looked like this.");
  // What is left out has its rate and a way back to the question.
  await expect(summary).toContainText("Not included: not computed from what you gave");
  await expect(summary).toContainText("Pallet receiving (receiving)");
  await expect(summary).toContainText("Not computed: no number was given.");
  await expect(page.getByText("Minimum: $500.00 · Fees counted so far: $4,422.00. They already meet the minimum, so it adds nothing, whatever the fees that could not be computed come to (Pallet receiving is not computed).")).toBeVisible();
  await expect(table(page, "Cost per order at other volumes").getByRole("columnheader", { name: "All-in, at least" })).toBeVisible();
  // "Add" takes the person to the question itself (its first control), not to the top of the form.
  await page.getByRole("button", { name: "Add numbers for Pallet receiving" }).click();
  await expect(question(page, RECEIVING_Q).getByRole("radio", { name: "Enter a number" })).toBeFocused();

  // Answer receiving: the preview is now stale (and says so), then the whole forecast is worked out.
  await answerBox(page, RECEIVING_Q, "pallets").fill("6");
  await expect(page.getByText("You changed the forecast since this preview. Preview again to update it; saving needs a current preview.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save forecast" })).toBeDisabled();
  await page.getByRole("button", { name: "Preview again" }).click();
  await expect(page.getByText("You changed the forecast since this preview.")).toHaveCount(0);
  const full = page.getByRole("region", { name: "Forecast headline" });
  await expect(full).toContainText("All-in cost per order");
  await expect(full).not.toContainText("without");
  await expect(full).not.toContainText("At least");
  await expect(full).toContainText("$15.31"); // 11.50 + 3.475 + 399 / 1,200 (0.3325)
  await expect(full).toContainText("About $18,369.00 a month, $220,428.00 a year if every month looked like this.");
  await expect(full).toContainText("Shipping $11.50 + order fees $3.48 + monthly charges $0.33 (spread over 1,200 orders a month, the volume you gave).");
  await expect(page.getByText("$13,800.00 a month, $11.50 per order on average, from your rate card.", { exact: false })).toBeVisible();
  await expect(page.getByText("$4,170.00 a month, $3.48 per order on average. Fees charged per order only; monthly charges are below.")).toBeVisible();
  const feeRow = (name: string) => table(page, "Order fees").getByRole("row").filter({ has: page.getByRole("cell", { name: new RegExp(`^${name}`) }) });
  await expect(feeRow("Pick & pack, per order").getByRole("cell").nth(1)).toHaveText("100.00%");
  await expect(feeRow("Pick & pack, per order").getByRole("cell").nth(3)).toHaveText("$2,400.00");
  await expect(feeRow("Each additional item").getByRole("cell").nth(1)).toHaveText("40.00%");
  await expect(feeRow("Each additional item").getByRole("cell").nth(3)).toHaveText("$480.00");
  await expect(feeRow("Box packaging").getByRole("cell").nth(3)).toHaveText("$450.00"); // half of 1,200 × $0.75
  await expect(feeRow("Mailer packaging").getByRole("cell").nth(3)).toHaveText("$150.00"); // half of 1,200 × $0.25
  await expect(feeRow("Shipping handling").getByRole("cell").nth(3)).toHaveText("$690.00"); // 5% of $13,800
  const monthlyRow = (name: string) => table(page, "Monthly charges").getByRole("row").filter({ has: page.getByRole("cell", { name: new RegExp(`^${name}`) }) });
  await expect(monthlyRow("Pallet storage")).toContainText("8 pallets × $18.00 = $144.00 a month.");
  await expect(monthlyRow("Long-term pallet storage")).toContainText("4 pallets × $27.00 = $108.00 a month.");
  await expect(monthlyRow("Pallet receiving")).toContainText("6 pallets × $12.00 = $72.00 a month.");
  await expect(monthlyRow("Returns processing")).toContainText("0 returns × $3.00 = $0.00 a month.");
  // The flat monthly fee is the one line of a forecast that is not an estimate, and it comes from the fee schedule, not the rate card.
  await expect(monthlyRow("Account administration")).toContainText("From your fee schedule");
  await expect(table(page, "Monthly charges")).not.toContainText("From your rate card");
  // An exact minimum: fees counted = order fees 4,170 + storage 144 + long-term 108 + receiving 72 + returns 0.
  await expect(page.getByText("Fees counted toward the minimum: $4,494.00 · Minimum: $500.00 · Added: $0.00")).toBeVisible();
  const volumeRow = (name: RegExp) => table(page, "Cost per order at other volumes").getByRole("row", { name });
  await expect(volumeRow(/^0\.5× your volume/)).toContainText("$15.64"); // 11.50 + 3.475 + 399 / 600
  await expect(volumeRow(/^Your forecast/)).toContainText("$15.31");
  await expect(volumeRow(/^4× your volume/)).toContainText("$15.06"); // 11.50 + 3.475 + 399 / 4,800
  await expect(page.getByRole("heading", { name: "What this forecast assumes" })).toBeVisible();
  await expect(page.getByText("Every order ships from ZIP code 90001.")).toBeVisible();
  await expect(page.getByText(`fee schedule ${state.scheduleName}, in effect from Jan 1, 2026.`, { exact: false })).toBeVisible();
  await expectNoInternals(page, "forecast preview");

  // Save.
  await label(page, "Forecast name").fill(state.forecastName);
  await page.getByRole("button", { name: "Save forecast" }).click();
  await expect(page).toHaveURL(/\/portal\/model\/forecast\/[0-9a-f-]{36}$/);
  state.forecastId = uuid(page.url(), "forecast");
  persist();
});

test("the saved forecast keeps its figures and its assumptions, can be edited as a new forecast, and the overview shows it as a separate labelled tile", async ({ page }) => {
  await asBrand(page);
  await page.goto(`/portal/model/forecast/${state.forecastId}`);
  await expect(page.getByRole("heading", { name: state.forecastName, level: 1 })).toBeVisible();
  await expect(page.getByText("Saved forecast", { exact: true })).toBeVisible();
  await expect(page.getByText(FORECAST_SENTENCE)).toBeVisible();
  await expect(page.getByText(/Assumptions entered by you on [A-Z][a-z]{2} \d{1,2}, \d{4}\./)).toBeVisible();
  const headlineCard = page.getByRole("region", { name: "Forecast headline" });
  await expect(headlineCard).toContainText("All-in cost per order");
  await expect(headlineCard).toContainText("$15.31");
  await expect(headlineCard).toContainText("Shipping $11.50 + order fees $3.48 + monthly charges $0.33");
  await expect(page.getByRole("heading", { name: "What this forecast assumes" })).toBeVisible();
  await expect(page.getByText("Each choice you made (parcel, zone, service, home or business delivery, packages per order, what is in the order) is treated as independent of the others.", { exact: false })).toBeVisible();
  await expect(page.getByText("Delivery-area and remote-area surcharges depend on the destination ZIP code, which a forecast does not have, so they are never included.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "If your volume were different" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Account minimum", level: 2 })).toBeVisible();
  await expectNoInternals(page, "saved forecast");
  await expectNoInternalsInSource(page, `/portal/model/forecast/${state.forecastId}`);

  // Edit as a new forecast: the form opens with what was described and saving would make a second forecast.
  const edit = page.getByRole("link", { name: "Edit as new forecast" });
  await expect(edit).toHaveAttribute("href", `/portal/model/forecast?from=${state.forecastId}`);
  await edit.click();
  await expect(page.getByText(`Starting from ${state.forecastName} (priced on`, { exact: false })).toBeVisible();
  await expect(label(page, "Orders a month")).toHaveValue("1200");
  await expect(parcel(page, 2).getByLabel("Weight (lb)")).toHaveValue("3");
  await expect(answerBox(page, RECEIVING_Q, "pallets")).toHaveValue("6");

  // The overview: the file's model keeps its tiles, the forecast is its own labelled tile, never mixed into them.
  await page.goto("/portal");
  await expect(page.getByRole("heading", { name: "From your latest model" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Forecasts and what-ifs" })).toBeVisible();
  const tile = stat(page, "Forecast from assumptions: All-in cost per order");
  await expect(tile).toHaveText("$15.31");
  await expect(page.getByRole("link", { name: state.forecastName }).first()).toBeVisible();
  await expect(page.getByText("Expected values over the mix you described, never an invoice.")).toBeVisible();
  // The latest model's headline is the file run's own figure (the second run, receiving answered), not the forecast's.
  const latest = page.getByRole("heading", { name: "From your latest model" }).locator("xpath=following-sibling::*[1]");
  await expect(latest).toContainText("All-in cost per order");
  await expect(latest).not.toContainText("$15.31");
  await expectNoInternals(page, "overview");
});

// ---------------------------------------------------------------------------
// 5. Compare the file run with the forecast
// ---------------------------------------------------------------------------
test("comparing the file run with the forecast shows what each is based on, the comparable row, and what differs in the assumptions", async ({ page }) => {
  await asBrand(page);
  const escaped = state.forecastName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // From the list: the file's scenario (its latest run, receiving answered) offers Compare, then the forecast is chosen as the second model.
  await page.goto("/portal/reports");
  await page.locator(`a[href="/portal/reports?a=${state.secondRunId}"]`).click();
  await expect(page.getByText("Choose a second model:")).toBeVisible();
  await page.getByRole("link", { name: new RegExp(`^Forecast: ${escaped}`) }).click();
  const answered = page.getByRole("region", { name: "Comparison" });
  await expect(answered).toBeVisible();
  // Same fulfillment answers on both sides, so nothing differs in them; what the all-in leaves out still differs.
  await expect(page.getByText("What differs in the assumptions")).toHaveCount(0);
  await expect(answered.getByRole("row", { name: /^Left out of the all-in/ })).toContainText("the account minimum (not worked out exactly)");
  await expect(answered.getByRole("row", { name: /^Left out of the all-in/ })).toContainText("Nothing left out");
  await expect(answered.getByRole("row", { name: /^Shipping \+ order fees \(comparable\)/ })).toContainText("$20.47");

  // The first run (receiving left out) against the same forecast.
  await page.goto(`/portal/reports?a=${state.runId}`);
  await expect(page.getByText("Choose a second model:")).toBeVisible();
  await page.getByRole("link", { name: new RegExp(`^Forecast: ${escaped}`) }).click();
  const comparison = page.getByRole("region", { name: "Comparison" });
  await expect(comparison).toBeVisible();
  const row = (name: string | RegExp) => comparison.getByRole("row", { name });
  // What each is based on.
  await expect(row(/^Based on Orders file/)).toContainText("Forecast from assumptions");
  await expect(row(/^Orders a month/)).toContainText("23 (from the file)");
  await expect(row(/^Orders a month/)).toContainText("1,200 (as described)");
  await expect(row(/^Period/)).toContainText("Mar 2, 2026–Apr 1, 2026 (1 month)");
  await expect(row(/^Period/)).toContainText("A typical month, as described");
  await expect(row(/^Fee schedule/)).toContainText(`'${state.scheduleName}', in effect from Jan 1, 2026`);
  await expect(row(/^Orders modeled/)).toContainText("18 of 24 (75.0%)");
  await expect(row(/^Orders modeled/)).toContainText("100.00% of the volume");
  await expect(row(/^Left out of the all-in/)).toContainText("receiving");
  await expect(row(/^Left out of the all-in/)).toContainText("Nothing left out");
  // The row that stays comparable: shipping plus order fees. File: $300.50 / 18 + $68.025 / 18 = $20.47; forecast: $11.50 + $3.475 = $14.975 → $14.98.
  await expect(row(/^Shipping \+ order fees \(comparable\)/)).toContainText("$20.47");
  await expect(row(/^Shipping \+ order fees \(comparable\)/)).toContainText("$14.98");
  // The all-in rows are not comparable: one leaves receiving out and the other nothing, and the table says so instead of ranking them.
  await expect(row(/^All-in cost per order \(not comparable\)/)).toContainText("At least $30.26 (without receiving)");
  await expect(row(/^All-in cost per order \(not comparable\)/)).toContainText("$15.31");
  await expect(comparison.getByText('Compare "Shipping + order fees" instead.', { exact: false }).first()).toBeVisible();
  // Warnings and the assumptions that differ.
  await expect(page.getByText("One of these is a forecast from assumptions and the other is built from an orders file.", { exact: false })).toBeVisible();
  await expect(page.getByText("The two models are at different volumes (23 and 1,200 orders a month)", { exact: false })).toBeVisible();
  await expect(page.getByText("What differs in the assumptions")).toBeVisible();
  await expect(page.getByText("pallet receiving left out → 6", { exact: true })).toBeVisible();
  await expectNoInternals(page, "compare");

  // Two file runs: only the receiving answer differs.
  await page.goto(`/portal/reports?a=${state.runId}&b=${state.secondRunId}`);
  const files = page.getByRole("region", { name: "Comparison" });
  await expect(files.getByRole("row", { name: /^Shipping \+ order fees \(comparable\)/ })).toContainText("$20.47");
  await expect(page.getByText("pallet receiving left out → 6", { exact: true })).toBeVisible();
  await expect(files.getByRole("row", { name: /^Left out of the all-in/ })).toContainText("the account minimum (not worked out exactly)");
});

// ---------------------------------------------------------------------------
// 6. The 3PL on the customer's behalf; what the customer may read
// ---------------------------------------------------------------------------
test("the 3PL sees the customer's run with its provenance, prepares one with its own answers, and the customer sees it only once shared", async ({ page, browser }) => {
  test.setTimeout(240_000);
  await asStaff(page);
  const base = `/app/customers/${state.brandId}/model`;

  // The customer's own run, read by the 3PL: the same figures, and whose assumptions they are.
  await page.goto(`${base}/runs/${state.runId}?view=allin`);
  await expect(page.getByText("Shared with the customer", { exact: true })).toBeVisible();
  await expect(page.getByText(/^Assumptions entered by another user on [A-Z][a-z]{2} \d{1,2}, \d{4}\.$/)).toBeVisible();
  await expect(headline(page, "All-in cost per order, without receiving")).toContainText("At least");
  await expect(page.getByText(`${state.company} fee schedule '${state.scheduleName}', in effect from Jan 1, 2026.`)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Not on this customer's fee schedule" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Add numbers for Pallet receiving" }).first()).toHaveAttribute("href", "#run-again");
  const staffOrders = await page.request.get(`/api/runs/${state.runId}/orders.csv?brandId=${state.brandId}`);
  expect(staffOrders.status()).toBe(200);
  expect(await staffOrders.text()).toContain("order_id,order_date,units,lines,packages,shipments,shipping_expected,order_fees,shipping_plus_fees,fee_status,not_computed");

  // The 3PL runs the same file on the customer's behalf with its own answers (this wording speaks of "the customer").
  await page.goto(`${base}/orders/${state.datasetId}`);
  await label(page, "Scenario name (optional)").fill(`Prepared by the 3PL ${rid}`);
  await page.getByRole("button", { name: "Continue to fulfillment costs" }).click();
  await expect(page.getByText(`The customer's fee schedule ${state.scheduleName} (in effect from Jan 1, 2026) charges for things the orders file does not say.`, { exact: false })).toBeVisible();
  await answerBox(page, STORAGE_Q, "pallets").fill("10");
  await question(page, LONG_TERM_Q).getByRole("radio", { name: "We don't use this" }).check();
  await answerBox(page, RECEIVING_Q, "pallets").fill("5");
  await answerBox(page, RETURNS_Q, "percent of orders").fill("2");
  await page.getByRole("button", { name: "Run the model" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  const staffRunId = uuid(page.url(), "runs");
  await expect(page.getByText("Estimated shipping cost per order").first()).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText("Private to your team", { exact: true })).toBeVisible();
  await expect(page.getByText(/^Assumptions entered by you on [A-Z][a-z]{2} \d{1,2}, \d{4}\.$/)).toBeVisible();
  await page.goto(`${base}/runs/${staffRunId}?view=allin`);
  // Worked out by hand: storage 10 × $18.00 = $180.00, no long-term pallets, receiving 5 × $12.00 = $60.00, administration $75.00: $315.00 whatever you ship.
  // Returns scale with the volume: 2% of 22.9753 orders a month = 0.4595 returns × $3.00 = $1.38 (a charge that grows with orders).
  await expect(page.getByText("$315.00 a month, whatever you ship", { exact: true })).toBeVisible();
  await expect(page.getByText("plus $1.38 a month in charges that grow with your orders", { exact: true })).toBeVisible();
  const monthly = page.getByRole("region", { name: "Monthly charges" });
  await expect(monthly).toContainText("10 pallets × $18.00 = $180.00 a month.");
  await expect(monthly).toContainText("5 pallets × $12.00 = $60.00 a month.");
  await expect(monthly).toContainText("0.4595 returns × $3.00 = $1.38 a month.");
  await expect(headline(page, "All-in cost per order")).toBeVisible();

  // The customer cannot open it while it is private to the 3PL...
  const customer = await browser.newContext({ baseURL: "http://localhost:3000" });
  const cp = await customer.newPage();
  await asBrand(cp);
  const hidden = await cp.goto(`/portal/model/runs/${staffRunId}`);
  expect(hidden?.status()).toBe(404);
  expect((await cp.request.get(`/api/runs/${staffRunId}/orders.csv`)).status()).toBe(404);
  await cp.goto("/portal/reports");
  await expect(cp.getByText(`Prepared by the 3PL ${rid}`)).toHaveCount(0);

  // ...until it is shared. Then it reads "entered by" the 3PL, not "you".
  await page.goto(`${base}/reports`);
  const scenario = page.getByRole("listitem").filter({ hasText: `Prepared by the 3PL ${rid}` });
  await scenario.getByRole("button", { name: "Share with customer" }).click();
  await scenario.getByRole("button", { name: "Share", exact: true }).click();
  await expect(scenario.getByRole("button", { name: "Hide from customer" })).toBeVisible();
  await cp.goto(`/portal/model/runs/${staffRunId}?view=allin`);
  await expect(cp.getByRole("heading", { name: new RegExp(`Prepared by the 3PL ${rid}`) })).toBeVisible();
  await expect(cp.getByText(new RegExp(`^Assumptions entered by ${state.company} on [A-Z][a-z]{2} \\d{1,2}, \\d{4}\\.$`))).toBeVisible();
  await expect(cp.getByText("$315.00 a month, whatever you ship", { exact: true })).toBeVisible();
  await expectNoInternals(cp, "a run the 3PL prepared and shared");
  await customer.close();
});

test("nothing the 3PL wrote for its own eyes reaches any page the customer can open, and the fee schedule page reads as the 3PL previewed it", async ({ page }) => {
  test.setTimeout(150_000);
  await asBrand(page);
  // The fee schedule page: the schedule in the customer's words, the 3PL's name and dates, and no staff notes, sources or keys.
  await page.goto("/portal/model/fees");
  await expect(page.getByRole("heading", { name: state.scheduleName, level: 2 })).toBeVisible();
  await expect(page.getByText(state.scheduleDescription)).toBeVisible();
  await expect(page.getByText(`${state.company} fee schedule “${state.scheduleName}”, in effect from Jan 1, 2026. Assigned to you on`, { exact: false })).toBeVisible();
  await expect(page.getByText("$2.00 per order.", { exact: true })).toBeVisible();
  await expect(page.getByText("Covers picking and packing the first item of every order.")).toBeVisible();
  await expect(page.getByText("Count each pallet position you use, averaged over the month.")).toBeVisible();
  await expect(page.getByText("$0.50 per item after the first item in each order.", { exact: true })).toBeVisible();
  await expect(page.getByText("Only one of these applies each time: Box packaging, Mailer packaging, Other packaging.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Fees counted toward this minimum" })).toHaveCount(0); // a label, not a heading
  await expect(page.getByText("Fees counted toward this minimum")).toBeVisible();
  await expect(page.getByText("What this page does not cover")).toBeVisible();
  // No edit controls for a customer.
  await expect(page.getByRole("button", { name: /Add rule|Activate|Save/ })).toHaveCount(0);
  await expectNoInternals(page, "the customer's fee schedule page");
  await expectNoInternalsInSource(page, "/portal/model/fees");

  const pages: [string, string][] = [
    ["overview", "/portal"],
    ["hub", "/portal/model"],
    ["calculator", "/portal/model/calculator"],
    ["forecast form", "/portal/model/forecast"],
    ["forecast", `/portal/model/forecast/${state.forecastId}`],
    ["orders file", `/portal/model/orders/${state.datasetId}`],
    ["run, shipping", `/portal/model/runs/${state.runId}?view=shipping`],
    ["run, order fees", `/portal/model/runs/${state.runId}?view=fees`],
    ["run, all-in", `/portal/model/runs/${state.runId}?view=allin`],
    ["second run, all-in", `/portal/model/runs/${state.secondRunId}?view=allin`],
    ["reports", "/portal/reports"],
    ["comparison", `/portal/reports?a=${state.runId}&b=${state.secondRunId}`],
    ["account", "/portal/account"],
  ];
  for (const [name, url] of pages) {
    await page.goto(url);
    await expect(page.locator("main")).toBeVisible();
    await expectNoInternals(page, name);
    await expectNoInternalsInSource(page, url);
  }
  // Exports too: both CSVs of both runs, and the shipment-level one.
  for (const run of [state.runId, state.secondRunId]) {
    for (const kind of ["orders", "monthly", "results"]) {
      const res = await page.request.get(`/api/runs/${run}/${kind}.csv`);
      expect(res.status(), `${kind}.csv`).toBe(200);
      const body = await res.text();
      for (const secret of [...RULE_KEYS, ...QUESTION_KEYS, NOTES_SENTINEL, SOURCE_SENTINEL]) expect(body, `${kind}.csv of ${run}`).not.toContain(secret);
    }
  }
  // The 3PL's notes and sources exist (so the sweep proves something): they are staff-only rows the customer has no policy for.
  const [notes] = await sql<{ notes: string }>("select notes from public.fee_schedule_version_notes where version_id = $1", [state.versionId]);
  expect(notes?.notes).toBe(NOTES_SENTINEL);
  const [sources] = await sql<{ n: string }>("select count(*)::text as n from public.fee_rule_sources where source_reference = $1", [SOURCE_SENTINEL]);
  expect(sources?.n).toBe("1");
});

// ---------------------------------------------------------------------------
// 7. Another customer and another 3PL
// ---------------------------------------------------------------------------
test("another customer and another 3PL cannot open the fee schedule, the run or the forecast by URL", async ({ browser }) => {
  test.setTimeout(150_000);
  const forecastRun = (await sql<{ id: string }>("select r.id from public.simulation_runs r join public.simulation_projects p on p.id = r.project_id where p.id = $1", [state.forecastId]))[0]!.id;
  const other = await browser.newContext({ baseURL: "http://localhost:3000" });
  const page = await other.newPage();
  await signInAs(page, state.otherBrandEmail, /\/portal$/);
  // Their own fee schedule page has nothing of ours.
  await page.goto("/portal/model/fees");
  await expect(page.getByRole("heading", { name: "No fee schedule yet" })).toBeVisible();
  await expect(page.getByText(state.scheduleName)).toHaveCount(0);
  for (const url of [
    `/portal/model/runs/${state.runId}`,
    `/portal/model/runs/${state.secondRunId}?view=allin`,
    `/portal/model/forecast/${state.forecastId}`,
    `/portal/model/forecast?from=${state.forecastId}`,
    `/portal/model/orders/${state.datasetId}`,
  ]) {
    const res = await page.goto(url);
    // `?from=` of a forecast that is not theirs opens an empty form, never ours; every other address is not found.
    if (url.includes("?from=")) {
      await expect(page.getByText("Describe the orders you expect")).toBeVisible();
      await expect(page.getByText(state.forecastName)).toHaveCount(0);
      continue;
    }
    expect(res?.status(), url).toBe(404);
    await expect(page.getByText("Orders modeled"), url).toHaveCount(0);
    await expect(page.getByText(state.forecastName), url).toHaveCount(0);
  }
  for (const kind of ["orders", "monthly", "results"]) expect((await page.request.get(`/api/runs/${state.runId}/${kind}.csv`)).status(), `${kind}.csv`).toBe(404);
  expect((await page.request.get(`/api/runs/${forecastRun}/monthly.csv`)).status()).toBe(404);
  // Neither run nor forecast can be compared into their reports.
  await page.goto(`/portal/reports?a=${state.runId}&b=${forecastRun}`);
  await expect(page.getByRole("region", { name: "Comparison" })).toHaveCount(0);
  await expect(page.getByText(state.forecastName)).toHaveCount(0);
  // The 3PL's pages are not theirs at all.
  const staffPage = await page.goto(`/app/fee-schedules/${state.scheduleId}`);
  expect(staffPage?.status() === 404 || !page.url().includes("/app/fee-schedules/"), "a customer on the 3PL's fee schedule page").toBe(true);
  await expect(page.getByText(state.scheduleName)).toHaveCount(0);
  await other.close();

  // Another 3PL, in its own workspace.
  const stranger = await browser.newContext({ baseURL: "http://localhost:3000" });
  const sp = await stranger.newPage();
  await signUpAndConfirm(sp, { name: "Stan Stranger", email: state.otherTenantEmail, company: `Other Fictional 3PL ${rid}` });
  await sp.getByRole("button", { name: "Create workspace" }).click();
  await expect(sp).toHaveURL(/\/app$/);
  await sp.goto("/app/fee-schedules");
  await expect(sp.getByRole("heading", { name: "No fee schedules yet" })).toBeVisible();
  await expect(sp.getByText(state.scheduleName)).toHaveCount(0);
  for (const url of [
    `/app/fee-schedules/${state.scheduleId}`,
    `/app/fee-schedules/${state.scheduleId}/versions/${state.versionId}`,
    `/app/customers/${state.brandId}`,
    `/app/customers/${state.brandId}/model/runs/${state.runId}`,
    `/app/customers/${state.brandId}/model/runs/${state.secondRunId}?view=allin`,
    `/app/customers/${state.brandId}/model/forecast/${state.forecastId}`,
    `/app/customers/${state.brandId}/model/orders/${state.datasetId}`,
  ]) {
    const res = await sp.goto(url);
    expect(res?.status(), url).toBe(404);
    await expect(sp.getByText(state.scheduleName), url).toHaveCount(0);
    await expect(sp.getByText(state.brandName), url).toHaveCount(0);
  }
  for (const kind of ["orders", "monthly", "results"]) expect((await sp.request.get(`/api/runs/${state.runId}/${kind}.csv?brandId=${state.brandId}`)).status(), `${kind}.csv`).toBe(404);
  // The version's notes and sources are not readable through the data API either: the other 3PL has no row to read.
  await stranger.close();
});

// ---------------------------------------------------------------------------
// 8. The calculator's "What's in the box"
// ---------------------------------------------------------------------------
test("the calculator prices shipping always, and order fees once the box is described", async ({ page }) => {
  test.setTimeout(150_000);
  await asBrand(page);
  await page.goto("/portal/model/calculator");
  const box = page.getByRole("group", { name: "What's in the box" });
  await expect(box).toBeVisible(); // it appears once the schedule's options have loaded
  await expect(box).toContainText(`Fee schedule ${state.scheduleName}, in effect from Jan 1, 2026.`);
  await label(page, "Origin ZIP").fill("90001");
  await label(page, "Destination ZIP").fill("85001");
  await label(page, "Weight").fill("3");
  await label(page, "Service").selectOption({ label: "UPS Ground" });
  // Packaging chosen but no items: shipping is still priced (3 lb, zone 5: $11.50) and the fees ask for the box.
  await box.getByLabel("Packaging", { exact: true }).selectOption({ label: "Box" });
  await page.getByRole("button", { name: "Calculate", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Result: UPS Ground" })).toBeVisible();
  await expect(stat(page, "Estimated total")).toHaveText("$11.50");
  await expect(page.getByText("Add what's in the box to see order fees.")).toBeVisible();
  await expect(page.getByText("Shipping + order fees for this order (monthly charges not included)")).toHaveCount(0);

  // An impossible box is refused where it is typed.
  await box.getByLabel("Items (units)").fill("2");
  await box.getByLabel("Different products").fill("3");
  await page.getByRole("button", { name: "Calculate", exact: true }).click();
  await expect(page.getByText("Different products can't be more than the items in the box.")).toBeVisible();

  // 3 items in a box: pick $2.00 + 2 extra items $1.00 + box $0.75 + 5% of $11.50 ($0.575) = $4.325 → $4.33; with shipping $15.83.
  await box.getByLabel("Items (units)").fill("3");
  await box.getByLabel("Different products").fill("2");
  await page.getByRole("button", { name: "Calculate", exact: true }).click();
  const heading = page.getByRole("heading", { name: "Shipping + order fees for this order (monthly charges not included)" });
  await expect(heading).toBeVisible();
  await expect(page.getByText("In the box: 3 items, 2 different products, packaging: Box.").first()).toBeVisible();
  await expect(stat(page, "Shipping")).toHaveText("$11.50");
  await expect(stat(page, "Order fees")).toHaveText("$4.33");
  await expect(stat(page, "Shipping + order fees")).toHaveText("$15.83");
  await expect(page.getByText("1 order × $2.00 = $2.00.")).toBeVisible();
  await expect(page.getByText("2 items × $0.50 = $1.00.")).toBeVisible();
  await expect(page.getByText("1 package × $0.75 = $0.75.")).toBeVisible();
  await expect(page.getByText("5% of the shipping cost ($11.50).")).toBeVisible();
  // Monthly charges are not in the figure, and the page says nothing about storage, receiving or the minimum as if they were.
  await expect(page.getByText("Pallet storage")).toHaveCount(0);
  await expectNoInternals(page, "calculator with order fees");

  // Comparing every service adds a "Shipping + order fees" column; at tablet width the page itself must not scroll sideways.
  await label(page, "Service").selectOption({ label: "Compare all services" });
  await page.getByRole("button", { name: "Calculate", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^Results: \d+ services$/ })).toBeVisible();
  // One more column in the comparison: shipping + order fees for the box described, each service worked out by hand
  // (3 lb to zone 5: UPS Ground $11.50 + fees $4.33; USPS Ground Advantage $12.50 + $4.38; UPS 2nd Day Air $16.50 + $4.58, each rounded once).
  const comparisonRow = (name: string) => page.locator("summary").filter({ hasText: name });
  await expect(comparisonRow("UPS Ground")).toContainText("$15.83");
  await expect(comparisonRow("USPS Ground Advantage")).toContainText("$16.88");
  await expect(comparisonRow("UPS 2nd Day Air")).toContainText("$21.08");
  await expect(page.getByText("Order fees are for the box described above; monthly charges are not included.", { exact: false })).toBeVisible();
  await page.setViewportSize({ width: 700, height: 900 });
  await expectNoHorizontalScroll(page, "calculator comparison at 700px");
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalScroll(page, "calculator comparison at 390px");
});

// ---------------------------------------------------------------------------
// 8b. A clean, short file: a stated volume, nothing left out, an exact account minimum
// ---------------------------------------------------------------------------
test("a clean file that covers only days needs a stated volume, opens on the plain all-in label and shows the exact account minimum", async ({ page }) => {
  test.setTimeout(240_000);
  await asBrand(page);
  await page.goto("/portal/model");
  await label(page, "Orders file").setInputFiles(path.join(FIXTURES, "orders-clean-week.csv"));
  await page.getByRole("button", { name: "Upload and review" }).click();
  await expect(page).toHaveURL(/\/portal\/model\/orders\/[0-9a-f-]{36}$/);
  state.cleanDatasetId = uuid(page.url(), "orders");
  await page.getByRole("button", { name: "Save and check the file" }).click();
  await expect(page.getByRole("heading", { name: "Does this look right?" })).toBeVisible();
  await expect(page.getByText("6 of 6 orders can be priced (100%)")).toBeVisible();
  await page.getByRole("button", { name: "Looks right — prepare for modeling" }).click();
  await expect(page.getByText("Ready to model. Choose the rates below.")).toBeVisible();

  // Four days is too short to say what a month looks like: the customer states it, and there is no "use this volume" to pick.
  await page.getByRole("button", { name: "Continue to fulfillment costs" }).click();
  await expect(page.getByText("Your file covers only 4 days (Mar 2, 2026–Mar 5, 2026), too short to turn into a monthly volume. State your usual number of orders a month to see monthly charges per order.")).toBeVisible();
  await expect(page.getByRole("radio", { name: "Use this volume" })).toHaveCount(0);
  await label(page, "Orders a month (optional)").fill("20");
  await answerBox(page, STORAGE_Q, "pallets").fill("12");
  await answerBox(page, LONG_TERM_Q, "pallets").fill("4");
  await answerBox(page, RECEIVING_Q, "pallets").fill("6");
  await question(page, RETURNS_Q).getByRole("radio", { name: "We don't use this" }).check();
  await page.getByRole("button", { name: "Run the model" }).click();
  await expect(page).toHaveURL(/\/portal\/model\/runs\/[0-9a-f-]{36}$/);
  state.cleanRunId = uuid(page.url(), "runs");
  persist();

  // Every order priced, every question answered, every order dated: the figure is exact, so the page opens on All-in with the plain label.
  const h = headline(page, "All-in cost per order");
  await expect(h).toBeVisible({ timeout: 120_000 });
  await expect(viewLink(page, "All-in")).toHaveAttribute("aria-current", "true");
  await expect(h).not.toContainText("At least");
  await expect(headline(page, /without/)).toHaveCount(0);
  await expect(h).not.toContainText("Not included");
  await expect(h).toContainText("20 orders a month, the volume you stated (your file covers Mar 2, 2026–Mar 5, 2026 (0.13 months))");
  // The six orders by hand: shipping 17.50 + 12.50 + 14.50 + 9.50 + 8.00 + 22.00 = 84.00 (an average of $14.00);
  // fees 4.125 + 3.375 + 3.475 + 4.225 + 2.65 + 3.85 = $21.70 (an average of $3.6167, shown as $3.62).
  await expect(part(h, /^Shipping/)).toHaveText("$14.00");
  await expect(part(h, /^Order fees/)).toHaveText("$3.62");
  const monthlyShown = Number((await part(h, /^Monthly charges, spread over your orders/).innerText()).replace(/[$,]/g, ""));
  await expect(part(h, /^Monthly charges, spread over your orders/)).toContainText("$"); // (399 + the minimum's top-up) over 20 orders
  await expect(h).toContainText(`$${cents(14 + 21.7 / 6 + monthlyShown)}`);
  const fees = page.getByRole("region", { name: "Order fees by charge" });
  const cellOf = (name: string, index: number) => fees.getByRole("row").filter({ has: page.getByRole("cell", { name: new RegExp(`^${name}`) }) }).getByRole("cell").nth(index);
  await expect(cellOf("Pick & pack, per order", 2)).toHaveText("$12.00");
  await expect(cellOf("Each additional item", 2)).toHaveText("$1.50"); // C-2001 one extra item, C-2004 two
  await expect(cellOf("Box packaging", 2)).toHaveText("$3.75");
  await expect(cellOf("Mailer packaging", 2)).toHaveText("$0.25");
  await expect(cellOf("Shipping handling", 2)).toHaveText("$4.20"); // 5% of $84.00
  await expect(page.getByText("Priced for 6 of 6 orders that could be priced, an average of $3.62 per order.", { exact: false })).toBeVisible();
  await expect(page.getByText("$399.00 a month, whatever you ship", { exact: true })).toBeVisible();
  await expect(page.getByText("about $19.95 per order at 20 orders a month", { exact: false })).toBeVisible();

  // The account minimum is worked out exactly, over the 4 days the file covers (4/31 of a month, so the minimum is prorated):
  // minimum 500 × 0.129032 = $64.52; counted = order fees $21.70 + storage 18.58 + long-term 13.94 + receiving 9.29 (each × 0.129032, rounded once) = $63.51; added $1.01.
  const minimum = page.getByRole("heading", { name: "Account minimum", level: 2 }).locator("xpath=ancestor::*[contains(@class,'space-y-5')][1]");
  await expect(minimum.getByText("Worked out", { exact: true })).toBeVisible();
  await expect(minimum.getByText("Fees counted toward the minimum: $63.51 · Minimum: $64.52 · Added: $1.01")).toBeVisible();
  await expect(minimum).not.toContainText("could add up to");
  // The window is four days and the customer stated the volume: the card says the amount comes from the days in the file, not from the 20 orders a month.
  await expect(minimum.getByText("This was worked out from the 4 days in your file, not from the 20 orders a month you stated, so at that volume the amount could be different.")).toBeVisible();
  // $1.01 over 4/31 of a month is $7.83 a month, which is what the monthly charges card adds.
  await expect(page.getByText("The account minimum adds $7.83 a month on top (see Account minimum below)", { exact: false })).toBeVisible();
  await expect(minimum.getByRole("listitem").filter({ hasText: "Pallet receiving" })).toContainText("Counted");
  await expect(page.getByRole("heading", { name: "Left out because no numbers were given" })).toHaveCount(0);
  await expect(page.getByText("Only 100% of your orders could be priced", { exact: false })).toHaveCount(0);
  await expectNoInternals(page, "the clean run");

  // No order is left out, so the orders table has no "not priced" row.
  await expect(page.getByRole("region", { name: "Orders", exact: true }).getByRole("cell", { name: "Not priced" })).toHaveCount(0);
  const orders = await (await page.request.get(`/api/runs/${state.cleanRunId}/orders.csv`)).text();
  expect(orders).toContain("# All-in cost per order: $"); // the plain label, no "without", no "At least"
  expect(orders.split("\r\n").filter((l) => /^C-\d+,/.test(l))).toHaveLength(6);
});

// ---------------------------------------------------------------------------
// 9. Automated accessibility checks (axe, WCAG 2.1 A/AA) on every new screen at desktop width
// ---------------------------------------------------------------------------
test("the 3PL's fee-schedule screens pass automated accessibility checks", async ({ page }) => {
  test.setTimeout(240_000);
  await asStaff(page);
  await page.goto("/app/fee-schedules");
  await expect(page.getByRole("heading", { name: "Fee schedules", level: 1 })).toBeVisible();
  await expectNoSeriousViolations(page, "/app/fee-schedules");
  await page.getByText("What fee schedules cannot model yet").click();
  await expectNoSeriousViolations(page, "/app/fee-schedules (what cannot be modeled, open)");
  await page.goto(`/app/fee-schedules/${state.scheduleId}`);
  await expectNoSeriousViolations(page, "/app/fee-schedules/[id]");
  await page.goto(`/app/fee-schedules/${state.scheduleId}/versions/${state.versionId}`);
  await expect(page.getByRole("heading", { name: "Version 1" })).toBeVisible();
  const form = page.getByRole("form", { name: "Try an order" });
  await label(form, "Items").fill("3");
  await page.getByRole("button", { name: "Price this order" }).click();
  await expect(page.getByText("Not computed", { exact: true })).toBeVisible();
  await expectNoSeriousViolations(page, "/app/fee-schedules/[id]/versions/[id] (active, with a priced order)");

  // A draft: the rule editor with its different sections open, and the activation dialog.
  await page.goto(`/app/fee-schedules/${state.scheduleId}`);
  await label(page, "Start the new draft from").selectOption({ index: 1 });
  await page.getByRole("button", { name: "New draft", exact: true }).click();
  await expect(page).toHaveURL(/\/versions\/[0-9a-f-]{36}$/);
  state.draftVersionId = uuid(page.url(), "versions");
  persist();
  await expect(page.getByRole("heading", { name: "Version 2" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit: Pick & pack, per order" })).toBeVisible(); // a copy keeps every rule
  await expectNoSeriousViolations(page, "a draft version page");
  await page.getByRole("button", { name: "Add rule", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Add a rule" })).toBeVisible();
  await expectNoSeriousViolations(page, "rule editor, empty");
  await label(page, "Preset").selectOption({ label: "Account minimum" });
  await expectNoSeriousViolations(page, "rule editor, account minimum");
  await label(page, "Preset").selectOption({ label: "Long-term storage" });
  await expectNoSeriousViolations(page, "rule editor, long-term storage");
  await page.getByRole("button", { name: "Save rule" }).click(); // an incomplete rule: the error summary and the field errors
  await expect(page.getByRole("alert").filter({ hasText: "This rule cannot be saved yet" })).toBeVisible();
  await expectNoSeriousViolations(page, "rule editor with errors");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Activate…" }).first().click();
  await expect(page.getByRole("dialog", { name: "Activate version 2" })).toBeVisible();
  await expectNoSeriousViolations(page, "activation dialog");
  await page.keyboard.press("Escape");

  await page.goto(`/app/customers/${state.brandId}`);
  await expect(page.getByRole("heading", { name: "Fee schedule", exact: true })).toBeVisible();
  await expectNoSeriousViolations(page, "/app/customers/[id] with its fee schedule");
  const base = `/app/customers/${state.brandId}/model`;
  for (const [name, url] of [
    ["on behalf: run, all-in", `${base}/runs/${state.runId}?view=allin`],
    ["on behalf: forecast", `${base}/forecast/${state.forecastId}`],
    ["on behalf: forecast form", `${base}/forecast`],
    ["on behalf: reports", `${base}/reports`],
  ] as const) {
    await page.goto(url);
    await expect(page.locator("main")).toBeVisible();
    await expectNoSeriousViolations(page, name);
  }
});

test("the customer's fee, run, forecast and calculator screens pass automated accessibility checks", async ({ page }) => {
  test.setTimeout(300_000);
  const [forecastRun] = await sql<{ id: string }>("select r.id from public.simulation_runs r where r.project_id = $1", [state.forecastId]);
  await asBrand(page);
  for (const [name, url] of [
    ["overview", "/portal"],
    ["model hub", "/portal/model"],
    ["fee schedule", "/portal/model/fees"],
    ["run, shipping", `/portal/model/runs/${state.runId}?view=shipping`],
    ["run, order fees", `/portal/model/runs/${state.runId}?view=fees`],
    ["run, all-in", `/portal/model/runs/${state.runId}?view=allin`],
    ["second run, all-in", `/portal/model/runs/${state.secondRunId}?view=allin`],
    ["clean run (opens on all-in), exact account minimum", `/portal/model/runs/${state.cleanRunId}`],
    ["saved forecast", `/portal/model/forecast/${state.forecastId}`],
    ["reports", "/portal/reports"],
    ["comparison", `/portal/reports?a=${state.runId}&b=${forecastRun!.id}`],
  ] as const) {
    await page.goto(url);
    await expect(page.locator("main")).toBeVisible();
    await expectNoSeriousViolations(page, name);
  }
  // Run setup step 2, empty, with its errors, and carried over on a rerun.
  await page.goto(`/portal/model/orders/${state.datasetId}`);
  await page.getByRole("button", { name: "Continue to fulfillment costs" }).click();
  await expect(page.getByText("Step 2 of 2")).toBeVisible();
  await expectNoSeriousViolations(page, "run setup step 2");
  await page.getByRole("button", { name: "Run the model" }).click();
  await expect(page.getByText("4 answers need attention before the run can start.")).toBeVisible();
  await expectNoSeriousViolations(page, "run setup step 2 with errors");
  await page.goto(`/portal/model/runs/${state.runId}`);
  await page.getByRole("button", { name: "Continue to fulfillment costs" }).click();
  await answerBox(page, RECEIVING_Q, "pallets").fill("6");
  await expect(page.getByText("Changed: pallets you send in each month left out → 6")).toBeVisible();
  await expectNoSeriousViolations(page, "run again, step 2 with the change line");

  // The forecast form: empty, with its error summary, and with a preview.
  await page.goto("/portal/model/forecast");
  await expectNoSeriousViolations(page, "forecast form");
  await page.getByRole("button", { name: "Preview forecast" }).click();
  await expect(page.getByText(/^Fix these \d+ before previewing$/)).toBeVisible();
  await expectNoSeriousViolations(page, "forecast form with errors");
  await page.goto(`/portal/model/forecast?from=${state.forecastId}`);
  await expect(label(page, "Orders a month")).toHaveValue("1200");
  await page.getByRole("button", { name: "Preview forecast" }).click();
  await expect(page.getByRole("heading", { name: "Your forecast", level: 2 })).toBeVisible();
  await expectNoSeriousViolations(page, "forecast form with a preview");
  await question(page, RECEIVING_Q).getByRole("radio", { name: "Not sure, leave it out" }).check();
  await page.getByRole("button", { name: "Preview again" }).click();
  await expect(page.getByRole("heading", { name: "Not included: not computed from what you gave" })).toBeVisible();
  await expectNoSeriousViolations(page, "forecast preview with a fee left out");

  // The calculator with order fees, and its comparison of every service.
  await page.goto("/portal/model/calculator");
  const box = page.getByRole("group", { name: "What's in the box" });
  await expect(box).toBeVisible();
  await label(page, "Origin ZIP").fill("90001");
  await label(page, "Destination ZIP").fill("85001");
  await label(page, "Weight").fill("3");
  await box.getByLabel("Items (units)").fill("3");
  await box.getByLabel("Packaging", { exact: true }).selectOption({ label: "Box" });
  await page.getByRole("button", { name: "Calculate", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^Results: \d+ services$/ })).toBeVisible();
  await expectNoSeriousViolations(page, "calculator, every service with order fees");
  await label(page, "Service").selectOption({ label: "UPS Ground" });
  await page.getByRole("button", { name: "Calculate", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Shipping + order fees for this order (monthly charges not included)" })).toBeVisible();
  await expectNoSeriousViolations(page, "calculator, one service with order fees");
});
