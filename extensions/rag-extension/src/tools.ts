import { MCPTool, RAG_INTERNAL_SERVER } from '@janhq/core'

// Tool names
export const RETRIEVE = 'retrieve'
export const LIST_ATTACHMENTS = 'list_attachments'
export const GET_CHUNKS = 'get_chunks'

export function getRAGTools(retrievalLimit: number): MCPTool[] {
  // Coerce nullish/NaN to the default 3; a numeric-but-low value still clamps
  // to a minimum of 1 below.
  const parsedLimit = Number(retrievalLimit ?? 3)
  const safeLimit = Number.isFinite(parsedLimit) ? parsedLimit : 3
  const maxTopK = Math.max(1, safeLimit)
  // Every tool's description tells the model to pass `scope`; without it in
  // the schema, strict providers drop the argument and project files are
  // never reached.
  const scopeProp = {
    type: 'string',
    enum: ['thread', 'project'],
    default: 'thread',
    description:
      'Where to look: "thread" for files attached to this thread (default), "project" for files shared across the project.',
  }

  return [
    {
      name: LIST_ATTACHMENTS,
      description:
        'List files attached to the current thread or project. Use scope to specify: "thread" for thread-level files (default), "project" for project-level files shared across all threads in the project.',
      inputSchema: {
        type: 'object',
        properties: {
          scope: scopeProp,
          project_id: {
            type: 'string',
            description:
              'Optional: Project id when scope is "project"; defaults to the current project.',
          },
        },
        required: [],
      },
      server: RAG_INTERNAL_SERVER,
    },
    {
      name: RETRIEVE,
      description:
        'Retrieve relevant snippets from locally attached, indexed documents. Use query only; do not pass raw document content. Use scope to search: "thread" (default) for thread-level files, "project" for project-level files shared across all threads. Use file_ids to search within specific files only.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'User query to search for' },
          scope: scopeProp,
          top_k: {
            type: 'number',
            description: 'Optional: Max citations to return. Adjust as needed.',
            minimum: 1,
            maximum: maxTopK,
            default: safeLimit,
          },
          file_ids: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional: Filter search to specific file IDs from list_attachments',
          },
        },
        required: ['query'],
      },
      server: RAG_INTERNAL_SERVER,
    },
    {
      name: GET_CHUNKS,
      description:
        'Retrieve chunks from a file by their order range. For a single chunk, use start_order = end_order. Use scope to specify source: "thread" (default) for thread-level, "project" for project-level files. Use sparingly; intended for advanced usage. Prefer using retrieve instead for relevance-based fetching.',
      inputSchema: {
        type: 'object',
        properties: {
          scope: scopeProp,
          project_id: {
            type: 'string',
            description:
              'Optional: Project id when scope is "project"; defaults to the current project.',
          },
          file_id: {
            type: 'string',
            description: 'File ID from list_attachments',
          },
          start_order: {
            type: 'number',
            description: 'Start of chunk range (inclusive, 0-indexed)',
          },
          end_order: {
            type: 'number',
            description:
              'End of chunk range (inclusive, 0-indexed). For single chunk, use start_order = end_order.',
          },
        },
        required: ['file_id', 'start_order', 'end_order'],
      },
      server: RAG_INTERNAL_SERVER,
    },
  ]
}
