/**
 * OAuth configuration loaded from environment variables.
 *
 * Auth is enabled if GOOGLE_CLIENT_ID is present. Otherwise the server runs
 * in unauthenticated dev mode (same as step 1).
 */

export interface AuthConfig {
  enabled: true;
  publicBaseUrl: string;
  google: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  };
  allowedEmail: string;
  dbPath: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  authCodeTtlSeconds: number;
  pendingRequestTtlSeconds: number;
}

export interface NoAuthConfig {
  enabled: false;
}

export type RuntimeAuthConfig = AuthConfig | NoAuthConfig;

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadAuthConfig(): RuntimeAuthConfig {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return { enabled: false };
  }

  const publicBaseUrl = required('PUBLIC_BASE_URL', process.env.PUBLIC_BASE_URL).replace(/\/$/, '');
  const clientSecret = required('GOOGLE_CLIENT_SECRET', process.env.GOOGLE_CLIENT_SECRET);
  const allowedEmail = required('ALLOWED_GOOGLE_EMAIL', process.env.ALLOWED_GOOGLE_EMAIL).toLowerCase();

  return {
    enabled: true,
    publicBaseUrl,
    google: {
      clientId,
      clientSecret,
      redirectUri: `${publicBaseUrl}/oauth/google/callback`,
    },
    allowedEmail,
    dbPath: process.env.AUTH_DB_PATH ?? './data/auth.db',
    accessTokenTtlSeconds: 60 * 60,           // 1 hour
    refreshTokenTtlSeconds: 60 * 60 * 24 * 30, // 30 days
    authCodeTtlSeconds: 60,                    // 60 seconds
    pendingRequestTtlSeconds: 60 * 10,         // 10 minutes
  };
}
