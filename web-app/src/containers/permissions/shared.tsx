// Pieces the permissions sections share. Split out of routes/settings/permissions.tsx.

import { OctagonAlert } from 'lucide-react'
import { type StatusTone } from '@/containers/StatusChip'

/** Whether a standing server grant still describes the configured server. */
export type GrantState = 'current' | 'changed' | 'missing' | 'unknown'

export type ServerRow = {
  name: string
  /** The backend gate trusts it: its tools run without a ticket. */
  inBackend: boolean
  /** The renderer store trusts it: its tools run without a prompt. */
  inApp: boolean
  state: GrantState
}

export type RenewalRow = {
  name: string
  reason: 'legacy' | 'changed'
}

/** One integrated row: what the grant is on the left, its control on the right. */
export const ROW =
  'flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-b border-dashed border-border px-0.5 py-1.5 last:border-b-0 [&>:first-child]:flex-[1_1_10rem]'
export const EMPTY = 'py-3 text-[length:calc(var(--ui-font-base)*0.8125)] text-muted-foreground'
/** Outlined destructive, never the accent fill. */
export const REVOKE = 'h-7 shrink-0 px-2.5 text-xs pointer-coarse:h-11'

export const GRANT_TONE: Record<GrantState, StatusTone> = {
  current: 'success',
  changed: 'warning',
  missing: 'neutral',
  unknown: 'neutral',
}

export function InlineError({ id, children }: { id?: string; children: string }) {
  return (
    <p
      id={id}
      role="alert"
      className="mt-2 flex items-start gap-2 rounded-md bg-destructive-tint px-3 py-2 text-xs text-destructive"
    >
      <OctagonAlert className="mt-px size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  )
}

export const errorId = (name: string) =>
  `permissions-server-error-${name.replace(/[^a-zA-Z0-9_-]/g, '_')}`
