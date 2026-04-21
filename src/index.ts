#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createTrelloMcpServer } from './server-factory.js';

const TRELLO_API_KEY = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;

if (!TRELLO_API_KEY || !TRELLO_TOKEN) {
  process.exit(1);
}

process.on('uncaughtException', () => process.exit(1));
process.on('unhandledRejection', () => process.exit(1));

async function main() {
  const server = createTrelloMcpServer({
    apiKey: TRELLO_API_KEY!,
    token: TRELLO_TOKEN!,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(() => process.exit(1));
