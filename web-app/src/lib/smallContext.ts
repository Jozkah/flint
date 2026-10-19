/**
 * Small-context mode: leaner defaults for a model whose window is small.
 *
 * Many local models run with 32K-50K of context, and the fixed parts of a
 * request (system prompt, skills list, memory, tool schemas) then take a real
 * share of it. In this mode a chat sends compact variants of those parts. Every
 * safety and behaviour rule stays; prose, examples and optional extras go.
 * Approvals and the sandbox are not touched. Settings > Context: Auto (on at or
 * below 64K), Always, Never.
 */
export type SmallContextMode = 'auto' | 'always' | 'never'

/** Auto turns the mode on for a window at or below this. */
export const SMALL_CONTEXT_WINDOW = 65_536

/** Characters of memory a small-context chat injects (the default is 2048). */
export const SMALL_CONTEXT_MEMORY_CHARS = 1024

/** Whether small-context mode applies to a window; an unknown one (0) only when forced. */
export function smallContextActive(
  mode: SmallContextMode | undefined,
  windowTokens: number | null | undefined
): boolean {
  if (mode === 'always') return true
  if (mode === 'never') return false
  return !!windowTokens && windowTokens > 0 && windowTokens <= SMALL_CONTEXT_WINDOW
}
