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

import type { RemotePrompt } from './protocol'

export type PromptAction = RemotePrompt['actions'][number]

const DENY: PromptAction = { id: 'deny', label: 'Deny', style: 'danger' }

export function accessPrompt(req: {
  id: string
  threadId: string
  taskLabel?: string
  origin?: string
  reason: string
  prepared: { display: string; isDir: boolean; mode: 'read' | 'write' }
}): RemotePrompt {
  const what = req.prepared.isDir ? 'a folder' : 'a file'
  const verb = req.prepared.mode === 'write' ? 'change' : 'read'
  return {
    id: `access:${req.id}`,
    kind: 'access',
    threadId: req.threadId,
    title: `Flint wants to ${verb} ${what} outside this session's folder`,
    detail: req.prepared.display,
    ...(req.reason ? { body: req.reason } : {}),
    ...(req.origin ? { origin: req.origin } : {}),
    actions: [DENY, { id: 'session', label: 'Allow for this session', style: 'primary' }],
  }
}

export function domainPrompt(req: { id: string; url: string; host: string; tool: string; origin?: string }): RemotePrompt {
  return {
    id: `domain:${req.id}`,
    kind: 'domain',
    title: `Flint's browser wants to open ${req.host}`,
    detail: req.url,
    ...(req.origin ? { origin: req.origin } : {}),
    actions: [
      DENY,
      { id: 'session', label: 'Allow for this session' },
      { id: 'once', label: 'Allow once', style: 'primary' },
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
    return `${c.tasks[0]} and ${c.tasks[1]}: ${where}`
  })
  return {
    id: `conflict:${req.sessionId}:${req.callId}`,
    kind: 'conflict',
    threadId: req.sessionId,
    title: n === 1 ? 'Two team tasks would change the same files' : `${n} pairs of team tasks would change the same files`,
    body: 'Nothing starts until you choose how they run.',
    detail: lines.join('\n'),
    actions: [
      { id: 'cancel', label: 'Cancel the team', style: 'danger' },
      { id: 'parallel', label: 'Run side by side' },
      { id: 'serialize', label: 'One after the other', style: 'primary' },
    ],
  }
}

export function contextPrompt(): RemotePrompt {
  return {
    id: 'context:current',
    kind: 'context',
    title: 'The local model ran out of context',
    body: 'Give it a larger context window, or let it drop the oldest messages and carry on.',
    actions: [
      { id: 'deny', label: 'Cancel', style: 'danger' },
      { id: 'context_shift', label: 'Drop old messages' },
      { id: 'ctx_len', label: 'Larger context', style: 'primary' },
    ],
  }
}

/** Whether `action` is one the prompt offers. */
export const offers = (p: RemotePrompt, action: unknown): action is string =>
  typeof action === 'string' && p.actions.some((a) => a.id === action)
