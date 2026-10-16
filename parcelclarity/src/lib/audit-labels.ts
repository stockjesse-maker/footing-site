const LABELS: Record<string, string> = {
  "tenant.created": "Workspace created",
  "tenant.updated": "Workspace renamed",
  "tenant.status_changed": "Workspace status changed",
  "brand.created": "Customer added",
  "brand.updated": "Customer renamed",
  "brand.status_changed": "Customer status changed",
  "membership.created": "Member joined",
  "membership.updated": "Member role or status changed",
  "invitation.created": "Invitation sent",
  "invitation.accepted": "Invitation accepted",
  "invitation.revoked": "Invitation revoked",
  // Milestone 5 (adjustment risk). Written by database triggers only; metadata holds ids, names and counts, never figures.
  "adjustment.policy_set": "Adjustment decision set (who pays)",
  "adjustment.policy_ended": "Adjustment decision ended",
  "adjustment.import_committed": "Adjustment history imported",
  "adjustment.import_discarded": "Adjustment history import discarded",
  "adjustment.import_withdrawn": "Adjustment history import withdrawn",
  "adjustment.baseline_saved": "Packages-shipped baseline saved",
  "adjustment.baseline_deleted": "Packages-shipped baseline deleted",
  "adjustment.scenario_saved": "Adjustment example saved",
  "adjustment.estimate_saved": "Adjustment risk estimate saved",
  "adjustment.scenario_published": "Adjustment example shared with a customer",
  "adjustment.scenario_retired": "Adjustment example stopped",
  "adjustment.data_purged": "Adjustment data purged",
};

export const auditActionLabel = (action: string) => LABELS[action] ?? action;
