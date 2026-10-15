"use client";

import { uploadOrderFile, uploadSkuProfiles } from "@/app/actions/modeling";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { FileField } from "@/components/pricing/file-field";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";

/** Upload an orders file (CSV/XLSX). Staff pass the customer they are modeling for. */
export function OrderUploadForm({ brandId, tenantName }: { brandId?: string; tenantName: string }) {
  return (
    <Card>
      <CardTitle>Upload your orders</CardTitle>
      <CardDescription>A CSV or XLSX of past or projected orders. Shopify and ShipHero exports can be uploaded as they are; otherwise use the orders template. Nothing is priced until you have reviewed how the file was read.</CardDescription>
      <a href="/api/templates/orders.csv" download className="mt-1 inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
        Download the orders template (CSV)
      </a>
      <ActionForm action={uploadOrderFile} className="mt-4 space-y-4">
        {brandId ? <input type="hidden" name="brandId" value={brandId} /> : null}
        <FileField name="file" label="Orders file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hint={`Up to 15 MB. Prices come only from the rate card ${tenantName} assigned to you.`} />
        <SubmitButton pendingLabel="Reading the file…">Upload and review</SubmitButton>
      </ActionForm>
    </Card>
  );
}

/** Upload product weights (sku, weight, unit, dimensions) used to price files that carry no package weight. */
export function SkuProfilesForm({ brandId, count }: { brandId?: string; count: number }) {
  return (
    <Card>
      <CardTitle>Product weights</CardTitle>
      <CardDescription>
        {count ? `${count.toLocaleString("en-US")} products on file. ` : "No products on file yet. "}
        Columns: sku, weight, unit (lb, oz, g or kg), and optionally length, width, height in inches. Orders files without package weights (Shopify exports) are priced from these; such prices are marked as estimates.
      </CardDescription>
      <ActionForm action={uploadSkuProfiles} className="mt-4 space-y-4">
        {brandId ? <input type="hidden" name="brandId" value={brandId} /> : null}
        <FileField name="file" label="Product weights file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hint="Existing SKUs are updated; others are added." />
        <SubmitButton pendingLabel="Saving…">Save product weights</SubmitButton>
      </ActionForm>
    </Card>
  );
}
