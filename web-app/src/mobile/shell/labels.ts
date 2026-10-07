// The design's words for Cowork modes and access, and the thinking-budget
// levels, shared by sheets and screens.
import { t } from '../i18n'

export const COWORK_MODES = [
  { id: 'review', label: t('labels.modes.review.label'), short: t('labels.modes.review.short'), sub: t('labels.modes.review.sub') },
  { id: 'ask', label: t('labels.modes.ask.label'), short: t('labels.modes.ask.short'), sub: t('labels.modes.ask.sub') },
  { id: 'auto', label: t('labels.modes.auto.label'), short: t('labels.modes.auto.short'), sub: t('labels.modes.auto.sub') },
  { id: 'bypass', label: t('labels.modes.bypass.label'), short: t('labels.modes.bypass.short'), sub: t('labels.modes.bypass.sub') },
] as const

export const ACCESS_MODES = [
  { id: 'review-only', label: t('labels.access.reviewOnly.label'), short: t('labels.access.reviewOnly.short'), sub: t('labels.access.reviewOnly.sub') },
  { id: 'managed-worktree', label: t('labels.access.worktree.label'), short: t('labels.access.worktree.short'), sub: t('labels.access.worktree.sub') },
  { id: 'edit-folder', label: t('labels.access.editFolder.label'), short: t('labels.access.editFolder.short'), sub: t('labels.access.editFolder.sub') },
] as const

export const LEVELS = [
  [t('labels.levels.low'), '~3k'],
  [t('labels.levels.medium'), '~8k'],
  [t('labels.levels.high'), '~16k'],
  [t('labels.levels.xhigh'), '~25k'],
  [t('labels.levels.unlimited'), '∞'],
] as const

export const modeLabel = (id: string) => COWORK_MODES.find((m) => m.id === id)
export const accessLabel = (id: string) => ACCESS_MODES.find((m) => m.id === id)

export const ROOM_STATUS: Record<string, string> = {
  running: t('labels.room.running'),
  'awaiting-user': t('labels.room.awaiting'),
  paused: t('labels.room.paused'),
  stopped: t('labels.room.stopped'),
  completed: t('labels.room.completed'),
  failed: t('labels.room.failed'),
  draft: t('labels.room.draft'),
}

export const THEME_WORD = { system: t('theme.system'), light: t('theme.light'), dark: t('theme.dark') } as const
