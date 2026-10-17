/**
 * The customer side of the adjustments module, and the one view the 3PL's preview shares with it.
 *
 * This barrel is safe to import from a Server or a Client Component: nothing it exports reads the database or imports "server-only".
 *
 * - `ExampleView` (props: `ExampleViewProps`, example: `ExampleViewExample`): one example as a customer reads it. Used by the customer
 *   page and by the 3PL's "preview as the customer sees it", with `mode="staffPreview"` (the same markup, headings one level down; the
 *   caller adds its own frame and passes `publishedAt` as the date the example would be shared). No hooks, no browser APIs.
 * - `exampleHeading`: the generated sentence an example is headed by, to suggest as the title in the share form.
 * - `PossibleAdjustmentsView`: the customer page body.
 *
 * Server-side helpers that read the customer projection live in their own files, so a Client Component never pulls them in:
 * - `@/components/adjustments/customer/from-preview`: `exampleFromPreview` (the preview function's result, through the customer projection).
 * - `@/components/adjustments/customer/hub-card`: `hasCurrentAdjustmentExample` and `PossibleAdjustmentsHubCard`.
 */
export { ExampleView } from "./example-view";
export type { ExampleViewExample, ExampleViewMode, ExampleViewProps } from "./example-view";
export { buildExampleModel, exampleHeading } from "./example-model";
export type { ComponentLineModel, ExampleModel, GroupModel } from "./example-model";
export { PossibleAdjustmentsView, orderExamples } from "./possible-adjustments-view";
