/**
 * SQLite-backed stores for OAuth state.
 *
 * Same external API as the previous in-memory implementation, plus:
 *  - Refresh tokens carry a `familyId` grouping all tokens from the same
 *    initial authorization. On reuse detection we revoke the whole family.
 *  - Refresh tokens are kept after consumption (marked `used=1`) precisely
 *    so reuse can be detected.
 */

import type { DB } from './db.js';

export interface RegisteredClient {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  createdAt: number;
}

export interface PendingAuthRequest {
  requestId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  state: string;
  scope: string | null;
  createdAt: number;
}

export interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  googleSub: string;
  googleEmail: string;
  createdAt: number;
}

export interface AccessTokenRecord {
  token: string;
  familyId: string;
  clientId: string;
  googleSub: string;
  googleEmail: string;
  expiresAt: number;
}

export interface RefreshTokenRecord {
  token: string;
  familyId: string;
  clientId: string;
  googleSub: string;
  googleEmail: string;
  expiresAt: number;
  used: boolean;
  replacedBy: string | null;
}

interface ClientRow {
  client_id: string;
  client_name: string | null;
  redirect_uris: string;
  created_at: number;
}

interface PendingRequestRow {
  request_id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string;
  scope: string | null;
  created_at: number;
}

interface AuthCodeRow {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  google_sub: string;
  google_email: string;
  created_at: number;
}

interface AccessTokenRow {
  token: string;
  family_id: string;
  client_id: string;
  google_sub: string;
  google_email: string;
  expires_at: number;
}

interface RefreshTokenRow {
  token: string;
  family_id: string;
  client_id: string;
  google_sub: string;
  google_email: string;
  expires_at: number;
  used: number;
  replaced_by: string | null;
}

export class AuthStores {
  private readonly insertClient;
  private readonly selectClient;
  private readonly insertPending;
  private readonly selectPending;
  private readonly deletePending;
  private readonly insertAuthCode;
  private readonly selectAuthCode;
  private readonly deleteAuthCode;
  private readonly insertAccessToken;
  private readonly selectAccessToken;
  private readonly deleteAccessToken;
  private readonly deleteAccessByFamily;
  private readonly insertRefreshToken;
  private readonly selectRefreshToken;
  private readonly markRefreshUsed;
  private readonly deleteRefreshByFamily;
  private readonly cleanupPending;
  private readonly cleanupAuthCodes;
  private readonly cleanupAccessTokens;
  private readonly cleanupRefreshTokens;

  constructor(db: DB) {
    this.insertClient = db.prepare(
      `INSERT OR REPLACE INTO clients (client_id, client_name, redirect_uris, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    this.selectClient = db.prepare(
      `SELECT client_id, client_name, redirect_uris, created_at FROM clients WHERE client_id = ?`,
    );

    this.insertPending = db.prepare(
      `INSERT INTO pending_requests
         (request_id, client_id, redirect_uri, code_challenge, state, scope, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.selectPending = db.prepare(
      `SELECT request_id, client_id, redirect_uri, code_challenge, state, scope, created_at
       FROM pending_requests WHERE request_id = ?`,
    );
    this.deletePending = db.prepare(`DELETE FROM pending_requests WHERE request_id = ?`);

    this.insertAuthCode = db.prepare(
      `INSERT INTO auth_codes
         (code, client_id, redirect_uri, code_challenge, google_sub, google_email, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.selectAuthCode = db.prepare(
      `SELECT code, client_id, redirect_uri, code_challenge, google_sub, google_email, created_at
       FROM auth_codes WHERE code = ?`,
    );
    this.deleteAuthCode = db.prepare(`DELETE FROM auth_codes WHERE code = ?`);

    this.insertAccessToken = db.prepare(
      `INSERT INTO access_tokens
         (token, family_id, client_id, google_sub, google_email, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.selectAccessToken = db.prepare(
      `SELECT token, family_id, client_id, google_sub, google_email, expires_at
       FROM access_tokens WHERE token = ?`,
    );
    this.deleteAccessToken = db.prepare(`DELETE FROM access_tokens WHERE token = ?`);
    this.deleteAccessByFamily = db.prepare(`DELETE FROM access_tokens WHERE family_id = ?`);

    this.insertRefreshToken = db.prepare(
      `INSERT INTO refresh_tokens
         (token, family_id, client_id, google_sub, google_email, expires_at, used, replaced_by)
       VALUES (?, ?, ?, ?, ?, ?, 0, NULL)`,
    );
    this.selectRefreshToken = db.prepare(
      `SELECT token, family_id, client_id, google_sub, google_email, expires_at, used, replaced_by
       FROM refresh_tokens WHERE token = ?`,
    );
    this.markRefreshUsed = db.prepare(
      `UPDATE refresh_tokens SET used = 1, replaced_by = ? WHERE token = ? AND used = 0`,
    );
    this.deleteRefreshByFamily = db.prepare(`DELETE FROM refresh_tokens WHERE family_id = ?`);

    this.cleanupPending = db.prepare(`DELETE FROM pending_requests WHERE created_at < ?`);
    this.cleanupAuthCodes = db.prepare(`DELETE FROM auth_codes WHERE created_at < ?`);
    this.cleanupAccessTokens = db.prepare(`DELETE FROM access_tokens WHERE expires_at < ?`);
    this.cleanupRefreshTokens = db.prepare(`DELETE FROM refresh_tokens WHERE expires_at < ?`);
  }

  // Clients
  saveClient(client: RegisteredClient): void {
    this.insertClient.run(
      client.clientId,
      client.clientName ?? null,
      JSON.stringify(client.redirectUris),
      client.createdAt,
    );
  }
  getClient(clientId: string): RegisteredClient | undefined {
    const row = this.selectClient.get(clientId) as ClientRow | undefined;
    if (!row) return undefined;
    return {
      clientId: row.client_id,
      ...(row.client_name ? { clientName: row.client_name } : {}),
      redirectUris: JSON.parse(row.redirect_uris) as string[],
      createdAt: row.created_at,
    };
  }

  // Pending auth requests
  savePendingRequest(req: PendingAuthRequest): void {
    this.insertPending.run(
      req.requestId,
      req.clientId,
      req.redirectUri,
      req.codeChallenge,
      req.state,
      req.scope,
      req.createdAt,
    );
  }
  takePendingRequest(requestId: string): PendingAuthRequest | undefined {
    const row = this.selectPending.get(requestId) as PendingRequestRow | undefined;
    if (!row) return undefined;
    this.deletePending.run(requestId);
    return {
      requestId: row.request_id,
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge,
      codeChallengeMethod: 'S256',
      state: row.state,
      scope: row.scope,
      createdAt: row.created_at,
    };
  }

  // Authorization codes
  saveAuthCode(code: AuthCode): void {
    this.insertAuthCode.run(
      code.code,
      code.clientId,
      code.redirectUri,
      code.codeChallenge,
      code.googleSub,
      code.googleEmail,
      code.createdAt,
    );
  }
  takeAuthCode(code: string): AuthCode | undefined {
    const row = this.selectAuthCode.get(code) as AuthCodeRow | undefined;
    if (!row) return undefined;
    this.deleteAuthCode.run(code);
    return {
      code: row.code,
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge,
      googleSub: row.google_sub,
      googleEmail: row.google_email,
      createdAt: row.created_at,
    };
  }

  // Access tokens
  saveAccessToken(rec: AccessTokenRecord): void {
    this.insertAccessToken.run(
      rec.token,
      rec.familyId,
      rec.clientId,
      rec.googleSub,
      rec.googleEmail,
      rec.expiresAt,
    );
  }
  getAccessToken(token: string): AccessTokenRecord | undefined {
    const row = this.selectAccessToken.get(token) as AccessTokenRow | undefined;
    if (!row) return undefined;
    return {
      token: row.token,
      familyId: row.family_id,
      clientId: row.client_id,
      googleSub: row.google_sub,
      googleEmail: row.google_email,
      expiresAt: row.expires_at,
    };
  }
  revokeAccessToken(token: string): void {
    this.deleteAccessToken.run(token);
  }

  // Refresh tokens
  saveRefreshToken(rec: Omit<RefreshTokenRecord, 'used' | 'replacedBy'>): void {
    this.insertRefreshToken.run(
      rec.token,
      rec.familyId,
      rec.clientId,
      rec.googleSub,
      rec.googleEmail,
      rec.expiresAt,
    );
  }
  getRefreshToken(token: string): RefreshTokenRecord | undefined {
    const row = this.selectRefreshToken.get(token) as RefreshTokenRow | undefined;
    if (!row) return undefined;
    return {
      token: row.token,
      familyId: row.family_id,
      clientId: row.client_id,
      googleSub: row.google_sub,
      googleEmail: row.google_email,
      expiresAt: row.expires_at,
      used: row.used === 1,
      replacedBy: row.replaced_by,
    };
  }
  markRefreshTokenUsed(token: string, replacedBy: string): boolean {
    const result = this.markRefreshUsed.run(replacedBy, token);
    return result.changes > 0;
  }
  revokeFamily(familyId: string): void {
    this.deleteAccessByFamily.run(familyId);
    this.deleteRefreshByFamily.run(familyId);
  }

  // Periodic cleanup
  runCleanup(now: number, pendingTtlMs: number, authCodeTtlMs: number): void {
    this.cleanupPending.run(now - pendingTtlMs);
    this.cleanupAuthCodes.run(now - authCodeTtlMs);
    this.cleanupAccessTokens.run(now);
    this.cleanupRefreshTokens.run(now);
  }
}
