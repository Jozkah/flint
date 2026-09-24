import { isPlainObject, parseToolInput } from '@/lib/toolInputSummary'

/**
 * Remembering, for the running app session only, which exact shell commands
 * the user has already answered "Allow once" for in a conversation. When the
 * same command comes back, the approval card says so and offers "Allow in this
 * conversation" first. Nothing here approves anything by itself.
 */

/** Commands remembered per conversation, newest last. */
export const MAX_REMEMBERED_COMMANDS = 100

/**
 * The same command as far as the user is concerned: surrounding whitespace
 * and line-ending style do not change what runs. Inner whitespace is kept,
 * since it can be significant inside quotes.
 */
export function normalizeCommand(command: string): string {
  return command.replace(/\r\n?/g, '\n').trim()
}

/**
 * The key identifying a `bash` call's command, or null for any other tool or
 * a call with no command text.
 */
export function repeatCommandKey(
  toolName: string,
  input: unknown
): string | null {
  if (toolName !== 'bash') return null
  const parsed = parseToolInput(input)
  if (!isPlainObject(parsed)) return null
  const command = parsed.command
  if (typeof command !== 'string') return null
  const normalized = normalizeCommand(command)
  return normalized ? `${toolName}\u0000${normalized}` : null
}

/** `list` with `key` added as the newest entry, bounded. */
export function rememberCommand(
  list: readonly string[] | undefined,
  key: string
): string[] {
  const next = (list ?? []).filter((k) => k !== key)
  next.push(key)
  return next.length > MAX_REMEMBERED_COMMANDS
    ? next.slice(next.length - MAX_REMEMBERED_COMMANDS)
    : next
}
