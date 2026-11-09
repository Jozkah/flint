// Reading and checking a phone's request parameters, shared by the RPC
// handler groups.

import type { PlannedAttachments } from './attachments'
import { RemoteRpcError } from './bridge'
import type { CoworkAccessId, CoworkModeId, ModelRef, ReasoningMode } from './protocol'

export const MAX_TEXT = 100_000

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

export function textOf(p: Record<string, unknown>, allowEmpty = false): string {
  const text = typeof p.text === 'string' ? p.text.trim() : ''
  if (!text && allowEmpty) return ''
  if (!text) throw new RemoteRpcError('bad_params', 'The message is empty')
  if (text.length > MAX_TEXT) throw new RemoteRpcError('bad_params', 'The message is too long')
  return text
}

export const NO_ATTACHMENTS: PlannedAttachments = { files: [], docs: [], rejected: [] }

/** Upload ids named by a send: at most ten, each a hex id. */
export function uploadIdsOf(p: Record<string, unknown>): string[] {
  const raw = p.attachments
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > 10 || !raw.every((x) => typeof x === 'string' && /^[0-9a-f]{32}$/.test(x))) {
    throw new RemoteRpcError('bad_params', 'attachments must be up to 10 upload ids')
  }
  return raw as string[]
}

export function clientIdOf(p: Record<string, unknown>): string {
  const id = p.clientId
  if (typeof id !== 'string' || !/^[\w.:-]{6,80}$/.test(id)) {
    throw new RemoteRpcError('bad_params', 'clientId is required')
  }
  return id
}

export function modelOf(v: unknown): ModelRef | undefined {
  if (!isRecord(v)) return undefined
  const id = str(v.id)
  const provider = str(v.provider)
  return id && provider ? { id, provider } : undefined
}

export const REASONING: readonly ReasoningMode[] = ['auto', 'on', 'off']
export const MODES: readonly CoworkModeId[] = ['review', 'ask', 'auto', 'bypass']
export const ACCESS: readonly CoworkAccessId[] = ['review-only', 'managed-worktree', 'edit-folder']

export const desktopOnly = (what: string) =>
  new RemoteRpcError('desktop_only', `${what} is done on the computer`)

export const WIRE_DECISION = {
  once: 'allow-once',
  thread: 'allow-thread',
  always: 'allow-always',
  temporary: 'allow-git-temporary',
} as const
