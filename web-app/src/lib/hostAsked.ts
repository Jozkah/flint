/**
 * The host tools whose calls are put to the user: they change this computer,
 * run a command, or read something private. Kept apart from `agentTools.ts`
 * (which drags in the whole tool runtime) so a surface can ask the question
 * without importing it.
 */
export const HOST_ASKED = new Set([
  'host_action',
  'host_build',
  'host_powershell',
  'host_package',
  'host_wsl',
  'host_ssh',
  'clipboard',
  'computer',
  'open_path',
])

/** winget is asked about only when it changes a program; looking is free. */
export const hostCallNeedsAsking = (toolName: string, input: unknown): boolean =>
  toolName !== 'host_package' ||
  ['install', 'upgrade', 'uninstall'].includes(
    String((input as Record<string, unknown> | null)?.action)
  )

/**
 * The options a surface passes `executeAgentTool` for a host tool. The question
 * is only answerable under the call's own card when it carries that card's id;
 * without it the request is registered under a made-up id and only the header's
 * approval chip shows it, which is how a chat's `host_powershell` call waited
 * with no Allow button in sight.
 */
export function hostCallOptions(
  toolName: string,
  toolCallId: string
): { callId?: string } {
  return HOST_ASKED.has(toolName) ? { callId: toolCallId } : {}
}
