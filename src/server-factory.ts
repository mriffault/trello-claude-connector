import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  InitializeRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  listBoardsTool,
  getBoardDetailsTool,
  getListsTool,
  handleListBoards,
  handleGetBoardDetails,
  handleGetLists,
} from './tools/boards.js';

import {
  createCardTool,
  updateCardTool,
  moveCardTool,
  getCardTool,
  handleCreateCard,
  handleUpdateCard,
  handleMoveCard,
  handleGetCard,
} from './tools/cards.js';

import {
  trelloSearchTool,
  handleTrelloSearch,
} from './tools/search.js';

import {
  trelloGetListCardsTool,
  handleTrelloGetListCards,
  trelloCreateListTool,
  handleTrelloCreateList,
  trelloAddCommentTool,
  handleTrelloAddComment,
} from './tools/lists.js';

import {
  trelloGetUserBoardsTool,
  handleTrelloGetUserBoards,
  trelloGetMemberTool,
  handleTrelloGetMember,
} from './tools/members.js';

import {
  trelloGetBoardCardsTool,
  handleTrelloGetBoardCards,
  trelloGetCardActionsTool,
  handleTrelloGetCardActions,
  trelloGetCardAttachmentsTool,
  handleTrelloGetCardAttachments,
  trelloGetCardChecklistsTool,
  handleTrelloGetCardChecklists,
  trelloGetBoardMembersTool,
  handleTrelloGetBoardMembers,
  trelloGetBoardLabelsTool,
  handleTrelloGetBoardLabels,
} from './tools/advanced.js';

export interface TrelloCredentials {
  apiKey: string;
  token: string;
}

const SERVER_INFO = {
  name: 'trello-mcp',
  version: '1.0.0',
} as const;

const PROTOCOL_VERSION = '2024-11-05';

export function createTrelloMcpServer(credentials: TrelloCredentials): Server {
  const server = new Server(
    { ...SERVER_INFO },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    },
  );

  server.setRequestHandler(InitializeRequestSchema, async () => ({
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
    serverInfo: { ...SERVER_INFO },
  }));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      trelloSearchTool,
      trelloGetUserBoardsTool,
      getBoardDetailsTool,
      getCardTool,
      createCardTool,
      updateCardTool,
      moveCardTool,
      trelloAddCommentTool,
      trelloGetListCardsTool,
      trelloCreateListTool,
      listBoardsTool,
      getListsTool,
      trelloGetMemberTool,
      trelloGetBoardCardsTool,
      trelloGetCardActionsTool,
      trelloGetCardAttachmentsTool,
      trelloGetCardChecklistsTool,
      trelloGetBoardMembersTool,
      trelloGetBoardLabelsTool,
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const argsWithCredentials = {
      ...args,
      apiKey: credentials.apiKey,
      token: credentials.token,
    };

    switch (name) {
      case 'trello_search':
        return handleTrelloSearch(argsWithCredentials);
      case 'trello_get_user_boards':
        return handleTrelloGetUserBoards(argsWithCredentials);
      case 'get_board_details':
        return handleGetBoardDetails(argsWithCredentials);
      case 'get_card':
        return handleGetCard(argsWithCredentials);
      case 'create_card':
        return handleCreateCard(argsWithCredentials);
      case 'update_card':
        return handleUpdateCard(argsWithCredentials);
      case 'move_card':
        return handleMoveCard(argsWithCredentials);
      case 'trello_add_comment':
        return handleTrelloAddComment(argsWithCredentials);
      case 'trello_get_list_cards':
        return handleTrelloGetListCards(argsWithCredentials);
      case 'trello_create_list':
        return handleTrelloCreateList(argsWithCredentials);
      case 'list_boards':
        return handleListBoards(argsWithCredentials);
      case 'get_lists':
        return handleGetLists(argsWithCredentials);
      case 'trello_get_member':
        return handleTrelloGetMember(argsWithCredentials);
      case 'trello_get_board_cards':
        return handleTrelloGetBoardCards(argsWithCredentials);
      case 'trello_get_card_actions':
        return handleTrelloGetCardActions(argsWithCredentials);
      case 'trello_get_card_attachments':
        return handleTrelloGetCardAttachments(argsWithCredentials);
      case 'trello_get_card_checklists':
        return handleTrelloGetCardChecklists(argsWithCredentials);
      case 'trello_get_board_members':
        return handleTrelloGetBoardMembers(argsWithCredentials);
      case 'trello_get_board_labels':
        return handleTrelloGetBoardLabels(argsWithCredentials);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));

  return server;
}
