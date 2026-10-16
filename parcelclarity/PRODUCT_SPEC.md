# Product specification

ParcelClarity is a two-sided SaaS for third-party logistics providers (3PLs) and their ecommerce brand customers.

**Value proposition:** "Know what fulfillment and shipping will cost before you ship."

## Non-negotiable rules

1. **Customer-facing rates only.** ParcelClarity must never require, import, store, display, or calculate with a 3PL's negotiated carrier buy rates. The only shipping base-rate source is the customer-facing rate card the 3PL provides. Carrier account-specific rate API responses are never customer pricing.
2. **No invented data.** No fabricated carrier surcharge amounts, customer rates, or "sample" figures presented as real. Missing rates are shown as unavailable, never extrapolated (unless an explicit, approved rule allows it).
3. **Confidentiality.** Brands never see buy rates, 3PL margins, internal losses, other customers' pricing, unassigned rate cards or carrier contracts. Platform administrators do not automatically see tenant data.
4. **Server-side enforcement.** Hidden UI is never a security mechanism. Tenant/brand isolation is enforced by PostgreSQL Row Level Security and server-side checks.
5. **Estimates are labeled.** Definite charges, assumption-based estimates and conditional post-shipment adjustments are always distinguished; estimates are never presented as invoices.
6. **Honest status.** Nothing is claimed to work unless tested (see IMPLEMENTATION_STATUS.md).

## Actors and roles

| Role | Scope | Summary |
|---|---|---|
| Platform administrator | Platform | Operates the service; can list/suspend tenants. Cannot read tenant data. |
| 3PL administrator | Tenant | Manages brands, staff, pricing (rate cards, surcharge rules, fee schedules), billing, audit log |
| 3PL employee | Tenant | Works with brands and quotes; can read rate cards and fee schedules but not change them; cannot change account structure |
| Brand administrator | Brand | Manages brand team; runs models and reports |
| Brand employee | Brand | Runs models; views reports |

A 3PL is a tenant; a tenant has many brands; a brand has many users. A user may hold several memberships.

## Functional requirements and status

| Area | Requirement | Milestone | Status |
|---|---|---|---|
| Accounts | Email/password auth, confirmation, reset, sessions | 1 | Done |
| Accounts | Roles, invitations, suspension, revocation, audit log | 1 | Done |
| Accounts | Tenant/brand isolation by RLS with tests | 1 | Done |
| Portal | 3PL portal shell + overview; brand portal shell (Overview, Model Costs, Reports, Account) | 1 | Done (Reports holds the run comparison; PDF reports are Milestone 6) |
| Rate cards | CSV/XLSX import, validation preview, admin approval, versioning, overrides | 2 | **Done** (3PL side; fictional data only) |
| Engine | Deterministic shipping charge engine: DIM, billable weight, zones, brackets, minimums, surcharges with precedence and effective dates | 2 | **Done** (validated on fictional fixtures; not on real cards) |
| Modeling | Single shipment calculator; bulk order modeling (avg cost per order); manual forecasting; scenarios | 3, 4 | **Done**: calculator, bulk modeling and scenarios in Milestone 3; forecasting from assumptions in Milestone 4. Fictional data only |
| Processing | Pick/pack, packaging, receiving, storage, returns, minimums; all-in cost per order | 4 | **Done** (fee schedules, fees in the calculator and in bulk runs, monthly charges and minimums, all-in per order, forecasts; fictional data only; some charges cannot be modeled, see the deferred list below) |
| Risk | Reweight/WMS adjustment-risk module with confidentiality controls | 5 | Not started |
| Reports | Branded PDF reports; white-label branding; exports | 6 | Not started |
| Billing | Stripe subscriptions for 3PL (quote-project plans) and brands (premium), entitlements, sponsorship | 7 | Not started |
| Carrier rules | Versioned rule administration, change detection, review/approval workflow | 8 | Not started |
| Production | E2E, security review, accessibility audit, performance, deployment, monitoring, backups | 9 | Not started |

## Key definitions

* **Quote project**: a customer proposal that may include multiple service comparisons, revisions and exports. A revision does not consume another quote credit. (Billing, Milestone 7.)
* **Average shipping cost per order** = total modeled shipping charges ÷ number of modeled orders. Never the price of an "average-weight" package. Imported vs. modeled orders are reported separately with coverage percentages.
* **Order vs shipment vs package**: distinct counts; an order may have many packages.
* **Definite / estimated / conditional charges**: upfront certain charges / charges depending on assumptions / possible post-shipment adjustments.
* **Allocated fixed costs** (storage, receiving, monthly minimums) are labeled as allocations over a stated period and order volume, never as variable per-order fees.
* **Fee schedule**: a 3PL's own customer-facing list of fulfillment charges (pick and pack, packaging, kitting, labeling, receiving, storage, returns, account fees), versioned with effective dates and assigned to a customer. Every amount is one the 3PL typed.
* **Order fees**: the charges that depend on each order (a pick fee per item, a packaging fee per package, a percentage of the order's shipping). They are computed per order from what the order holds.
* **Monthly charges**: charges that depend on stated quantities, not on any one order (pallets stored, pallets received, a flat account fee, returns). They are shown as monthly dollars first; spread over the customer's orders they are an allocation, never an order fee.
* **Account minimum**: if the fees counted toward it in a month add up to less than the minimum, the difference is added to that month. It is worked out month by month and is shown as "up to" (and left out of the all-in figure) when it cannot be worked out exactly.
* **All-in cost per order** = (shipping + order fees + monthly charges) over a stated monthly order volume, divided by that volume. It is called "All-in" only when everything the fee schedule prices is included; otherwise it says what is left out and reads "At least".
* **Not computed**: an input is unknown and nothing was assumed. The fee is listed as not included, with its rate, and is never counted as $0. "We don't use this" is a different answer: it is a stated zero.

## What the customer sees: fees, all-in cost and forecasts (Milestone 4)

Everything below is what the code does today; none of it has been validated against a real fee schedule or invoice.

### The 3PL sets fees up

Fee schedules (**Fee schedules** in the 3PL portal) are built rule by rule from presets (first pick included, additional units, per line, additional packages, percent of shipping, monthly storage per pallet, long-term storage, receiving per pallet, returns, account minimum, flat monthly fee) or from scratch. Each rule is shown back in the customer's words as the 3PL types it, and a "try an order" panel prices one typed order on any version, a draft included. A version is a draft until it is activated with an effective date; activation checks the version as a whole and freezes it. A 3PL can add private notes and a source reference to a version and a rule; customers never see them. The editor says up front what a schedule cannot model (the deferred list below). A schedule is assigned to a customer on the customer's page; a customer has one at a time and sees it under **Your fee schedule**.

### The headline and the completeness label

One function decides what the run page, the model hub, the overview, the scenario list, comparisons and the CSV header say about a model, so a figure carries the same label on each; the forecast result page applies the same rule through a sibling function.

* The label **"All-in cost per order"** is used only when every category the pinned fee schedule prices is included in the figure and the account minimum is worked out exactly (or there is none). Otherwise the label names what is left out ("All-in cost per order, without storage and receiving"), the figure reads **"At least $X"**, and the charges left out are listed inside the headline card with their rates and an **Add** link that opens the run setup again.
* A minimum that is only an upper bound (not every order had a date, or not every order could be priced) leaves every category priced, so the label stays and a separate sentence says "The account minimum could add up to $X a month (about $Y per order) on top of this", with the reason. It is never added to the figure.
* When fees could not be computed for any order, or fulfillment costs were skipped, or no fee schedule was in effect, the figure is "Not computed" with the reason, never $0.
* Three views, chosen with `?view=` links: **Shipping** ("Estimated shipping cost per order"), **Order fees** (only the charges that depend on each order, "Order fees per order") and **All-in**. The sentence under the control says what each contains. All-in is the default when its figure is complete; otherwise Shipping.
* Every figure that rests on an input the customer did not give says so: the file had no item counts and a typical order was used; no packaging type and a default was used; a percentage of shipping was based on shipping without the charges that may be added after shipping; some orders could not be priced for fees and why.

### Order fees, monthly charges and the account minimum

* **Order fees** lists every order charge of the schedule in effect, whether or not it was charged, with its rate, its definite and estimated totals, how many orders it applied to and, per charge, the orders on which it could not be computed and why.
* **Monthly charges** leads with monthly dollars ("$1,150 a month, whatever you ship", plus "$X a month in charges that grow with your orders"), then "Spread over your orders, that is about $0.92 per order at 1,250 orders a month. This is monthly charges shared across orders, not a per-order fee", with the period and volume it is spread over printed ("N orders a month over Jan 3 – Mar 28 (2.84 months)"). Each charge echoes its inputs ("12 pallets × $18.00 = $216.00 a month") and is marked "From your fee schedule" or "Based on assumptions". A table shows the all-in per order and a month at 0.5×, 1×, 2× and 4× the volume.
* **Account minimum** shows what counts toward it with each charge marked (priced or not modeled), and either "Fees counted: $380.00 · Minimum: $500.00 · Added: $120.00" month by month or the "up to" sentence with its reasons. A charge whose rule has since left the schedule is listed as "A charge that is no longer on the fee schedule". When the file covers fewer than 28 days and the customer stated a monthly volume, the minimum can only be worked out over the days in the file (prorated), and the card says so ("This was worked out from the 4 days in your file, not from the 20 orders a month you stated, so at that volume the amount could be different").
* The orders table and `orders.csv` carry, per order, units, lines, packages, shipments, shipping, order fees and "shipping + order fees". There is **no** per-order monthly or all-in column anywhere; monthly charges are in `monthly.csv`, with the period and volume in its header. Blank means not computed, never zero.

### Not included: three groups

1. **Left out because no numbers were given** (or because fulfillment costs were skipped): each charge with its rate and an Add link.
2. **Not on your fee schedule**: categories the schedule has no charge in, and charges the schedule does not cover (for example a packaging type no rule prices).
3. **Never included**: special projects and anything else outside the fee schedule (quoted separately); carrier adjustments billed after shipping, such as address corrections and reweighs; taxes; return shipping.

### Setting up a run, and where the numbers come from

Run setup is two steps. Step 2, **Fulfillment costs**, is generated from the customer's fee schedule: the monthly volume (derived from the file as an editable sentence: "N orders a month over <from>–<to>"; a file shorter than 28 days needs a stated volume), one question per charge that depends on a quantity (each with its rate, the 3PL's help text and three answers: a number, "Not sure, leave it out", or "We don't use this"), the packaging to assume for orders with none, a description of the typical order when the file has no item counts, and **Skip fulfillment costs (shipping only)**. A blank number with no choice blocks submit. The questions are those of the fee schedule version in effect on the day the run takes its monthly charges from (the date whose rates were chosen, or the end of the file's period when each order is priced on its own date): choosing another date in step 1 reads that date's questions before step 2 opens and keeps the answers to questions both versions ask, and a date with no fee schedule in effect says there are no questions for it. Repeating a run carries every answer and the confirmed volume and shows a one-line diff of what changed.

Every result says where its inputs came from: "{3PL} fee schedule 'Standard', in effect from Jan 1, 2026" (with later change dates when the file spans a price change), "Assumptions entered by {3PL} on Oct 14, 2026" or "by you", the pricing basis (today's rates or each order's date), and "Fees have changed since this model was priced" when a newer version is in effect. Orders dated where no version of the schedule applied are counted and listed, not priced.

### The calculator: "what's in the box"

Under the shipment fields the calculator asks what is in the box: items, different products (and order lines only if the schedule has a per-line charge), packaging from the schedule's own types plus "Not sure", and counts such as inserts or kits only when the schedule has such a charge. The shipping price is always calculated: order fees appear only after the items are entered ("Add what's in the box to see order fees"; items left blank while other fields of the box are filled add only a note under Items), under "Shipping + order fees for this order (monthly charges not included)". With no fee schedule in effect on the ship date the calculator says so ("No fee schedule in effect on this date. Only shipping is priced.") instead of showing $0. Entries are validated inline (more products than items is refused).

### Forecast from your assumptions

A brand (or its 3PL, on its behalf) can model without an orders file: monthly orders, an as-of date, ship-from ZIP, a split of parcels (weight, size, packaging), zones, services, home or business delivery, orders that ship as several packages, what a typical order holds, and the same fulfillment answers as a run. Every split must add up to exactly 100.00% (no silent rescaling; "Spread evenly" is a button). If the rate card does not cover some combination, the save is blocked with a table of the service, the reason and the share of volume, unless the user chooses to price only what the rate card covers, in which case no all-in figure is shown and every place the per-order figures appear (the forecast page, the model hub and overview tiles, the scenario list and comparisons) says how much of the volume was priced ("Only 80.00% of the volume could be priced, so this is an average over that part").

The result opens with "Forecast from your assumptions at N orders a month. Each figure is the expected value over the mix you described; not a prediction for any month and not an invoice." A complete all-in figure is given per order, a month and a year, the year labelled "if every month looked like this". A **What this forecast assumes** card states the independence of the choices, one shipment per order, exact weights, the origin, no signature, Saturday delivery or declared value, that delivery-area surcharges are not included (with the "up to" amount), and the rate card and fee schedule dates. A saved forecast is edited by starting a new forecast prefilled from it; comparisons show an assumptions diff and warn when a forecast is compared with a file model.

### Overview, comparison, 3PL view

The customer's overview shows every headline figure from one run (the latest completed, non-what-if file model) with the same label and reason; forecasts and what-ifs are separate, labelled tiles. Comparing two models puts what each is made of first (source, orders a month, period, fee schedule date, what is left out, minimum status), then "Shipping + order fees (comparable)", and greys the all-in rows when the two leave out different things, with warnings for a volume difference above 5%, a forecast against a file, and differing assumptions. The all-in rows open with a "Spread over" row that names the volume and period each model's monthly charges were shared over. A 3PL modeling on a customer's behalf sees the same wording; the scenario stays private until shared.

### Deferred (not modeled, and stated in the editor)

Fee schedules cannot express, and customers should be quoted outside the tool: seasonal windows inside a version (use a version per season); weight- or value-based handling fees; discounts and credits (amounts are zero or more); fees as a percent of another fee; per-hour special projects; inventory dimensions and per-SKU storage from dimensions; peak-based storage billing (quantities are average occupancy); nested minimums (the sets must be disjoint); per-receipt size lists (receiving fees assume equal receipts); return shipping postage. Forecasts also leave out delivery-area and remote surcharges (they need ZIP codes), dependent mixes (segments) and "what if every order used service S" variants, and cannot be made for a prospect without a brand record. Fee schedules cannot be imported from a spreadsheet; they are typed in.

## Design requirements

Premium, Apple-inspired: white/light-gray surfaces, charcoal text, one restrained blue accent, generous spacing, rounded cards/inputs, large numeric results, no clutter, no popups, minimal onboarding. Light mode now, tokens structured for dark mode later. Must be excellent on iPhone Safari and installable as a PWA; structure must keep native packaging (Capacitor) possible.
