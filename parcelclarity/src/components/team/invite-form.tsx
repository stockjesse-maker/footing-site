import { inviteMember } from "@/app/actions/team";
import { ActionForm, SelectField, SubmitButton, TextField } from "@/components/forms/action-form";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { ROLE_LABELS, type Role } from "@/lib/auth/permissions";

export function InviteForm({ roles, brandId, title = "Invite someone", description }: { roles: Role[]; brandId?: string; title?: string; description?: string }) {
  if (!roles.length) return null;
  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      {description ? <CardDescription>{description}</CardDescription> : null}
      <ActionForm action={inviteMember} className="mt-5 grid gap-4 sm:grid-cols-[1fr_14rem_auto] sm:items-end">
        {brandId ? <input type="hidden" name="brandId" value={brandId} /> : null}
        <TextField name="email" label="Email address" type="email" autoComplete="off" required />
        <SelectField name="role" label="Role" options={roles.map((r) => ({ value: r, label: ROLE_LABELS[r] }))} />
        <SubmitButton pendingLabel="Sending…">Send invitation</SubmitButton>
      </ActionForm>
    </Card>
  );
}
