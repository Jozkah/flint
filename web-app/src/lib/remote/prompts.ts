// The desktop's other blocking prompts, as one shape a phone can show and
// answer: a folder outside the workspace, a site the assistant's browser wants
// to open, team tasks that overlap, a local model out of context. Each is a
// title, what it is about, and the answers a phone may give.
//
// A phone gets the narrow answers only. Standing grants ("always", "never")
// stay on the computer, as they do for tool approvals unless the user allowed
// them from phones.
//
// Pure: `appPrompts.ts` reads the stores and applies the answers.

import { pt } from './text'
import type { RemotePrompt } from './protocol'

export type PromptAction = RemotePrompt['actions'][number]

const DENY: PromptAction = { id: 'deny', label: pt('deny'), style: 'danger' }

export function accessPrompt(req: {
  id: string
  threadId: string
  taskLabel?: string
  origin?: string
  reason: string
  prepared: { display: string; isDir: boolean; mode: 'read' | 'write' }
}): RemotePrompt {
  const title = pt(
    `${req.prepared.mode === 'write' ? 'change' : 'read'}${req.prepared.isDir ? 'Folder' : 'File'}Title`
  )
  return {
    id: `access:${req.id}`,
    kind: 'access',
    threadId: req.threadId,
    title,
    detail: req.prepared.display,
    ...(req.reason ? { body: req.reason } : {}),
    ...(req.origin ? { origin: req.origin } : {}),
    actions: [DENY, { id: 'session', label: pt('allowSession'), style: 'primary' }],
  }
}

export function domainPrompt(req: { id: string; url: string; host: string; tool: string; origin?: string }): RemotePrompt {
  return {
    id: `domain:${req.id}`,
    kind: 'domain',
    title: pt('domainTitle', { host: req.host }),
    detail: req.url,
    ...(req.origin ? { origin: req.origin } : {}),
    actions: [
      DENY,
      { id: 'session', label: pt('allowSession') },
      { id: 'once', label: pt('allowOnce'), style: 'primary' },
    ],
  }
}

export function conflictPrompt(req: {
  sessionId: string
  callId: string
  conflicts: { tasks: [string, string]; overlaps: { paths: [string, string]; note: string }[] }[]
}): RemotePrompt {
  const n = req.conflicts.length
  const lines = req.conflicts.map((c) => {
    const where = [...new Set(c.overlaps.map((o) => o.paths[0]))].slice(0, 3).join(', ')
    return pt('conflictLine', { a: c.tasks[0], b: c.tasks[1], where })
  })
  return {
    id: `conflict:${req.sessionId}:${req.callId}`,
    kind: 'conflict',
    threadId: req.sessionId,
    title: n === 1 ? pt('conflictOne') : pt('conflictMany', { n: String(n) }),
    body: pt('conflictBody'),
    detail: lines.join('\n'),
    actions: [
      { id: 'cancel', label: pt('cancelTeam'), style: 'danger' },
      { id: 'parallel', label: pt('parallel') },
      { id: 'serialize', label: pt('serialize'), style: 'primary' },
    ],
  }
}

export function contextPrompt(): RemotePrompt {
  return {
    id: 'context:current',
    kind: 'context',
    title: pt('contextTitle'),
    body: pt('contextBody'),
    actions: [
      { id: 'deny', label: pt('cancel'), style: 'danger' },
      { id: 'context_shift', label: pt('dropOld') },
      { id: 'ctx_len', label: pt('largerContext'), style: 'primary' },
    ],
  }
}

/** Whether `action` is one the prompt offers. */
export const offers = (p: RemotePrompt, action: unknown): action is string =>
  typeof action === 'string' && p.actions.some((a) => a.id === action)
