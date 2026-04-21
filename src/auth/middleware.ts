/**
 * Bearer auth middleware for the MCP endpoint.
 *
 * Returns RFC 6750 compliant WWW-Authenticate headers with a pointer to the
 * OAuth 2.0 protected resource metadata document (RFC 9728), which tells the
 * client where to discover the authorization server.
 */

import type { Request, Response, NextFunction } from 'express';
import type { AuthConfig } from './config.js';
import type { AuthStores } from './stores.js';

export interface AuthenticatedRequest extends Request {
  auth?: {
    clientId: string;
    googleSub: string;
    googleEmail: string;
    token: string;
  };
}

function resourceMetadataUrl(config: AuthConfig): string {
  return `${config.publicBaseUrl}/.well-known/oauth-protected-resource`;
}

function sendUnauthorized(
  res: Response,
  config: AuthConfig,
  error?: 'invalid_token' | 'insufficient_scope',
  description?: string,
): void {
  const parts = [
    `Bearer realm="trello-mcp"`,
    `resource_metadata="${resourceMetadataUrl(config)}"`,
  ];
  if (error) parts.push(`error="${error}"`);
  if (description) parts.push(`error_description="${description.replace(/"/g, "'")}"`);

  res.setHeader('WWW-Authenticate', parts.join(', '));
  res.status(401).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: description ?? 'Unauthorized' },
    id: null,
  });
}

export function requireBearer(config: AuthConfig, stores: AuthStores) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      sendUnauthorized(res, config);
      return;
    }

    const token = header.slice('Bearer '.length).trim();
    const record = stores.getAccessToken(token);
    if (!record) {
      sendUnauthorized(res, config, 'invalid_token', 'Unknown or revoked token');
      return;
    }
    if (record.expiresAt < Date.now()) {
      sendUnauthorized(res, config, 'invalid_token', 'Token expired');
      return;
    }

    req.auth = {
      clientId: record.clientId,
      googleSub: record.googleSub,
      googleEmail: record.googleEmail,
      token,
    };
    next();
  };
}
