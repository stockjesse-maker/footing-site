import type { Metadata } from "next";
import Link from "next/link";
import { createBrand } from "@/app/actions/team";
import { ActionForm, SubmitButton, TextField } from "@/components/forms/action-form";
import { Badge, statusTone } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { DataList, DataRow } from "@/components/ui/data-list";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/auth/permissions";
import { requireTenantContext } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Customers" };
const PAGE_SIZE = 25;

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const ctx = await requireTenantContext("brand.view");
  const page = Math.max(1, Number.parseInt((await searchParams).page ?? "1", 10) || 1);
  const from = (page - 1) * PAGE_SIZE;
  const supabase = await createClient();
  const { data: brands, count } = await supabase
    .from("brands")
    .select("id, name, status", { count: "exact" })
    .eq("tenant_id", ctx.active.tenantId)
    .order("name", { ascending: true })
    .range(from, from + PAGE_SIZE - 1);

  const total = count ?? 0;
  const canCreate = can(ctx.active.role, "brand.create");

  return (
    <>
      <PageHeader title="Customers" description="Brand accounts that can sign in to see the pricing and results you assign to them." />
      {canCreate ? (
        <Card className="mb-8">
          <CardTitle>Add a customer</CardTitle>
          <CardDescription>You can invite their team on the next screen.</CardDescription>
          <ActionForm action={createBrand} className="mt-5 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
            <TextField name="name" label="Brand name" autoComplete="off" required />
            <SubmitButton pendingLabel="Adding…">Add customer</SubmitButton>
          </ActionForm>
        </Card>
      ) : null}

      {brands && brands.length > 0 ? (
        <>
          <DataList>
            {brands.map((b) => (
              <DataRow key={b.id} className="p-0 sm:p-0">
                <Link href={`/app/customers/${b.id}`} className="flex w-full flex-col gap-2 px-4 py-4 hover:bg-surface sm:flex-row sm:items-center sm:justify-between sm:px-6">
                  <span className="font-medium">{b.name}</span>
                  <Badge tone={statusTone(b.status)}>{b.status}</Badge>
                </Link>
              </DataRow>
            ))}
          </DataList>
          {total > PAGE_SIZE ? (
            <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pagination">
              {page > 1 ? <ButtonLink href={`/app/customers?page=${page - 1}`} variant="secondary" size="sm">Previous</ButtonLink> : <span />}
              <span className="text-muted">Page {page} of {Math.ceil(total / PAGE_SIZE)}</span>
              {from + PAGE_SIZE < total ? <ButtonLink href={`/app/customers?page=${page + 1}`} variant="secondary" size="sm">Next</ButtonLink> : <span />}
            </nav>
          ) : null}
        </>
      ) : (
        <EmptyState title="No customers yet">{canCreate ? "Add your first brand customer above." : "Ask a 3PL administrator to add customers."}</EmptyState>
      )}
    </>
  );
}
