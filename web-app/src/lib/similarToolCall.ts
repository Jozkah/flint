/** Only recognized actions with a stable, narrow meaning may share a grant. */
export type SimilarToolCall = { key: string; label: string }

export function similarToolCallLabel(key: string): string | null {
  if (key === 'clipboard:read') return 'Read clipboard content'
  if (key === 'host_action:kill_process') return 'End one process by ID'
  if (key === 'host_powershell:stop-process-id') return 'PowerShell: Stop-Process -Id'
  if (key === 'host_powershell:stop-process-id-force') return 'PowerShell: Stop-Process -Id -Force'
  return null
}

export function similarToolCall(toolName: string, input: unknown): SimilarToolCall | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const args = input as Record<string, unknown>
  if (toolName === 'clipboard') {
    return args.action === 'read' && Object.keys(args).every((key) => key === 'action')
      ? { key: 'clipboard:read', label: 'Read clipboard content' }
      : null
  }
  if (toolName === 'host_action') {
    if (
      args.action === 'kill_process' &&
      Number.isSafeInteger(args.pid) &&
      Number(args.pid) > 0 &&
      Object.keys(args).every((key) => key === 'action' || key === 'pid')
    ) {
      return { key: 'host_action:kill_process', label: 'End one process by ID' }
    }
    return null
  }
  if (toolName !== 'host_powershell' || typeof args.script !== 'string') return null
  if (!Object.keys(args).every((key) => key === 'script' || key === 'cwd')) return null
  const script = args.script.trim()
  const match = /^Stop-Process\s+-Id\s+[1-9]\d*(\s+-Force)?$/i.exec(script)
  if (!match) return null
  return match[1]
    ? { key: 'host_powershell:stop-process-id-force', label: 'PowerShell: Stop-Process -Id -Force' }
    : { key: 'host_powershell:stop-process-id', label: 'PowerShell: Stop-Process -Id' }
}
