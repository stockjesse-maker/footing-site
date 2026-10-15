import { setMembershipStatus, revokeInvitation } from "@/app/actions/team";
import { ConfirmAction } from "@/components/forms/confirm-action";
import { Badge, statusTone } from "@/components/ui/badge";
import { DataList, DataRow } from "@/components/ui/data-list";
import { EmptyState } from "@/components/ui/empty-state";
import { ROLE_LABELS, isRole } from "@/lib/auth/permissions";
import { formatDate } from "@/lib/format/date";

export interface MemberRow {
  id: string;
  user_id: string;
  role_key: string;
  status: string;
  profiles: { full_name: string | null; email: string } | null;
}

export interface InvitationRow {
  id: string;
  email: string;
  role_key: string;
  expires_at: string;
  brand_id: string | null;
}

const roleLabel = (key: string) => (isRole(key) ? ROLE_LABELS[key] : key);

export function MembersList({ members, currentUserId, canManage }: { members: MemberRow[]; currentUserId: string; canManage: boolean }) {
  const visible = members.filter((m) => m.status !== "revoked");
  if (!visible.length) return <EmptyState title="No members yet">Invite someone to get started.</EmptyState>;
  return (
    <DataList>
      {visible.map((m) => {
        const isSelf = m.user_id === currentUserId;
        return (
          <DataRow key={m.id}>
            <div className="min-w-0">
              <p className="truncate font-medium">
                {m.profiles?.full_name || m.profiles?.email || "Unknown user"}
                {isSelf ? <span className="ml-2 text-sm font-normal text-muted">(you)</span> : null}
              </p>
              {m.profiles?.full_name ? <p className="truncate text-sm text-muted">{m.profiles.email}</p> : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="accent">{roleLabel(m.role_key)}</Badge>
              {m.status !== "active" ? <Badge tone={statusTone(m.status)}>{m.status}</Badge> : null}
              {canManage && !isSelf ? (
                <>
                  {m.status === "active" ? (
                    <ConfirmAction action={setMembershipStatus.bind(null, m.id, "suspended")} label="Suspend" confirmLabel="Suspend access" />
                  ) : (
                    <ConfirmAction action={setMembershipStatus.bind(null, m.id, "active")} label="Reinstate" confirmLabel="Reinstate" variant="ghost" />
                  )}
                  <ConfirmAction action={setMembershipStatus.bind(null, m.id, "revoked")} label="Remove" confirmLabel="Remove access" variant="danger" />
                </>
              ) : null}
            </div>
          </DataRow>
        );
      })}
    </DataList>
  );
}

export function PendingInvitations({ invitations, canManage }: { invitations: InvitationRow[]; canManage: boolean }) {
  if (!invitations.length) return null;
  return (
    <section aria-labelledby="pending-heading" className="space-y-3">
      <h3 id="pending-heading" className="text-sm font-semibold text-muted">Pending invitations</h3>
      <DataList>
        {invitations.map((inv) => (
          <DataRow key={inv.id}>
            <div className="min-w-0">
              <p className="truncate font-medium">{inv.email}</p>
              <p className="text-sm text-muted">Expires {formatDate(inv.expires_at)}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge>{roleLabel(inv.role_key)}</Badge>
              {canManage ? <ConfirmAction action={revokeInvitation.bind(null, inv.id)} label="Revoke" confirmLabel="Revoke invitation" variant="danger" /> : null}
            </div>
          </DataRow>
        ))}
      </DataList>
    </section>
  );
}
