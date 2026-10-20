// Read-only Salesforce client for the bonus dashboard.
//
// Auth: OAuth 2.0 Client Credentials against a dedicated, read-only External
// Client App / Connected App — the same FLOW the salesforce repo's CI uses
// (see its .github/workflows/_deploy.yml), but a SEPARATE, lower-privilege
// app registration. Never point this at the CI deploy app's client id/secret:
// that one can deploy metadata to prod, and this dashboard has no business
// holding a credential with that blast radius.

interface TokenResponse {
  access_token: string;
  instance_url: string;
  token_type: string;
}

let cachedToken: { accessToken: string; instanceUrl: string; expiresAt: number } | null = null;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

async function getAccessToken(): Promise<{ accessToken: string; instanceUrl: string }> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now) {
    return { accessToken: cachedToken.accessToken, instanceUrl: cachedToken.instanceUrl };
  }

  const instanceUrl = requireEnv("SF_INSTANCE_URL");
  const clientId = requireEnv("SF_CLIENT_ID");
  const clientSecret = requireEnv("SF_CLIENT_SECRET");

  const res = await fetch(`${instanceUrl.replace(/\/$/, "")}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Salesforce token request failed (${res.status}): ${body}`);
  }

  const json = (await res.json()) as TokenResponse;
  // Client Credentials tokens don't return expires_in reliably across orgs —
  // cache conservatively for 15 minutes and re-fetch after.
  cachedToken = {
    accessToken: json.access_token,
    instanceUrl: json.instance_url,
    expiresAt: now + 15 * 60 * 1000,
  };
  return { accessToken: cachedToken.accessToken, instanceUrl: cachedToken.instanceUrl };
}

export interface SoqlResult<T> {
  totalSize: number;
  done: boolean;
  records: T[];
}

export async function soqlQuery<T = Record<string, unknown>>(soql: string): Promise<SoqlResult<T>> {
  const { accessToken, instanceUrl } = await getAccessToken();
  const apiVersion = process.env.SF_API_VERSION ?? "62.0";
  const url = `${instanceUrl}/services/data/v${apiVersion}/query?q=${encodeURIComponent(soql)}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SOQL query failed (${res.status}): ${body}`);
  }

  return (await res.json()) as SoqlResult<T>;
}

// Every page of a row query (soqlQuery returns only the first ~2,000 rows).
// Throws on a short read so a partial pull never shows as a real total.
export async function soqlQueryAll<T = Record<string, unknown>>(soql: string): Promise<T[]> {
  const { accessToken, instanceUrl } = await getAccessToken();
  let page = await soqlQuery<T & Record<string, unknown>>(soql);
  const records: T[] = [...page.records];
  let next = (page as { nextRecordsUrl?: string }).nextRecordsUrl;
  while (!page.done && next) {
    const res = await fetch(`${instanceUrl}${next}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`SOQL query failed (${res.status}): ${await res.text()}`);
    page = (await res.json()) as SoqlResult<T & Record<string, unknown>>;
    records.push(...page.records);
    next = (page as { nextRecordsUrl?: string }).nextRecordsUrl;
  }
  if (records.length !== page.totalSize) throw new Error(`Short read: ${records.length} of ${page.totalSize} rows`);
  return records;
}

export function usingMockData(): boolean {
  if (process.env.USE_MOCK_DATA === "true") return true;
  return !process.env.SF_CLIENT_ID || !process.env.SF_CLIENT_SECRET;
}
