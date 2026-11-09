// The remote-access wire protocol: chat details, effort, assistants, code and
// preview, Hugging Face. Re-exported by protocol.ts; free of app imports.

import type { SessionKind } from './protocolTypes'

// ---------------------------------------------------------------------------
// Desktop updates #30–#87: chat details, effort, assistants, code/preview,
// Hugging Face
// ---------------------------------------------------------------------------

export type EffortLevelWire = 'low' | 'medium' | 'high' | 'xhigh'
export type EffortChoiceWire = EffortLevelWire | 'off'

/** One kind of thing in the context window (lib/contextBreakdown.ts). */
export type ContextSegmentWire = { id: string; label: string; tokens: number; color: string }

export type ContextWindowWire = {
  usedTokens: number
  windowTokens: number | null
  autoCompactOn: boolean
  /** Held back for compaction to run in. */
  buffer: number
  segments: ContextSegmentWire[]
}

/** One card of "What Flint is using" (containers/WhatJanIsUsing.tsx). */
export type UsingSection = {
  id: 'model' | 'instructions' | 'attachments' | 'memory' | 'tools' | 'payload'
  title: string
  items: { label: string; detail?: string; state: string }[]
  empty?: string
}

export type ChatDetails = {
  id: string
  model: { id: string; provider: string; name: string } | null
  /** The chat's model was removed from the computer. */
  modelMissing: boolean
  /** `auto`: still on Flint, so Jev may route each turn. */
  assistant: { id: string; name: string; auto: boolean }
  effort: {
    levels: EffortLevelWire[]
    recommended: EffortLevelWire | null
    canDisable: boolean
    value: EffortChoiceWire | null
    overridden: boolean
  } | null
  context: ContextWindowWire | null
  speed: { last: number | null; average: number | null }
  lastRequest: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } | null
  sections: UsingSection[]
  /** MCP servers the conversation mentioned that are not running. */
  serversOff: string[]
  files: { name: string; state: string }[]
  /** "Compact session" works while the chat is open on the computer. */
  canCompact: boolean
}

export type ChatEffortParams = { id: string; choice: EffortChoiceWire | null }
export type ChatAssistantParams = { id: string; assistant: string }
export type ChatForkParams = { id: string; messageId?: string }
/** Regenerate a reply (the last one when `messageId` is absent). */
export type ChatRegenerateParams = { id: string; messageId?: string }
/** Edit a message: the old version is kept beside the new one, and a
 * question gets a new reply. */
export type ChatEditParams = { id: string; messageId: string; text: string }
export type TitleRegenerateParams = { kind: SessionKind; id: string }
export type TitleRegenerateResult = { result: 'done' | 'empty' | 'busy' | 'failed' }

export type AssistantInfo = { id: string; name: string; description?: string; builtIn: boolean }
export type AssistantsResult = { assistants: AssistantInfo[]; routing: boolean }

export type RoomClearParams = { id: string; scope: 'chat' | 'knowledge' | 'everything' }

export type ProjectEntryWire = { name: string; relPath: string; isDir: boolean }
export type CoworkFilesParams = { id: string; path?: string }
export type CoworkFilesResult = { root: string | null; entries: ProjectEntryWire[]; truncated: boolean }
export type CoworkFileParams = { id: string; path: string }
export type CoworkFileResult = {
  path: string
  status: 'ready' | 'oversized' | 'binary' | 'sensitive' | 'denied' | 'missing'
  content: string
  /** Line numbers (1-based) the session added or changed. */
  changed: Record<number, 'add' | 'mod'>
  language: string
  /** Files the session wrote, for the open-file tabs. */
  touched: string[]
}
export type CoworkPreviewResult = {
  /** Previewable files the session made, newest last. */
  artifacts: string[]
  path: string | null
  kind: 'html' | 'svg' | 'markdown' | 'text' | 'image' | 'other' | null
  /** The file's text (HTML, SVG, Markdown), capped. */
  content: string | null
  note?: string
  /** The desktop shows this session's app live (a local URL); a phone can
   * view it through the server with a `preview.ticket`. */
  live?: { url: string }
}

export type HfVariant = { quant: string; sizeBytes: number | null; fits: boolean | null }
export type HfModelCard = {
  repo: string
  author: string | null
  downloads: number
  likes: number
  tags: string[]
  pipelineTag: string | null
  installed: boolean
  variants: HfVariant[]
}
export type HfSearchParams = { query?: string; modality?: 'all' | 'text' | 'vision' | 'audio' | 'code' | 'embeddings' }
export type HfSearchResult = { models: HfModelCard[]; device: { name: string; vramBytes: number } | null }
export type HfDownloadParams = { repo: string; quant?: string }
export type DownloadTaskWire = {
  id: string
  label: string
  status: string
  progress: number
  downloaded: number
  total: number | null
  bytesPerSecond: number | null
}
