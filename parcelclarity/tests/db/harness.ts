import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";

const url = process.env.PC_TEST_DB_URL;
if (!url) throw new Error("PC_TEST_DB_URL is not set; the db test project must run via vitest globalSetup.");

/** Superuser pool: used ONLY to create fixtures and to assert on state. */
export const superPool = new Pool({ connectionString: url, max: 4 });

export type Rows<T extends QueryResultRow = QueryResultRow> = T[];

/**
 * Runs one statement as a Supabase-style authenticated user (or anon when userId is
 * null) inside its own transaction: `set local role` + JWT claims, exactly how
 * PostgREST evaluates a request. Commits on success, rolls back on error.
 */
export async function asUser<T extends QueryResultRow = QueryResultRow>(
  userId: string | null,
  sql: string,
  params: unknown[] = [],
): Promise<Rows<T>> {
  const client = await superPool.connect();
  try {
    await client.query("begin");
    if (userId) {
      await client.query("set local role authenticated");
      const claims = JSON.stringify({ sub: userId, role: "authenticated" });
      await client.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [claims, userId]);
    } else {
      await client.query("set local role anon");
    }
    const res = await client.query<T>(sql, params);
    await client.query("commit");
    return res.rows;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function sql<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<Rows<T>> {
  return (await superPool.query<T>(text, params)).rows;
}

export interface TestUser {
  id: string;
  email: string;
}

export async function createUser(label: string, opts: { confirmed?: boolean } = {}): Promise<TestUser> {
  const id = randomUUID();
  const email = `${label}-${id.slice(0, 8)}@example.test`;
  await sql(
    "insert into auth.users (id, aud, role, email, email_confirmed_at, raw_user_meta_data) values ($1, 'authenticated', 'authenticated', $2, $3, $4)",
    [id, email, opts.confirmed === false ? null : new Date(), JSON.stringify({ full_name: `User ${label}` })],
  );
  return { id, email };
}

export async function createTenant(owner: TestUser, name: string): Promise<string> {
  const rows = await asUser<{ create_tenant: string }>(owner.id, "select public.create_tenant($1) as create_tenant", [name]);
  return rows[0]!.create_tenant;
}

export async function createBrand(admin: TestUser, tenantId: string, name: string): Promise<string> {
  const rows = await asUser<{ id: string }>(admin.id, "insert into public.brands (tenant_id, name) values ($1, $2) returning id", [tenantId, name]);
  return rows[0]!.id;
}

export function newToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: createHash("sha256").update(token, "utf8").digest() };
}

export interface InviteOpts {
  tenantId: string;
  brandId?: string | null;
  email: string;
  role: "tenant_admin" | "tenant_employee" | "brand_admin" | "brand_employee";
  expiresInHours?: number;
}

export async function invite(inviter: TestUser, o: InviteOpts): Promise<{ id: string; token: string }> {
  const { token, hash } = newToken();
  const rows = await asUser<{ id: string }>(
    inviter.id,
    `insert into public.invitations (tenant_id, brand_id, email, role_key, token_hash, expires_at)
     values ($1, $2, $3, $4, $5, now() + ($6 || ' hours')::interval) returning id`,
    [o.tenantId, o.brandId ?? null, o.email.toLowerCase(), o.role, hash, String(o.expiresInHours ?? 72)],
  );
  return { id: rows[0]!.id, token };
}

export async function join(inviter: TestUser, invitee: TestUser, o: Omit<InviteOpts, "email">): Promise<void> {
  const { token } = await invite(inviter, { ...o, email: invitee.email });
  await asUser(invitee.id, "select public.accept_invitation($1)", [token]);
}

/** Asserts a statement is rejected by Postgres with a message matching `pattern`. */
export async function expectDenied(promise: Promise<unknown>, pattern: RegExp = /./): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!pattern.test(message)) throw new Error(`Rejected, but with an unexpected error: ${message}`);
    return;
  }
  throw new Error("Expected the statement to be rejected, but it succeeded.");
}
