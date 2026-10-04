/** Only recognized, single-process termination calls may share a grant. */
export type SimilarToolCall = { key: string; label: string }

export function similarToolCall(toolName: string, input: unknown): SimilarToolCall | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const args = input as Record<string, unknown>
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
