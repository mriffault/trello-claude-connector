/**
 * SQLite database for OAuth state (clients, auth codes, tokens).
 *
 * Schema highlights
 *  - `refresh_tokens.used` is kept TRUE after consumption so we can detect
 *    reuse (OAuth 2.1 security requirement).
 *  - `family_id` groups all tokens issued from the same initial authorization.
 *    On reuse detection we revoke the entire family.
 *  - WAL mode is enabled for concurrency; `unlink` on a Docker volume is safe.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT,
  redirect_uris TEXT NOT NULL,  -- JSON array
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_requests (
  request_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  state TEXT NOT NULL,
  scope TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_codes (
  code TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  google_sub TEXT NOT NULL,
  google_email TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS access_tokens (
  token TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  google_sub TEXT NOT NULL,
  google_email TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_access_family ON access_tokens(family_id);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  token TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  google_sub TEXT NOT NULL,
  google_email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  replaced_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_refresh_family ON refresh_tokens(family_id);
`;

let dbInstance: DB | null = null;

export function openDb(path: string): DB {
  if (dbInstance) return dbInstance;

  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  dbInstance = db;
  return db;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
