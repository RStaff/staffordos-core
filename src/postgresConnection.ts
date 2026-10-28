const RENDER_INTERNAL_HOST = /^dpg-[a-z0-9]+-a$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function sanitizedConnectionString(url: URL): string {
  const copy = new URL(url.toString());
  for (const key of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) copy.searchParams.delete(key);
  return copy.toString();
}

/** Render internal TLS is encrypted but provider-self-signed; external TLS uses system trust. */
export function postgresConnectionOptions(connectionString: string) {
  const url = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("DATABASE_URL_PROTOCOL_INVALID");
  if (LOOPBACK_HOSTS.has(url.hostname)) return { connectionString };

  const ssl = RENDER_INTERNAL_HOST.test(url.hostname)
    ? { rejectUnauthorized: false }
    : { rejectUnauthorized: true, servername: url.hostname };
  return { connectionString: sanitizedConnectionString(url), ssl };
}
