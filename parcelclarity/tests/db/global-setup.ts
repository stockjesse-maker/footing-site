import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

// Creates a throwaway database on the local stack's PostgreSQL cluster, installs the
// Supabase Auth schema (by running the real GoTrue migrations), then applies every
// file in supabase/migrations in order. Starting from an empty database on every run
// also proves the migrations work from scratch.

const root = path.resolve(__dirname, "../..");
const host = process.env.PC_PG_HOST ?? "127.0.0.1";
const port = process.env.PC_PG_PORT ?? "54322";
const gotrueBin = process.env.PC_GOTRUE_BIN ?? "/opt/pc-stack/bin/gotrue";
const dbName = `pc_test_${process.pid}_${Date.now()}`;
const superUrl = (db: string) => `postgres://postgres@${host}:${port}/${db}`;

export async function setup() {
  if (!fs.existsSync(gotrueBin)) {
    throw new Error(`GoTrue binary not found at ${gotrueBin}. Run scripts/local-stack/install.sh (see TESTING.md).`);
  }
  const admin = new Client({ connectionString: superUrl("postgres") });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(`Cannot reach PostgreSQL at ${host}:${port}. Start it with 'npm run stack:up'. (${String(err)})`);
  }
  await admin.query(`create database ${dbName}`);
  await admin.end();

  const bootstrap = fs.readFileSync(path.join(root, "scripts/local-stack/bootstrap.sql"), "utf8");
  const db = new Client({ connectionString: superUrl(dbName) });
  await db.connect();
  await db.query(bootstrap);

  const authUrl = `postgres://supabase_auth_admin:postgres@${host}:${port}/${dbName}`;
  execFileSync(gotrueBin, ["migrate"], {
    env: {
      ...process.env,
      DATABASE_URL: authUrl,
      GOTRUE_DB_DRIVER: "postgres",
      GOTRUE_DB_DATABASE_URL: authUrl,
      GOTRUE_DB_NAMESPACE: "auth",
      GOTRUE_JWT_SECRET: "test-secret-test-secret-test-secret-123",
      API_EXTERNAL_URL: "http://localhost:9999",
      GOTRUE_SITE_URL: "http://localhost:3000",
      GOTRUE_API_HOST: "127.0.0.1",
      GOTRUE_API_PORT: "9999",
    },
    stdio: "pipe",
  });

  const dir = path.join(root, "supabase/migrations");
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await db.query(fs.readFileSync(path.join(dir, file), "utf8"));
  }
  await db.end();
  process.env.PC_TEST_DB_URL = superUrl(dbName);
}

export async function teardown() {
  const admin = new Client({ connectionString: superUrl("postgres") });
  await admin.connect();
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.end();
}
