/**
 * The agent tools the backend adds for cross-session messaging
 * (docs/SESSION_MESSAGING.md). Session scope only: advertised to Cowork runs,
 * never to chat threads, never to subagents.
 *
 * Kept in a dependency-free module so the tool-list code can import the names
 * without pulling in the mailbox client.
 */
export const SESSION_MESSAGING_TOOL_NAMES = [
  'list_sessions',
  'send_message',
  'read_messages',
  'wait_for_reply',
] as const

export const SESSION_MESSAGING_TOOLS: ReadonlySet<string> = new Set(
  SESSION_MESSAGING_TOOL_NAMES
)
