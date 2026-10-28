import type { MemoryRecall, MemoryScope } from '@janhq/tauri-plugin-agent-tools-api'

/**
 * The scopes, in the order a user thinks about them: this conversation first,
 * then this project, then everything. The technical names stay in the backend
 * and in diagnostics.
 */
export const TAB_SCOPES: MemoryScope[] = ['chat', 'project', 'user']

export type Translate = (
  key: string,
  options?: Record<string, unknown>
) => string

/** Where a memory applies, in the words the tabs use. */
export function scopeLabel(scope: MemoryScope, t: Translate): string {
  return TAB_SCOPES.includes(scope)
    ? t(`settings:memoryPage.scope.${scope}.tab`)
    : scope
}

export function formatWhen(
  seconds: number | null,
  t: Translate,
  language?: string
): string {
  if (!seconds) return t('settings:memoryPage.meta.never')
  return new Intl.DateTimeFormat(language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(seconds * 1000))
}

/** The recall switch a tab's scope is governed by. */
export const recallKey = (scope: MemoryScope): keyof MemoryRecall =>
  scope === 'chat' ? 'session' : scope === 'project' ? 'project' : 'user'

/** How many rows one request fetches. The backend clamps this too. */
export const PAGE_SIZE = 50

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
