import { loadConfig, USER_AGENT } from "./config";

let accessToken: string | null = null;
let expiresAt = 0;
let inFlightRefresh: Promise<void> | null = null;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`${status} ${url}: ${body.slice(0, 300)}`);
    this.name = "HttpError";
  }
}

function requireConfig() {
  const result = loadConfig();
  if ("errors" in result) throw new Error(result.errors.join(" "));
  return result.config;
}

async function fetchAccessToken(): Promise<void> {
  const config = requireConfig();
  const resp = await fetch(`${config.baseUrl}/oauth/token`, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: config.refreshToken,
      client_secret: config.clientSecret,
    }).toString(),
  });
  const text = await resp.text();
  if (!resp.ok) throw new HttpError(resp.status, "/oauth/token", text);
  const payload = JSON.parse(text) as { access_token: string; expires_in: number };
  accessToken = payload.access_token;
  expiresAt = Date.now() + payload.expires_in * 1000 - 30_000;
}

/**
 * Refreshes the access token when expired. Concurrent scan workers all call this,
 * so a single in-flight refresh is shared rather than each firing its own.
 */
async function ensureToken(force = false): Promise<void> {
  if (force) {
    accessToken = null;
    expiresAt = 0;
  }
  if (accessToken && Date.now() < expiresAt) return;
  if (!inFlightRefresh) {
    inFlightRefresh = fetchAccessToken().finally(() => {
      inFlightRefresh = null;
    });
  }
  await inFlightRefresh;
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": USER_AGENT,
  };
}

type Params = Record<string, string | number | undefined>;

function buildUrl(path: string, params?: Params): string {
  const config = requireConfig();
  const url = `${config.baseUrl}${path}`;
  if (!params) return url;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const qs = query.toString();
  return qs ? `${url}?${qs}` : url;
}

export async function get<T = any>(
  path: string,
  params?: Params,
  signal?: AbortSignal,
): Promise<T> {
  const url = buildUrl(path, params);
  await ensureToken();
  let resp = await fetch(url, { headers: headers(), signal });
  if (resp.status === 401) {
    await ensureToken(true);
    resp = await fetch(url, { headers: headers(), signal });
  }
  const text = await resp.text();
  if (!resp.ok) throw new HttpError(resp.status, url, text);
  return JSON.parse(text) as T;
}

/**
 * POST to an orders/dry-run style endpoint. A 422 preflight failure still carries
 * a useful buying-power-effect payload (e.g. margin_check_failed just means this
 * account can't currently afford the order, not that the request was malformed),
 * so this returns the parsed body instead of throwing on 422.
 */
export async function postDryRun<T = any>(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const url = buildUrl(path);
  const init = () => ({
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  await ensureToken();
  let resp = await fetch(url, init());
  if (resp.status === 401) {
    await ensureToken(true);
    resp = await fetch(url, init());
  }
  const text = await resp.text();
  if (![200, 201, 422].includes(resp.status)) {
    throw new HttpError(resp.status, url, text);
  }
  return JSON.parse(text) as T;
}
