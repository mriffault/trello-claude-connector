/**
 * OAuth 2.1 Authorization Server endpoints.
 *
 * Implements:
 *  - RFC 8414 — Authorization Server Metadata         (/.well-known/oauth-authorization-server)
 *  - RFC 9728 — Protected Resource Metadata           (/.well-known/oauth-protected-resource)
 *  - RFC 7591 — Dynamic Client Registration           (POST /register)
 *  - OAuth 2.1 authorization-code flow with PKCE S256 (/authorize, /token)
 *  - Refresh-token rotation with reuse detection: consuming a refresh token
 *    twice revokes the entire token family.
 *
 * User authentication is delegated to Google via /oauth/google/callback.
 * Only the email listed in ALLOWED_GOOGLE_EMAIL is accepted (mono-user setup).
 */

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { Router, urlencoded, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { AuthConfig } from './config.js';
import type { AuthStores } from './stores.js';
import { buildGoogleAuthUrl, exchangeGoogleCode, fetchGoogleUserInfo } from './google.js';
import { logger } from '../utils/logger.js';

function randomId(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function sha256Base64Url(input: string): string {
  return createHash('sha256').update(input).digest('base64url');
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function oauthError(
  res: Response,
  status: number,
  error: string,
  description?: string,
): void {
  res.status(status).json({
    error,
    ...(description ? { error_description: description } : {}),
  });
}

function htmlError(res: Response, status: number, message: string): void {
  res
    .status(status)
    .type('text/html; charset=utf-8')
    .send(`<!doctype html><meta charset="utf-8"><title>Error</title><h1>${status}</h1><p>${message}</p>`);
}

interface IssuedTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

function issueTokenPair(
  config: AuthConfig,
  stores: AuthStores,
  familyId: string,
  clientId: string,
  googleSub: string,
  googleEmail: string,
): IssuedTokenPair {
  const accessToken = randomId();
  const refreshToken = randomId();
  const now = Date.now();
  stores.saveAccessToken({
    token: accessToken,
    familyId,
    clientId,
    googleSub,
    googleEmail,
    expiresAt: now + config.accessTokenTtlSeconds * 1000,
  });
  stores.saveRefreshToken({
    token: refreshToken,
    familyId,
    clientId,
    googleSub,
    googleEmail,
    expiresAt: now + config.refreshTokenTtlSeconds * 1000,
  });
  return { accessToken, refreshToken, expiresIn: config.accessTokenTtlSeconds };
}

export function createOAuthRouter(config: AuthConfig, stores: AuthStores): Router {
  const router = Router();

  // Permissive CORS for browser-based clients (MCP Inspector, Claude web).
  // Metadata documents MUST be fetchable cross-origin per RFC 9728.
  router.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, mcp-protocol-version');
    res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Rate limits. Generous enough for a real human, tight enough to frustrate
  // brute-forcers. `/authorize` is looser because the browser may retry during
  // a normal login.
  const tokenLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  });
  const registerLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  });
  const authorizeLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  });

  // --- Discovery metadata ----------------------------------------------------

  router.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({
      resource: `${config.publicBaseUrl}/mcp`,
      authorization_servers: [config.publicBaseUrl],
      bearer_methods_supported: ['header'],
      scopes_supported: [],
    });
  });

  router.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.json({
      issuer: config.publicBaseUrl,
      authorization_endpoint: `${config.publicBaseUrl}/authorize`,
      token_endpoint: `${config.publicBaseUrl}/token`,
      registration_endpoint: `${config.publicBaseUrl}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [],
    });
  });

  // --- Dynamic Client Registration (RFC 7591) --------------------------------

  router.post('/register', registerLimiter, (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      client_name?: unknown;
      redirect_uris?: unknown;
      grant_types?: unknown;
      response_types?: unknown;
      token_endpoint_auth_method?: unknown;
    };

    if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
      oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris must be a non-empty array');
      return;
    }
    const redirectUris = body.redirect_uris.filter((u): u is string => typeof u === 'string');
    if (redirectUris.length === 0) {
      oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris must contain strings');
      return;
    }

    const clientId = randomId(16);
    const createdAt = Date.now();
    stores.saveClient({
      clientId,
      ...(typeof body.client_name === 'string' ? { clientName: body.client_name } : {}),
      redirectUris,
      createdAt,
    });

    logger.info('oauth_client_registered', {
      client_id: clientId,
      ...(typeof body.client_name === 'string' ? { client_name: body.client_name } : {}),
      redirect_uris: redirectUris,
    });

    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(createdAt / 1000),
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  // --- Authorization endpoint ------------------------------------------------

  router.get('/authorize', authorizeLimiter, (req: Request, res: Response) => {
    const {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: responseType,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      state,
      scope,
    } = req.query as Record<string, string | undefined>;

    if (!clientId || !redirectUri || !state) {
      htmlError(res, 400, 'Missing client_id, redirect_uri or state.');
      return;
    }
    if (responseType !== 'code') {
      htmlError(res, 400, 'response_type must be "code".');
      return;
    }
    if (codeChallengeMethod !== 'S256' || !codeChallenge) {
      htmlError(res, 400, 'PKCE with code_challenge_method=S256 is required.');
      return;
    }

    const client = stores.getClient(clientId);
    if (!client) {
      htmlError(res, 400, 'Unknown client_id. Register first at /register.');
      return;
    }
    if (!client.redirectUris.includes(redirectUri)) {
      htmlError(res, 400, 'redirect_uri does not match any registered URI.');
      return;
    }

    const requestId = randomId();
    stores.savePendingRequest({
      requestId,
      clientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod: 'S256',
      state,
      scope: typeof scope === 'string' ? scope : null,
      createdAt: Date.now(),
    });

    res.redirect(302, buildGoogleAuthUrl(config, requestId));
  });

  // --- Google callback -------------------------------------------------------

  router.get('/oauth/google/callback', async (req: Request, res: Response) => {
    const { code, state, error } = req.query as Record<string, string | undefined>;

    if (error) {
      htmlError(res, 400, `Google returned error: ${error}`);
      return;
    }
    if (!code || !state) {
      htmlError(res, 400, 'Missing code or state from Google.');
      return;
    }

    const pending = stores.takePendingRequest(state);
    if (!pending) {
      htmlError(res, 400, 'Unknown or expired authorization request.');
      return;
    }
    if (Date.now() - pending.createdAt > config.pendingRequestTtlSeconds * 1000) {
      htmlError(res, 400, 'Authorization request expired. Please retry.');
      return;
    }

    try {
      const { accessToken } = await exchangeGoogleCode(config, code);
      const userInfo = await fetchGoogleUserInfo(accessToken);

      if (!userInfo.email_verified) {
        logger.warn('oauth_google_email_unverified', { email: userInfo.email });
        htmlError(res, 403, 'Your Google email is not verified.');
        return;
      }
      if (userInfo.email.toLowerCase() !== config.allowedEmail) {
        logger.warn('oauth_google_email_not_allowed', { email: userInfo.email });
        htmlError(res, 403, `Access denied for ${userInfo.email}.`);
        return;
      }

      const authCode = randomId();
      stores.saveAuthCode({
        code: authCode,
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        googleSub: userInfo.sub,
        googleEmail: userInfo.email,
        createdAt: Date.now(),
      });

      logger.info('oauth_auth_code_issued', {
        client_id: pending.clientId,
        email: userInfo.email,
      });

      const redirect = new URL(pending.redirectUri);
      redirect.searchParams.set('code', authCode);
      redirect.searchParams.set('state', pending.state);
      res.redirect(302, redirect.toString());
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error('oauth_google_callback_failed', { error: message });
      htmlError(res, 502, `Google authentication failed: ${message}`);
    }
  });

  // --- Token endpoint --------------------------------------------------------

  router.post('/token', tokenLimiter, urlencoded({ extended: false }), (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const grantType = body.grant_type;

    if (grantType === 'authorization_code') {
      const { code, redirect_uri: redirectUri, code_verifier: codeVerifier, client_id: clientId } = body;

      if (!code || !redirectUri || !codeVerifier || !clientId) {
        oauthError(res, 400, 'invalid_request', 'Missing code, redirect_uri, code_verifier or client_id');
        return;
      }

      const stored = stores.takeAuthCode(code);
      if (!stored) {
        oauthError(res, 400, 'invalid_grant', 'Unknown or expired authorization code');
        return;
      }
      if (Date.now() - stored.createdAt > config.authCodeTtlSeconds * 1000) {
        oauthError(res, 400, 'invalid_grant', 'Authorization code expired');
        return;
      }
      if (stored.clientId !== clientId) {
        oauthError(res, 400, 'invalid_grant', 'client_id mismatch');
        return;
      }
      if (stored.redirectUri !== redirectUri) {
        oauthError(res, 400, 'invalid_grant', 'redirect_uri mismatch');
        return;
      }

      const expected = sha256Base64Url(codeVerifier);
      if (!constantTimeEqual(expected, stored.codeChallenge)) {
        oauthError(res, 400, 'invalid_grant', 'PKCE verification failed');
        return;
      }

      const familyId = randomId(16);
      const pair = issueTokenPair(config, stores, familyId, clientId, stored.googleSub, stored.googleEmail);
      logger.info('oauth_token_issued', { grant: 'authorization_code', client_id: clientId, family_id: familyId });

      res.json({
        access_token: pair.accessToken,
        token_type: 'Bearer',
        expires_in: pair.expiresIn,
        refresh_token: pair.refreshToken,
      });
      return;
    }

    if (grantType === 'refresh_token') {
      const { refresh_token: refreshToken, client_id: clientId } = body;
      if (!refreshToken || !clientId) {
        oauthError(res, 400, 'invalid_request', 'Missing refresh_token or client_id');
        return;
      }
      const stored = stores.getRefreshToken(refreshToken);
      if (!stored) {
        oauthError(res, 400, 'invalid_grant', 'Unknown refresh token');
        return;
      }
      if (stored.clientId !== clientId) {
        oauthError(res, 400, 'invalid_grant', 'client_id mismatch');
        return;
      }
      if (stored.expiresAt < Date.now()) {
        oauthError(res, 400, 'invalid_grant', 'Refresh token expired');
        return;
      }
      if (stored.used) {
        // Reuse detected — revoke entire family (OAuth 2.1 recommended behaviour).
        stores.revokeFamily(stored.familyId);
        logger.warn('oauth_refresh_reuse_detected', {
          client_id: clientId,
          family_id: stored.familyId,
        });
        oauthError(res, 400, 'invalid_grant', 'Refresh token reuse detected; all tokens revoked');
        return;
      }

      const pair = issueTokenPair(
        config,
        stores,
        stored.familyId,
        clientId,
        stored.googleSub,
        stored.googleEmail,
      );
      stores.markRefreshTokenUsed(refreshToken, pair.refreshToken);
      logger.info('oauth_token_refreshed', { client_id: clientId, family_id: stored.familyId });

      res.json({
        access_token: pair.accessToken,
        token_type: 'Bearer',
        expires_in: pair.expiresIn,
        refresh_token: pair.refreshToken,
      });
      return;
    }

    oauthError(res, 400, 'unsupported_grant_type', `Unsupported grant_type: ${grantType ?? '(missing)'}`);
  });

  return router;
}
