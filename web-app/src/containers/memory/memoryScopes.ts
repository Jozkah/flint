import type { MemoryScope } from '@janhq/tauri-plugin-agent-tools-api'

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
