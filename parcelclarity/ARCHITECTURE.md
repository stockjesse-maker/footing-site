# Architecture

A **modular monolith**: one Next.js application and one PostgreSQL database (Supabase). No microservices.

```
Browser / iPhone PWA
   │  HTTPS
   ▼
Next.js (App Router, Server Components + Server Actions)         Vercel-compatible
   │  src/proxy.ts: refreshes session cookie, optimistic redirect only
   │  src/lib/auth: server-side data-access layer (validates user, resolves membership)
   │  src/app/actions: Zod-validated, permission-checked mutations
   ▼
Supabase (user's JWT on every request)
   ├─ Auth (GoTrue): identities, email confirmation, recovery
   └─ PostgreSQL + PostgREST: RLS is the enforcement boundary
```

## Principles

1. **Defense in depth, with the database last and strongest.** UI hides what a role cannot do (convenience). Server code re-checks permissions (`requireTenantContext(permission)`, per-action checks). PostgreSQL RLS refuses anything else. Each layer is tested separately.
2. **The user's JWT, always.** `createClient()` in `src/lib/supabase/server.ts` uses the anon key plus the user's session, so RLS applies to every query. There is **no service-role client** in the application today. Operations that need elevation are `SECURITY DEFINER` SQL functions with explicit checks (`create_tenant`, `accept_invitation`, `revoke_invitation`, `platform_set_tenant_status`, `log_audit_event`, `check_rate_limit`, and the pricing lifecycle RPCs `activate_rate_card_version`, `end_rate_card_version`, `archive_rate_card_version`, `publish_surcharge_rule_version`, `retire_surcharge_rule_version`, `publish_zip_list`, `pricing_rules_for_card`; from Milestone 4 also the fee-schedule lifecycle and readers `activate_fee_schedule_version`, `assign_fee_schedule`, `fee_schedule_snapshot`, `brand_fee_schedule_on`, `save_forecast_run` and the other functions listed in DATABASE.md).
3. **The proxy is not a security boundary.** `src/proxy.ts` only keeps the session fresh and redirects signed-out visitors. Next.js docs are explicit that proxies run separately from rendering; authorization lives in server code and RLS.
4. **Pricing engine independence.** Pricing logic lives in `src/engine/`, a pure TypeScript module with no imports from React, Next.js, Supabase or UI code (an ESLint `no-restricted-imports` rule enforces it). `src/lib/pricing/snapshot.ts` is the only bridge: it loads a `PricingContext` under the caller's RLS and hands it to `calculateShipment`. Goal: reuse from an iOS app or external API. Milestone 4 added `src/engine/fees` (the fulfillment fee engine) and `src/engine/forecast` (forecasts from assumptions) to the same pure module, under the same lint rule; the forecast engine receives its hash function through `ForecastDeps` so it imports nothing from Node.
5. **Reproducible calculations.** Every result carries the engine version, rate-card version, terms version, every surcharge rule key@version, ZIP-list versions and overrides it used, and the validated input; rate-card rows, terms and zones are immutable once a version leaves draft, and published rule versions are immutable, so a result can be re-derived later. Bulk runs store, per ship date, the exact version, rule version, ZIP-list and exception ids they priced with (`simulation_run_contexts`), and per shipment a dictionary-encoded result. Fee schedule versions are immutable once active; a run pins the fee schedule and the version in effect on every fee date (`simulation_run_fee_contexts`) and the monthly version, and stores per order the fee lines that were charged.
7. **Bulk work is durable and resumable without a worker.** A bulk run is a database row with a cursor. The server action `advanceRun` prices ~4 seconds' worth of shipments (whole orders, in windows of ≤100) and commits each window through an idempotent function; the browser loops until the run completes and can resume after a reload, a network drop or a backgrounded phone. The batch core (`src/lib/modeling/run.ts`) takes a database client and the run row and never reads cookies, so a worker can call it later without changing the pricing path. The trade-off is documented in IMPLEMENTATION_STATUS.md: a closed tab pauses the run.
6. **Keep the PWA/native door open.** No server-only assumptions in UI components, no reliance on cookies readable by client JS, standard web APIs only; Capacitor packaging remains possible.

## Request flow (authenticated page)

1. `proxy.ts`: `supabase.auth.getUser()` (validated by the Auth server) refreshes cookies; signed-out requests to protected prefixes go to `/login?next=…`.
2. Route-group layout calls `requireTenantContext()` or `requireBrandContext()` (`src/lib/auth/session.ts`): validates the user, loads usable memberships through RLS, picks the active membership (cookie `pc_ctx` is a hint, re-validated every request), redirects on portal mismatch.
3. Page calls `requireTenantContext("permission")` for page-level permission; queries run under RLS; cross-tenant IDs return no rows → `notFound()`.
4. Mutations are Server Actions: Zod parse → permission check (TS mirror of the DB matrix) → rate limit → query under RLS → `revalidatePath`.

## Authentication and sessions

* Supabase Auth with PKCE; email confirmation required.
* `/auth/confirm` is the single landing route for emailed links: PKCE `?code=` (default templates; same browser only) or `?token_hash=` (recommended templates; works cross-device). `next` goes through `safeNext()` to prevent open redirects; failures land on `/login?error=link`.
* Session cookies are HttpOnly, SameSite=Lax, Secure in production (`src/lib/supabase/cookie-options.ts`).
* A password change signs out every other session.

## Multi-membership and context

A user can hold several memberships (e.g. a consultant for two 3PLs). RLS grants the union of what each membership allows; the application narrows each request to the *active* membership and always filters by its `tenant_id`. The workspace switcher appears only when more than one membership exists.

## Directory map

See the README. Notable boundaries: `src/lib/auth` (identity + authorization), `src/components/ui` (design system, no business logic), `src/app/actions` (all writes), `supabase/migrations` (all schema), `src/engine` (pure pricing; `engine/modeling` folds bulk results, `engine/fees` prices fulfillment fees, `engine/forecast` evaluates forecasts), `src/lib/import` (spreadsheet parsing/mapping/validation, pure), `src/lib/pricing` (database → engine context), `src/lib/fees` (fee-schedule read models and the rule schema shared by the editor, the actions and the tests), `src/lib/modeling` (batch run core, run assumptions, the headline function, queries), `src/lib/forecast` (forecast read models and zones), `src/components/pricing` (rate-card, rule and calculator UI), `src/components/fees` (fee-schedule editor and customer view), `src/components/modeling` (runs, results, the fulfillment step), `src/components/forecast`.

## Fulfillment fees, fee-aware runs and forecasts (Milestone 4)

### The fee engine (`src/engine/fees`)

Pure and deterministic, like the shipping engine. Its input is a `FeeScheduleSnapshot`: one version of the customer's fee schedule as `fee_schedule_snapshot` returns it (rules, the version's `rounding`, dates), never a source or a note. Four entry points:

* `calculateOrderFees(order, schedule, context)` prices the order-scope rules for one order from its units, lines, distinct SKUs, packages (with their packaging types), shipments and shipping figures. A rule whose input is unknown and not assumed is **not computed** for that order and listed with the reason; it is never priced as $0.
* `calculateMonthlyFees(answers, schedule, monthlyOrders)` prices the monthly-scope rules from the customer's stated quantities.
* `evaluateMinimums(buckets, schedule, monthly)` works the account minimums out month by month.
* `allocate(input)` turns period totals into monthly and per-order figures over the customer's real monthly volume.

`describeFeeRule` words each rule in the customer's language from the same fields the engine reads, so the editor preview, the customer's fee-schedule view and the tests agree. Amounts are integer ten-thousandths of a dollar (E4) until they are shown; aggregates are rounded to cents once. The rules the golden tests derive from are in `tests/fixtures/fees/RULES.md`; PRICING_ENGINE.md describes them.

### Fold v2 (`src/engine/modeling`)

The batch fold keeps one running `PartialSummary`, now version 2. Beside the shipping figures it carries a `feeDictionary` (rule id, key, name, category, basis, scope; appended like the line dictionary) and a `FeePartial`: counts per fee status, the processing totals, per-rule figures (including how many orders a rule could not be computed on, by reason), per-month buckets and assumption counts. `foldBatch` takes whole orders (`FoldOrder`: its shipments and its `FoldOrderFees`) and never splits one. An order's fees are folded only when it is shipping-modeled and its fee status is `ok` or `partial` (a *processing order*); every shipping-modeled order's status is still counted, so the summary can say how many orders have no fees and why. The fold refuses inconsistent input loudly (fee lines that do not add up to the order's totals, a negative or fractional amount, a status that carries lines) rather than reporting a wrong number, and it keeps at most 50 named `packaging:<type>` rows of unmatched packaging, folding the rest into one "other types" row. `finalizeSummary` turns the partial into the `BulkSummary` (version 2): fee sections and per-category completeness, the monthly charges, the minimums and their folded status, the allocation, the period and the fee schedule provenance. A version 1 partial is refused (`PC002`).

### The run loop with fee contexts (`src/lib/modeling/run.ts`)

The batch core is the same time-boxed, cursor-driven loop as Milestone 3 with a fee step per window:

1. `simulation_batch_input` returns whole orders with their content (units, lines, SKUs, ordinal, packaging types) and the partial that belongs to the cursor.
2. Each shipment is priced by the shipping engine exactly as before.
3. For each order of the window the fee date is the as-of date (fixed-date basis) or the order's date, else its first ship date. `brand_fee_schedule_on` resolves the version in effect on that date, once per date, and the snapshot is cached per version id. If the schedule the database returns is not the one the run pinned, the run fails (the assignment changed while it ran). An order with no fee date, no schedule or no version in effect is recorded with a status (`date_missing`, `no_schedule`, `not_effective`), never as a zero; a run that skipped fulfillment costs records `skipped`.
4. `buildOrderFeeInput` takes quantities from the file when it has them; otherwise from the typical order the customer described (rows of units, lines and a share of orders), assigned to each order by a deterministic apportionment of its ordinal (so splitting a run into batches never changes which row an order gets) and flagged *assumed*; otherwise they stay unknown. `buildOrderShippingInput` gives percent-of-shipping rules the order's shipping, which is unknown unless every shipment priced.
5. `calculateOrderFees` runs with the customer's order-share answers, the monthly-volume rates pinned at run start (`fee_rates[versionId]`) and the packaging default; `encodeOrderFees` compacts the result into the fee dictionary.
6. `foldBatch`, then `advance_simulation_run` commits the shipment results, the partial, the order results and the fee contexts in one call; a window another caller committed first is acknowledged and this call stops.
7. After the last window, `finalizeSummary` computes the monthly charges, minimums and allocation from the customer's answers, the pinned monthly version and the period stored on the run row (`start_simulation_run` computed it in SQL; TypeScript never recomputes it), and `finish_simulation_run` recomputes the processing totals, every monthly line, every minimum and the projected monthly total before it trusts the summary.

Errors keep the Milestone 3 split: a load that failed is retried (`BatchRetryError`); an `RpcError` carries the SQLSTATE and any code starting with `PC` is permanent and fails the run honestly, as does an inconsistency the fold or the batch core detects (`RangeError`).

### Forecast evaluation (`src/engine/forecast`, `src/app/actions/forecast.ts`)

A forecast prices a weighted grid, not synthetic orders. `evaluateForecast` validates the assumptions, builds one cell per parcel x zone x service x residential split x package class with an exact decimal weight (monthly orders x the product of the shares), prices each cell once with the shipping engine and, per order-content row, with the fee engine, and sums weight x amount into expected values rounded once per reported figure. PRICING_ENGINE.md lists its carve-outs. The server action never trusts the browser: it validates again, takes service names and codes from the customer's rate card, loads the pricing context and the fee schedule version in effect on the as-of date under the caller's RLS, refuses answers for fees that schedule does not have, canonicalises the assumptions, resolves the monthly-volume rates (`forecastPinnedRates`) and evaluates on the server. `previewForecast` stores nothing; `saveForecast` evaluates again and stores through `save_forecast_run`. The headline, the not-included list and the volume sensitivity are computed from the unscrubbed summary and then the summary is scrubbed for the viewer (cells dropped, keys, service ids, hashes, engine versions and engine messages blanked for a brand viewer).

`headlineFigures(summary, view, provenance)` in `src/lib/modeling/headline.ts` decides what the run page, the model hub, the overview, the scenario list, comparisons and the CSV header say about a file run or a forecast: which figure, which label, "At least", and what is left out. The forecast's own result page and preview use a sibling, `forecastHeadline` in `src/components/forecast/result-model.ts`, that applies the same completeness rule (plus a "partial" kind for a forecast that priced only part of the volume). They are separate code, so a change to the rule has to be made in both; `tests/unit/forecast-headline-parity.test.ts` compares them (the kind, label, figure and "At least" agree) across every kind of forecast, so a change to one that the other does not follow fails there.

The lists, tiles and overview do not read whole summaries. `loadModelingLists` (`src/lib/modeling/queries.ts`) selects, for each run of up to 50 projects, the run's own columns plus the headline inputs of its summary as JSON paths (`alias:summary->path`, the `SUMMARY_PARTS` table) and the one assumption the lists read (`assumptions->overrideAllServices`); `summaryFromColumns` rebuilds a `HeadlineBulkInput` or `HeadlineForecastInput` (the `Pick`s of `BulkSummary` and `ForecastSummary` that `headlineFigures`, `defaultView`, `monthlyCharges` and the other list-level functions read; a whole summary satisfies them, so the run page passes its own). A comparison reads its two runs whole (`loadRunsForCompare`), as the run page and the saved-forecast page read their one. A forecast saved with "price only what the rate card covers" carries its priced share into every list line, tile and comparison row (`pricedVolumeNote`).

Run setup's step 2 asks the questions of the fee schedule version in effect on the day the run takes its monthly charges from (`monthlyFeeDate`: the as-of date, or the end of the file's period when each order is priced on its own date; the database picks the same day in `start_simulation_run`). The page loads today's questions; a run's own page loads those of the date that run was priced for; and when step 1 chooses another date the form calls the `loadFulfillmentSetup` server action (authorised like every modeling action, rate limited, the file must be the caller's brand's), swaps in that date's questions and keeps the answers to questions both versions ask (`reconcileFulfillmentState`).

### Where authorization happens (fees, runs, forecasts)

| Layer | What it checks |
|---|---|
| Pages | The 3PL's fee-schedule pages call `requireTenantContext("ratecard.view")`; brand pages use `brandModelingView()` (`requireBrandContext("simulation.run")`); staff modeling pages use `staffModelingView(brandId)` (`requireTenantContext("simulation.run")` and the brand must belong to the active tenant) |
| Server actions | Fee-schedule writes call `requireTenantContext("ratecard.manage")` (the "try an order" panel needs `ratecard.view` and a version of the active workspace); modeling and forecast actions resolve a context with `simulation.run` in which a brand member is bound to its own brand and staff must name a brand of their tenant; Zod validates every input again; per-user rate limits apply (`feeschedule.create`, `forecast.preview` 240/h, `forecast.save` 120/h, `forecast.context` 600/h, `calc.box` 1,200/h, `modeling.setup` 600/h, plus the Milestone 3 limits) |
| Routes | The CSV exports check sign-in, `simulation.run`, that the run is a completed bulk run of the active tenant (and, for a brand, its own brand), write an audit event first (refusing the export if that fails) and then read under RLS |
| Database | RLS on every table, and an authorisation check inside every `SECURITY DEFINER` function on the row it touches (`app.can_manage_fees`, `app.can_view_fee_version`, `app.can_model_brand`, `app.project_visible`); the run functions accept only the run's own rows and reconcile what they are given |

The batch core never authorises anything by itself: every RPC it calls authorises on the run row, so a future worker can call it with any client that may act for the brand. The application still holds no credential a signed-in user lacks.

## Decisions and trade-offs

| Decision | Reason | Cost |
|---|---|---|
| RLS + SECURITY DEFINER helpers in a private `app` schema | Single, testable enforcement point; helpers avoid recursive policies | Policy logic lives in SQL; needs DB tests (we have them) |
| Permissions mirrored in TS and SQL, parity test | Server-side checks and RLS cannot silently diverge | Two places to edit; test fails if they differ |
| No service-role key in app code | Least privilege; a bug cannot bypass RLS | Some admin operations are SQL functions rather than app code |
| Invitations via our own hashed token, not Supabase invite emails | Roles/brand scope must bind to the invitation; works for existing users | We own email sending (Resend or manual link) |
| DB-backed rate limiting | Works across serverless instances without extra infrastructure | Extra writes; only for authenticated actions |
| Docker-free local stack for tests | Runs anywhere; real Auth + Postgres + PostgREST | Not identical to Supabase's hosted gateway |
| Client-driven batch runs with a database cursor (Milestone 3) | Durable progress and retries with nothing to deploy; works on serverless | The page must stay open; a worker is a later addition |
| Results dictionary-encoded, summaries folded incrementally | A 20,000-shipment run never reads every result back; ~300 bytes per shipment | Line explanations are re-derived on demand rather than stored |
| Staff-prepared models private until shared | A sales what-if never appears as the customer's headline number | One more state to explain in the UI |
| Fee amounts in E4, aggregates rounded once (Milestone 4) | A four-decimal rate times a quantity is exact; a rounded average is never multiplied again | Two precisions to keep apart (E4 in storage and the engine, cents on screen) |
| Monthly charges are allocated over the customer's volume, never shown per order | Storage, receiving and minimums are not order fees; the per-order figure is labelled an allocation with its period and volume | The all-in per order depends on a volume the customer states or the file implies |
| Period and volume computed in SQL when a run starts | One definition for the run, the minimums and the allocation; TypeScript cannot drift from it | Date logic lives in SQL (percentile span, calendar-month fractions) |
| The fee engine and the shipping engine stay separate; the batch core joins them | Each is testable alone; fees can use the shipping result without the shipping engine knowing about fees | The join (shipping figures into percent-of-shipping rules) lives in the batch core |
| Order-fee amounts are application-computed, reconciled in SQL by totals, monthly lines and minimums | The database re-derives what it can derive from stored rows (monthly lines, minimums, totals) and refuses a summary that disagrees | A user with API access could post invented fee amounts into their own run; documented in SECURITY.md |
| Forecasts price a weighted grid of expected values | No invented orders, exact weights, reproducible by hash | Figures are expectations over an independent mix, not a month's bill; the assumptions card says so |
