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
};

export const auditActionLabel = (action: string) => LABELS[action] ?? action;
