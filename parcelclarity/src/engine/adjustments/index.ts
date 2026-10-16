/**
 * Adjustment-risk engine (Milestone 5). Pure: no I/O, no clock, no random numbers.
 * Every amount is customer-facing; there is no carrier cost anywhere in these types.
 */
export * from "./types";
export { evaluateAdjustmentScenario, correctedPackages, countPercentOfShippingFees } from "./scenario";
export { scenarioStorageInput, scenarioStorageResult, riskStorageResult, storableWeight, storableDimension, STORED_DECIMALS } from "./storage";
export type { StorageOutcome, StoredScenarioInput, StoredScenarioResult, StoredRiskResult, StoredComponent, StoredPackage } from "./storage";
export { summariseHistory, affectedKey } from "./history";
export { forecastAdjustmentRisk, MAX_MONTHLY_VOLUME } from "./risk";
export { resolveHandling, policyFnFor, isValidPolicyPair } from "./policy";
export { wilsonFraction, wilsonBounds, incidenceConfidence, incidencePct, pctString, WILSON_Z } from "./wilson";
export { e4Cents, wholeE4, AdjustmentOverflowError } from "./num";
