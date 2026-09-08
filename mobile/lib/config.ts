export const BASE_URLS = {
  prod: "https://api.tastyworks.com",
  cert: "https://api.cert.tastyworks.com",
} as const;

export const USER_AGENT = "tasty-sandbox/1.0";

export type AppConfig = {
  env: string;
  baseUrl: string;
  clientSecret: string;
  refreshToken: string;
};

/**
 * Credentials are baked in at build time by app.config.ts and read back through
 * expo-constants. The same module is imported by scripts/scan-cli.ts under plain
 * Node, where expo-constants is unavailable -- there we fall back to process.env
 * (populated from ../.env by the CLI), so the scan logic stays platform-agnostic.
 */
function readExtra(): Record<string, unknown> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Constants = require("expo-constants").default;
    return (Constants?.expoConfig?.extra ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Returns the config, or a list of human-readable problems that block a scan. */
export function loadConfig(): { config: AppConfig } | { errors: string[] } {
  const extra = readExtra();
  const env = str(extra.tastyEnv) ?? str(process.env.TASTY_ENV) ?? "prod";
  const clientSecret = str(extra.clientSecret) ?? str(process.env.TASTY_CLIENT_SECRET);
  const refreshToken = str(extra.refreshToken) ?? str(process.env.TASTY_REFRESH_TOKEN);

  const errors: string[] = [];
  if (env !== "prod") {
    errors.push(
      `TASTY_ENV is "${env}", but this app requires prod: cert has no ` +
        `/market-data/by-type endpoint, which the scan depends on for underlying ` +
        `and option prices.`,
    );
  }
  if (!clientSecret) errors.push("TASTY_CLIENT_SECRET is missing from .env.");
  if (!refreshToken) errors.push("TASTY_REFRESH_TOKEN is missing from .env.");

  if (errors.length > 0) return { errors };
  return {
    config: {
      env,
      baseUrl: BASE_URLS.prod,
      clientSecret: clientSecret!,
      refreshToken: refreshToken!,
    },
  };
}
