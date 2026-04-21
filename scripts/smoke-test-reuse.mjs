// Smoke test: refresh-token reuse detection.
//
// Scenario:
//   1. Start the server (assumed to be running on 127.0.0.1:3399 with auth).
//   2. Register an OAuth client.
//   3. Directly insert an auth_code into SQLite (simulating a successful Google login).
//   4. Exchange it for the first token pair (AT1, RT1) via /token?grant_type=authorization_code.
//   5. Rotate with RT1 → get (AT2, RT2).
//   6. Try to reuse RT1 → expect invalid_grant "reuse detected".
//   7. Verify that AT2 no longer authenticates /mcp (family was revoked).

import { randomBytes, createHash } from 'node:crypto';
import Database from 'better-sqlite3';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3399';
const DB_PATH = process.env.AUTH_DB_PATH ?? './data/auth.db';

function b64url(buf) {
  return buf.toString('base64url');
}

async function j(res) {
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, text };
  }
}

async function register() {
  const res = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Reuse Test',
      redirect_uris: ['http://localhost:9999/cb'],
    }),
  });
  const body = await j(res);
  if (body.status !== 201) throw new Error(`register failed: ${JSON.stringify(body)}`);
  return body.json.client_id;
}

function insertAuthCode(db, clientId, code, codeChallenge) {
  db.prepare(
    `INSERT INTO auth_codes (code, client_id, redirect_uri, code_challenge, google_sub, google_email, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(code, clientId, 'http://localhost:9999/cb', codeChallenge, 'google-sub-123', 'allowed@example.com', Date.now());
}

async function tokenByCode(clientId, code, codeVerifier) {
  const res = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'http://localhost:9999/cb',
      code_verifier: codeVerifier,
      client_id: clientId,
    }),
  });
  return j(res);
}

async function tokenByRefresh(clientId, refreshToken) {
  const res = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });
  return j(res);
}

async function callMcp(accessToken) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'smoke', version: '1' },
      },
    }),
  });
  return res.status;
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

(async () => {
  console.log('1. Register a client');
  const clientId = await register();
  console.log(`   client_id=${clientId}`);

  console.log('2. Insert an auth_code directly into SQLite');
  const codeVerifier = b64url(randomBytes(32));
  const codeChallenge = b64url(createHash('sha256').update(codeVerifier).digest());
  const authCode = b64url(randomBytes(32));
  const db = new Database(DB_PATH);
  try {
    insertAuthCode(db, clientId, authCode, codeChallenge);
  } finally {
    db.close();
  }

  console.log('3. Exchange auth_code → tokens pair 1');
  const r1 = await tokenByCode(clientId, authCode, codeVerifier);
  assert(r1.status === 200, 'authorization_code grant returns 200');
  const { access_token: AT1, refresh_token: RT1 } = r1.json;
  assert(typeof AT1 === 'string' && AT1.length > 0, 'AT1 is a string');
  assert(typeof RT1 === 'string' && RT1.length > 0, 'RT1 is a string');

  console.log('4. Verify AT1 authenticates /mcp');
  const mcpStatus1 = await callMcp(AT1);
  assert(mcpStatus1 === 200, `AT1 on /mcp returns 200 (got ${mcpStatus1})`);

  console.log('5. Rotate refresh token (RT1 → AT2/RT2)');
  const r2 = await tokenByRefresh(clientId, RT1);
  assert(r2.status === 200, 'refresh_token grant returns 200');
  const { access_token: AT2, refresh_token: RT2 } = r2.json;
  assert(AT2 !== AT1, 'AT2 differs from AT1');
  assert(RT2 !== RT1, 'RT2 differs from RT1');

  console.log('6. Attempt to reuse RT1 → should be rejected + revoke family');
  const r3 = await tokenByRefresh(clientId, RT1);
  assert(r3.status === 400, `RT1 reuse returns 400 (got ${r3.status})`);
  assert(r3.json?.error === 'invalid_grant', `error == invalid_grant (got ${r3.json?.error})`);
  assert(
    typeof r3.json?.error_description === 'string' && r3.json.error_description.toLowerCase().includes('reuse'),
    `error_description mentions reuse (got "${r3.json?.error_description}")`,
  );

  console.log('7. After revoke, AT2 must no longer authenticate /mcp');
  const mcpStatus2 = await callMcp(AT2);
  assert(mcpStatus2 === 401, `AT2 on /mcp returns 401 after family revoke (got ${mcpStatus2})`);

  console.log('\nAll assertions passed.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
