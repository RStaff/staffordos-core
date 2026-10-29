import { isIP } from "node:net";

const RENDER_INTERNAL_HOST = /^dpg-[a-z0-9]+-a$/;
const TLS_QUERY_PARAMETERS = new Set([
  "ssl",
  "sslcert",
  "sslkey",
  "sslmode",
  "sslnegotiation",
  "sslrootcert",
  "uselibpqcompat",
]);
const DESTINATION_QUERY_PARAMETERS = new Set(["host", "hostaddr", "port"]);

function sanitizedConnectionString(url: URL): string {
  const copy = new URL(url.toString());
  for (const key of [...copy.searchParams.keys()]) {
    if (TLS_QUERY_PARAMETERS.has(key.toLowerCase())) copy.searchParams.delete(key);
  }
  return copy.toString();
}

function destinationHost(url: URL): string {
  for (const key of url.searchParams.keys()) {
    if (DESTINATION_QUERY_PARAMETERS.has(key.toLowerCase())) {
      throw new Error("DATABASE_URL_DESTINATION_QUERY_UNSUPPORTED");
    }
  }

  let host: string;
  try {
    host = decodeURIComponent(url.hostname);
  } catch {
    throw new Error("DATABASE_URL_HOST_INVALID");
  }
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  host = host.toLowerCase();
  if (!host || host.includes(",") || host.startsWith("/") || host.includes("\\")) {
    throw new Error("DATABASE_URL_HOST_UNSUPPORTED");
  }
  return host;
}

function isLoopback(host: string): boolean {
  if (host === "localhost" || host === "::1") return true;
  return isIP(host) === 4 && host.split(".")[0] === "127";
}

/** Render internal TLS is encrypted but provider-self-signed; external TLS uses system trust. */
export function postgresConnectionOptions(connectionString: string) {
  const url = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("DATABASE_URL_PROTOCOL_INVALID");
  const host = destinationHost(url);
  const safeConnectionString = sanitizedConnectionString(url);
  if (isLoopback(host)) return { connectionString: safeConnectionString, ssl: false };

  const ssl = RENDER_INTERNAL_HOST.test(host)
    ? { rejectUnauthorized: false }
    : { rejectUnauthorized: true, servername: host };
  return { connectionString: safeConnectionString, ssl };
}
