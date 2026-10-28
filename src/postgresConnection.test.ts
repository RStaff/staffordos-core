import assert from "node:assert/strict";
import test from "node:test";
import { postgresConnectionOptions } from "./postgresConnection.js";

test("localhost remains available for disposable databases", () => {
  const connectionString = "postgresql://u:p@localhost:5432/app";
  assert.deepEqual(postgresConnectionOptions(connectionString), { connectionString });
});

test("Render internal endpoint is encrypted without claiming identity verification", () => {
  assert.deepEqual(postgresConnectionOptions("postgresql://u:p@dpg-example-a:5432/app").ssl, {
    rejectUnauthorized: false,
  });
});

test("external endpoint verifies certificate and hostname", () => {
  const options = postgresConnectionOptions("postgresql://u:p@db.example.com:5432/app?sslmode=require");
  assert.deepEqual(options.ssl, { rejectUnauthorized: true, servername: "db.example.com" });
  assert.equal(new URL(options.connectionString).searchParams.has("sslmode"), false);
});

test("invalid protocol rejects", () => {
  assert.throws(() => postgresConnectionOptions("https://example.com"), /DATABASE_URL_PROTOCOL_INVALID/);
});
