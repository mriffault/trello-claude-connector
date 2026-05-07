import { readFile } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { TrelloClient } from '../trello/client.js';
import {
  validateAddAttachmentUrl,
  validateAddAttachmentFile,
  validateGetAttachment,
  validateDeleteAttachment,
  formatValidationError
} from '../utils/validation.js';

const TRELLO_CARD_LINK_PATTERN = /^https?:\/\/trello\.com\/c\/[a-zA-Z0-9]+/;

function classifyAttachment(att: { url?: string; isUpload?: boolean; mimeType?: string }) {
  if (att.isUpload) return 'file';
  if (att.url && TRELLO_CARD_LINK_PATTERN.test(att.url)) return 'trello-card-link';
  if (att.url) return 'url';
  return 'unknown';
}

function formatAttachment(att: any) {
  return {
    id: att.id,
    name: att.name,
    url: att.url,
    mimeType: att.mimeType || null,
    bytes: att.bytes ?? null,
    date: att.date,
    isUpload: att.isUpload,
    type: classifyAttachment(att),
    edgeColor: att.edgeColor ?? null,
    idMember: att.idMember ?? null,
    pos: att.pos,
    previews: Array.isArray(att.previews)
      ? att.previews.map((p: any) => ({
          id: p.id,
          width: p.width,
          height: p.height,
          url: p.url,
          bytes: p.bytes
        }))
      : []
  };
}

export const trelloAddAttachmentUrlTool: Tool = {
  name: 'trello_add_attachment_url',
  description:
    'Attach a hyperlink (URL) to a Trello card with an optional display label. Use this for: ' +
    '(1) standard hyperlinks to external resources, with a custom "name" acting as the link label; ' +
    '(2) cross-card Trello links — pass a Trello card URL such as "https://trello.com/c/<shortLink>" as `url` and Trello renders it as a linked card. ' +
    'There is no separate Trello-internal link type: card-to-card linking is just an attachment whose URL points to another Trello card.',
  inputSchema: {
    type: 'object',
    properties: {
      apiKey: {
        type: 'string',
        description: 'Trello API key (automatically provided by Claude.app from your stored credentials)'
      },
      token: {
        type: 'string',
        description: 'Trello API token (automatically provided by Claude.app from your stored credentials)'
      },
      cardId: {
        type: 'string',
        description: 'ID of the card that will receive the attachment',
        pattern: '^[a-f0-9]{24}$'
      },
      url: {
        type: 'string',
        format: 'uri',
        description:
          'The URL to attach. Use a Trello card URL (https://trello.com/c/<shortLink>) to create a card-to-card link.'
      },
      name: {
        type: 'string',
        description:
          'Optional display label shown on the card for this attachment. If omitted, Trello shows the raw URL.'
      },
      mimeType: {
        type: 'string',
        description: 'Optional MIME type hint (e.g., "application/pdf"). Rarely needed for plain URL links.'
      },
      setCover: {
        type: 'boolean',
        description: 'If true, use this attachment as the card cover (only meaningful for image URLs).',
        default: false
      }
    },
    required: ['apiKey', 'token', 'cardId', 'url']
  }
};

export async function handleTrelloAddAttachmentUrl(args: unknown) {
  try {
    const { apiKey, token, cardId, url, name, mimeType, setCover } =
      validateAddAttachmentUrl(args);

    const client = new TrelloClient({ apiKey, token });
    const payload: { url: string; name?: string; mimeType?: string; setCover?: boolean } = { url };
    if (name !== undefined) payload.name = name;
    if (mimeType !== undefined) payload.mimeType = mimeType;
    if (setCover !== undefined) payload.setCover = setCover;

    const response = await client.createCardAttachmentUrl(cardId, payload);
    const attachment = formatAttachment(response.data);

    const result = {
      summary:
        attachment.type === 'trello-card-link'
          ? `Linked Trello card "${attachment.name || attachment.url}" on card ${cardId}`
          : `Attached URL "${attachment.name || attachment.url}" to card ${cardId}`,
      cardId,
      attachment,
      rateLimit: response.rateLimit
    };

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }]
    };
  } catch (error) {
    const errorMessage =
      error instanceof z.ZodError
        ? formatValidationError(error)
        : error instanceof Error
          ? error.message
          : 'Unknown error occurred';

    return {
      content: [{ type: 'text' as const, text: `Error adding URL attachment: ${errorMessage}` }],
      isError: true
    };
  }
}

export const trelloAddAttachmentFileTool: Tool = {
  name: 'trello_add_attachment_file',
  description:
    'Upload a local file as an attachment on a Trello card. The file is read from the local filesystem ' +
    'and posted to Trello as multipart/form-data. Free workspaces are capped at 10 MB per file; paid plans up to 250 MB.',
  inputSchema: {
    type: 'object',
    properties: {
      apiKey: {
        type: 'string',
        description: 'Trello API key (automatically provided by Claude.app from your stored credentials)'
      },
      token: {
        type: 'string',
        description: 'Trello API token (automatically provided by Claude.app from your stored credentials)'
      },
      cardId: {
        type: 'string',
        description: 'ID of the card that will receive the file',
        pattern: '^[a-f0-9]{24}$'
      },
      filePath: {
        type: 'string',
        description:
          'Absolute filesystem path to the file to upload. Must be readable by the MCP server process.'
      },
      name: {
        type: 'string',
        description:
          'Optional display label for the attachment. Defaults to the file basename if omitted.'
      },
      mimeType: {
        type: 'string',
        description:
          'Optional MIME type override (e.g., "application/pdf", "image/png"). Defaults to "application/octet-stream".'
      },
      setCover: {
        type: 'boolean',
        description: 'If true, use this image attachment as the card cover.',
        default: false
      }
    },
    required: ['apiKey', 'token', 'cardId', 'filePath']
  }
};

export async function handleTrelloAddAttachmentFile(args: unknown) {
  try {
    const { apiKey, token, cardId, filePath, name, mimeType, setCover } =
      validateAddAttachmentFile(args);

    if (!isAbsolute(filePath)) {
      throw new Error(`filePath must be an absolute path, got: ${filePath}`);
    }

    let fileBuffer: Buffer;
    try {
      fileBuffer = await readFile(filePath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Cannot read file at ${filePath}: ${msg}`);
    }

    const filename = name || basename(filePath);
    const client = new TrelloClient({ apiKey, token });

    const payload: {
      file: Buffer;
      filename: string;
      mimeType?: string;
      name?: string;
      setCover?: boolean;
    } = {
      file: fileBuffer,
      filename
    };
    if (mimeType !== undefined) payload.mimeType = mimeType;
    if (name !== undefined) payload.name = name;
    if (setCover !== undefined) payload.setCover = setCover;

    const response = await client.createCardAttachmentFile(cardId, payload);
    const attachment = formatAttachment(response.data);

    const result = {
      summary: `Uploaded "${attachment.name}" (${attachment.bytes ?? '?'} bytes) to card ${cardId}`,
      cardId,
      sourcePath: filePath,
      attachment,
      rateLimit: response.rateLimit
    };

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }]
    };
  } catch (error) {
    const errorMessage =
      error instanceof z.ZodError
        ? formatValidationError(error)
        : error instanceof Error
          ? error.message
          : 'Unknown error occurred';

    return {
      content: [{ type: 'text' as const, text: `Error uploading file attachment: ${errorMessage}` }],
      isError: true
    };
  }
}

export const trelloGetAttachmentTool: Tool = {
  name: 'trello_get_attachment',
  description:
    'Get a single attachment on a Trello card by its ID. Use trello_get_card_attachments to list all attachments first.',
  inputSchema: {
    type: 'object',
    properties: {
      apiKey: {
        type: 'string',
        description: 'Trello API key (automatically provided by Claude.app from your stored credentials)'
      },
      token: {
        type: 'string',
        description: 'Trello API token (automatically provided by Claude.app from your stored credentials)'
      },
      cardId: {
        type: 'string',
        description: 'ID of the card that owns the attachment',
        pattern: '^[a-f0-9]{24}$'
      },
      attachmentId: {
        type: 'string',
        description: 'ID of the attachment to retrieve',
        pattern: '^[a-f0-9]{24}$'
      },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional subset of attachment fields to return (e.g. ["id","name","url","mimeType","bytes","isUpload","date","previews"]).'
      }
    },
    required: ['apiKey', 'token', 'cardId', 'attachmentId']
  }
};

export async function handleTrelloGetAttachment(args: unknown) {
  try {
    const { apiKey, token, cardId, attachmentId, fields } = validateGetAttachment(args);
    const client = new TrelloClient({ apiKey, token });

    const response = await client.getCardAttachment(cardId, attachmentId, {
      ...(fields && { fields })
    });

    const attachment = formatAttachment(response.data);
    const result = {
      summary: `Attachment ${attachmentId} on card ${cardId}`,
      cardId,
      attachment,
      rateLimit: response.rateLimit
    };

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }]
    };
  } catch (error) {
    const errorMessage =
      error instanceof z.ZodError
        ? formatValidationError(error)
        : error instanceof Error
          ? error.message
          : 'Unknown error occurred';

    return {
      content: [{ type: 'text' as const, text: `Error getting attachment: ${errorMessage}` }],
      isError: true
    };
  }
}

export const trelloDeleteAttachmentTool: Tool = {
  name: 'trello_delete_attachment',
  description:
    'Delete an attachment from a Trello card. Trello has no PUT/PATCH on attachments, so renaming or ' +
    'changing an attachment requires deleting and re-creating it. Note: this endpoint is not accessible ' +
    'via OAuth2/Forge tokens.',
  inputSchema: {
    type: 'object',
    properties: {
      apiKey: {
        type: 'string',
        description: 'Trello API key (automatically provided by Claude.app from your stored credentials)'
      },
      token: {
        type: 'string',
        description: 'Trello API token (automatically provided by Claude.app from your stored credentials)'
      },
      cardId: {
        type: 'string',
        description: 'ID of the card that owns the attachment',
        pattern: '^[a-f0-9]{24}$'
      },
      attachmentId: {
        type: 'string',
        description: 'ID of the attachment to delete',
        pattern: '^[a-f0-9]{24}$'
      }
    },
    required: ['apiKey', 'token', 'cardId', 'attachmentId']
  }
};

export async function handleTrelloDeleteAttachment(args: unknown) {
  try {
    const { apiKey, token, cardId, attachmentId } = validateDeleteAttachment(args);
    const client = new TrelloClient({ apiKey, token });

    const response = await client.deleteCardAttachment(cardId, attachmentId);

    const result = {
      summary: `Deleted attachment ${attachmentId} from card ${cardId}`,
      cardId,
      attachmentId,
      rateLimit: response.rateLimit
    };

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }]
    };
  } catch (error) {
    const errorMessage =
      error instanceof z.ZodError
        ? formatValidationError(error)
        : error instanceof Error
          ? error.message
          : 'Unknown error occurred';

    return {
      content: [{ type: 'text' as const, text: `Error deleting attachment: ${errorMessage}` }],
      isError: true
    };
  }
}
