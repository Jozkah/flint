// The design's words for Cowork modes and access, and the thinking-budget
// levels, shared by sheets and screens.

export const COWORK_MODES = [
  { id: 'review', label: 'Review first', short: 'Review', sub: 'Reads, searches and inspects. Cannot write files or run commands.' },
  { id: 'ask', label: 'Ask before changes', short: 'Ask', sub: 'Works normally, but every change waits for you to allow it.' },
  { id: 'auto', label: 'Auto mode', short: 'Auto', sub: 'Changes files and runs commands without asking.' },
] as const

export const ACCESS_MODES = [
  { id: 'review-only', label: 'Review only', short: 'Review', sub: 'Nothing is written anywhere.' },
  { id: 'managed-worktree', label: 'Managed worktree', short: 'Worktree', sub: 'A separate branch and folder Flint manages. Your checkout is untouched.' },
  { id: 'edit-folder', label: 'Edit this folder', short: 'Edits', sub: 'Changes land directly in the attached folder.' },
] as const

export const LEVELS = [
  ['Low', '~3k'],
  ['Medium', '~8k'],
  ['High', '~16k'],
  ['XHigh', '~25k'],
  ['Unlimited', '∞'],
] as const

export const modeLabel = (id: string) => COWORK_MODES.find((m) => m.id === id)
export const accessLabel = (id: string) => ACCESS_MODES.find((m) => m.id === id)

export const ROOM_STATUS: Record<string, string> = {
  running: 'Running',
  'awaiting-user': 'Waiting for you',
  paused: 'Paused',
  stopped: 'Stopped',
  completed: 'Completed',
  failed: 'Failed',
  draft: 'Draft',
}

export const THEME_WORD = { system: 'Match phone', light: 'Light', dark: 'Dark' } as const
