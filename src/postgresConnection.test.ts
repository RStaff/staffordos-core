import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkServerIdentity, connect, createServer, type ConnectionOptions } from "node:tls";
import test from "node:test";
import pg from "pg";
import { postgresConnectionOptions } from "./postgresConnection.js";

const { Client } = pg;

function makeTlsFixture() {
  const directory = mkdtempSync(join(tmpdir(), "postgres-tls-policy-"));
  const caKey = join(directory, "ca.key");
  const caCertificate = join(directory, "ca.crt");
  const serverKey = join(directory, "server.key");
  const request = join(directory, "server.csr");
  const serverCertificate = join(directory, "server.crt");
  const extensions = join(directory, "extensions.cnf");
  const quiet = { stdio: "ignore" } as const;
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=TLS Policy Test CA", "-keyout", caKey, "-out", caCertificate], quiet);
  execFileSync("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=db.example.com", "-keyout", serverKey, "-out", request], quiet);
  writeFileSync(extensions, "subjectAltName=DNS:db.example.com\n");
  execFileSync("openssl", ["x509", "-req", "-days", "1", "-in", request, "-CA", caCertificate, "-CAkey", caKey, "-CAcreateserial", "-extfile", extensions, "-out", serverCertificate], quiet);
  return {
    ca: readFileSync(caCertificate),
    cert: readFileSync(serverCertificate),
    key: readFileSync(serverKey),
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function tlsAttempt(port: number, options: ConnectionOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port, ...options }, () => {
      socket.end();
      resolve();
    });
    socket.once("error", reject);
  });
}

function parsed(connectionString: string) {
  return new Client(postgresConnectionOptions(connectionString)).connectionParameters;
}

const TLS_QUERY_CASES = [
  "ssl=false",
  "ssl=0",
  "ssl=no-verify",
  "sslmode=disable",
  "sslmode=no-verify",
  "sslcert=%2Fdoes-not-exist",
  "sslkey=%2Fdoes-not-exist",
  "sslrootcert=%2Fdoes-not-exist",
  "sslnegotiation=direct",
  "uselibpqcompat=true&sslmode=disable",
];

test("all supported URL TLS controls are removed before pg parses the URL", () => {
  for (const query of TLS_QUERY_CASES) {
    const options = postgresConnectionOptions(`postgresql://u:p@db.example.com:5432/app?${query}`);
    const effective = new Client(options).connectionParameters;
    assert.deepEqual(effective.ssl, { rejectUnauthorized: true, servername: "db.example.com" }, query);
    const remaining = [...new URL(options.connectionString).searchParams.keys()].map((key) => key.toLowerCase());
    assert.equal(remaining.some((key) => ["ssl", "sslcert", "sslkey", "sslmode", "sslnegotiation", "sslrootcert", "uselibpqcompat"].includes(key)), false, query);
  }
});

test("query and unsupported destination selectors reject instead of overriding authority", () => {
  for (const suffix of [
    "?host=evil.example.com",
    "?HOST=evil.example.com",
    "?hostaddr=203.0.113.7",
    "?port=6543",
  ]) {
    assert.throws(
      () => postgresConnectionOptions(`postgresql://u:p@db.example.com:5432/app${suffix}`),
      /DATABASE_URL_DESTINATION_QUERY_UNSUPPORTED/,
      suffix,
    );
  }
  for (const connectionString of [
    "postgresql://u:p@db.example.com,evil.example.com:5432/app",
    "postgresql://u:p@%2Fvar%2Frun%2Fpostgresql/app",
    "socket:/var/run/postgresql?db=app",
  ]) {
    assert.throws(() => postgresConnectionOptions(connectionString), /DATABASE_URL_(?:HOST|PROTOCOL)/, connectionString);
  }
});

test("case-insensitive localhost and IP loopbacks remain explicitly non-TLS", () => {
  for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "127.23.45.67", "[::1]"]) {
    const effective = parsed(`postgresql://u:p@${host}:5432/app?ssl=no-verify`);
    assert.equal(effective.ssl, false, host);
  }
});

test("only exact Render internal hostnames use the documented encrypted unverified policy", () => {
  for (const host of ["dpg-example-a", "DPG-EXAMPLE-A"]) {
    assert.deepEqual(parsed(`postgresql://u:p@${host}:5432/app`).ssl, { rejectUnauthorized: false }, host);
  }
  for (const host of ["dpg-example-a.evil.test", "xdpg-example-a", "dpg-example-a-evil", "dpg-example-a."]) {
    assert.deepEqual(
      parsed(`postgresql://u:p@${host}:5432/app`).ssl,
      { rejectUnauthorized: true, servername: host.toLowerCase() },
      host,
    );
  }
});

test("external effective pg configuration requires trusted issuer and matching hostname", () => {
  const effective = parsed("postgresql://u:p@db.example.com:5432/app?ssl=false");
  assert.deepEqual(effective.ssl, { rejectUnauthorized: true, servername: "db.example.com" });
  const matchingCertificate = { subjectaltname: "DNS:db.example.com" } as Parameters<typeof checkServerIdentity>[1];
  const mismatchedCertificate = { subjectaltname: "DNS:other.example.com" } as Parameters<typeof checkServerIdentity>[1];
  assert.equal(checkServerIdentity(effective.ssl.servername, matchingCertificate), undefined);
  const mismatch = checkServerIdentity(effective.ssl.servername, mismatchedCertificate);
  assert.ok(mismatch);
  assert.match(mismatch.message, /does not match certificate/);
});

test("invalid protocol rejects", () => {
  assert.throws(() => postgresConnectionOptions("https://example.com"), /DATABASE_URL_PROTOCOL_INVALID/);
});

test("external TLS accepts trusted identity and rejects untrusted or mismatched identity", async (t) => {
  const fixture = makeTlsFixture();
  t.after(fixture.remove);
  const server = createServer({ cert: fixture.cert, key: fixture.key }, (socket) => socket.end());
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const trusted = parsed("postgresql://u:p@db.example.com:5432/app?ssl=false").ssl;
  await tlsAttempt(address.port, { ...trusted, ca: fixture.ca });
  await assert.rejects(tlsAttempt(address.port, trusted), /certificate|issuer|self-signed|verify/i);

  const mismatched = parsed("postgresql://u:p@other.example.com:5432/app").ssl;
  await assert.rejects(tlsAttempt(address.port, { ...mismatched, ca: fixture.ca }), /hostname|does not match|not cert/i);
});
