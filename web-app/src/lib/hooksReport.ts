import { invokeCommand } from '@/lib/backend'
/**
 * Read-only view of a project's hooks (`agent_hooks_report`). Nothing is run;
 * the backend reports what `hooks.toml` declares and whether the folder is
 * trusted, which decides whether any of it would run.
 */

export type HookInfo = {
  event: string
  command: string
  onFailure: string
  timeoutSecs: number
  tools: string[]
  stdinJson: boolean
  if?: string | null
  jsonOutput: boolean
}

export type HooksReport = {
  source: string
  exists: boolean
  trusted: boolean
  error: string | null
  hooks: HookInfo[]
  declared: number
}

export async function hooksReport(
  folder: string,
  call: (cmd: string, args: { folder: string }) => Promise<unknown> = (
    cmd,
    args
  ) => invokeCommand(cmd, args)
): Promise<HooksReport | null> {
  const report = (await call('agent_hooks_report', { folder })) as HooksReport
  return report && Array.isArray(report.hooks) ? report : null
}
