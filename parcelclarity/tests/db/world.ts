import { createBrand, createTenant, createUser, join, sql, type TestUser } from "./harness";

/** Two 3PL tenants, three brands, and a user for every role, built through the real flows. */
export interface World {
  platformAdmin: TestUser;
  outsider: TestUser;
  t1: { id: string; admin: TestUser; admin2: TestUser; employee: TestUser };
  t2: { id: string; admin: TestUser };
  brandA: { id: string; admin: TestUser; employee: TestUser }; // tenant 1
  brandB: { id: string; admin: TestUser }; // tenant 1
  brandC: { id: string; admin: TestUser }; // tenant 2
}

export async function buildWorld(): Promise<World> {
  const [platformAdmin, outsider, t1a, t1a2, t1e, t2a, ba, be, bb, bc] = await Promise.all([
    createUser("platform"), createUser("outsider"), createUser("t1admin"), createUser("t1admin2"), createUser("t1emp"),
    createUser("t2admin"), createUser("brandA-admin"), createUser("brandA-emp"), createUser("brandB-admin"), createUser("brandC-admin"),
  ]);
  await sql("insert into public.platform_admins (user_id) values ($1)", [platformAdmin.id]);

  const t1 = await createTenant(t1a, "Northwind Logistics");
  const t2 = await createTenant(t2a, "Southpoint Fulfillment");
  await join(t1a, t1a2, { tenantId: t1, role: "tenant_admin" });
  await join(t1a, t1e, { tenantId: t1, role: "tenant_employee" });

  const brandA = await createBrand(t1a, t1, "Alpha Apparel");
  const brandB = await createBrand(t1a, t1, "Beta Beverages");
  const brandC = await createBrand(t2a, t2, "Gamma Goods");
  await join(t1a, ba, { tenantId: t1, brandId: brandA, role: "brand_admin" });
  await join(ba, be, { tenantId: t1, brandId: brandA, role: "brand_employee" });
  await join(t1a, bb, { tenantId: t1, brandId: brandB, role: "brand_admin" });
  await join(t2a, bc, { tenantId: t2, brandId: brandC, role: "brand_admin" });

  return {
    platformAdmin, outsider,
    t1: { id: t1, admin: t1a, admin2: t1a2, employee: t1e },
    t2: { id: t2, admin: t2a },
    brandA: { id: brandA, admin: ba, employee: be },
    brandB: { id: brandB, admin: bb },
    brandC: { id: brandC, admin: bc },
  };
}
