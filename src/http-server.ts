#!/usr/bin/env node

import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { NextFunction, Request, Response } from 'express';
import { createTrelloMcpServer } from './server-factory.js';
import { loadAuthConfig } from './auth/config.js';
import { createOAuthRouter } from './auth/oauth-server.js';
import { requireBearer } from './auth/middleware.js';
import { AuthStores } from './auth/stores.js';
import { openDb, closeDb } from './auth/db.js';
import { logger } from './utils/logger.js';

const TRELLO_API_KEY = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';
const ALLOWED_HOSTS = process.env.ALLOWED_HOSTS?.split(',').map((h) => h.trim()).filter(Boolean);

if (!TRELLO_API_KEY || !TRELLO_TOKEN) {
  logger.error('startup_missing_trello_credentials');
  process.exit(1);
}

let authConfig;
try {
  authConfig = loadAuthConfig();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  logger.error('startup_auth_config_error', { error: message });
  process.exit(1);
}

const app = createMcpExpressApp({
  host: HOST,
  ...(ALLOWED_HOSTS && ALLOWED_HOSTS.length > 0 ? { allowedHosts: ALLOWED_HOSTS } : {}),
});

// Proper client IP detection when running behind Traefik/nginx.
// Needed by express-rate-limit to key by real client address, not the proxy.
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', process.env.TRUST_PROXY);
}

app.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', auth: authConfig.enabled });
});

let stores: AuthStores | undefined;
let cleanupTimer: NodeJS.Timeout | undefined;

if (authConfig.enabled) {
  const db = openDb(authConfig.dbPath);
  stores = new AuthStores(db);
  logger.info('auth_db_opened', { path: authConfig.dbPath });

  app.use(createOAuthRouter(authConfig, stores));

  // Periodic cleanup of expired rows.
  const pendingTtlMs = authConfig.pendingRequestTtlSeconds * 1000;
  const authCodeTtlMs = authConfig.authCodeTtlSeconds * 1000;
  cleanupTimer = setInterval(() => {
    stores!.runCleanup(Date.now(), pendingTtlMs, authCodeTtlMs);
  }, 60 * 1000);
  cleanupTimer.unref();
}

const mcpGuards: Array<(req: Request, res: Response, next: NextFunction) => void> =
  authConfig.enabled && stores ? [requireBearer(authConfig, stores)] : [];

app.post('/mcp', ...mcpGuards, async (req: Request, res: Response) => {
  const server = createTrelloMcpServer({
    apiKey: TRELLO_API_KEY!,
    token: TRELLO_TOKEN!,
  });
  const transport = new StreamableHTTPServerTransport({});

  res.on('close', () => {
    transport.close().catch(() => undefined);
    server.close().catch(() => undefined);
  });

  try {
    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('mcp_request_failed', { error: message });
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

const methodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed (stateless server).' },
    id: null,
  });
};

app.get('/mcp', methodNotAllowed);
app.delete('/mcp', methodNotAllowed);

process.on('uncaughtException', (error) => {
  logger.error('uncaught_exception', { error: error.message, stack: error.stack });
});
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled_rejection', { reason: String(reason) });
});

const httpServer = app.listen(PORT, HOST, () => {
  const mode = authConfig.enabled ? 'OAuth 2.1 (Google)' : 'dev (no auth)';
  logger.info('http_server_listening', { host: HOST, port: PORT, auth: mode });
});

// Graceful shutdown: stop accepting new connections, finish in-flight requests,
// close the DB. Keeps Docker/systemd happy on SIGTERM and avoids data in flight
// being lost.
function shutdown(signal: string) {
  logger.info('shutdown_signal', { signal });
  if (cleanupTimer) clearInterval(cleanupTimer);
  httpServer.close((err) => {
    if (err) logger.error('http_server_close_error', { error: err.message });
    try {
      closeDb();
    } catch (e) {
      logger.error('db_close_error', { error: e instanceof Error ? e.message : String(e) });
    }
    process.exit(0);
  });
  // Force exit after 10s if something is hanging.
  setTimeout(() => {
    logger.warn('shutdown_force_exit');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
