/**
 * Scheduled tasks: the shapes the backend stores and the typed calls the
 * Schedules page makes. The Rust side (`core/schedule`) owns validation; these
 * types mirror its JSON (camelCase fields, snake_case enum values).
 */
import { invoke } from '@tauri-apps/api/core'

export type TimeOfDay = { hour: number; minute: number }

export type ScheduleSpec =
  | { kind: 'daily'; times: TimeOfDay[] }
  | { kind: 'weekdays'; times: TimeOfDay[] }
  | { kind: 'weekly'; days: number[]; times: TimeOfDay[] }
  | { kind: 'cron'; expr: string }

export type CatchUp = 'skip' | 'once' | 'all_capped'
export type OnBlock = 'continue' | 'end'
export type WriteMode = 'read_only' | 'worktree'

export type ScheduledTask = {
  id: string
  name: string
  prompt: string
  schedule: ScheduleSpec
  timezone: string
  /** `provider/model`. */
  model: string
  project: string
  profile?: string | null
  policy: { allowTools: string[]; write: WriteMode }
  budgets: {
    maxTurns: number
    maxTokens: number
    maxWallClockSecs: number
    /** Optional money ceiling in USD; needs the model's price in prices.toml. */
    maxCostUsd?: number | null
  }
  onBlock: OnBlock
  catchUp: CatchUp
  enabled: boolean
  createdAtMs?: number
  updatedAtMs?: number
}

export type RunStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'budget_stopped'
  | 'blocked'
  | 'cancelled'
  | 'skipped'

export type RunTrigger = 'manual' | 'on_time' | 'catch_up'

export type ScheduleRun = {
  version: number
  id: string
  taskId: string
  taskName: string
  trigger: RunTrigger
  scheduledFor: string
  startedAtMs: number
  endedAtMs?: number | null
  status: RunStatus
  jobId?: string | null
  /** The conversation holding the transcript. */
  sessionId?: string | null
  summary?: string | null
  spend: { turns: number; inputTokens: number; outputTokens: number }
  blockedOn: string[]
  error?: string | null
  branch?: string | null
}

export type ScheduledTaskView = {
  task: ScheduledTask
  nextFires: string[]
  lastRun?: ScheduleRun | null
  running: boolean
}

export type ScheduleTool = { name: string; capability: 'read' | 'write' | 'exec' | 'net' }

export type ScheduleEvent = {
  kind: 'started' | 'skipped' | 'ended'
  taskId: string
  taskName: string
  runId: string
  status: RunStatus
}

export const SCHEDULE_EVENT = 'schedule-event'

export const schedulesList = () => invoke<ScheduledTaskView[]>('schedules_list')

export const scheduleSave = (task: ScheduledTask) =>
  invoke<ScheduledTaskView>('schedule_save', { task })

export const scheduleDelete = (taskId: string) =>
  invoke<boolean>('schedule_delete', { taskId })

export const scheduleSetEnabled = (taskId: string, enabled: boolean) =>
  invoke<ScheduledTaskView>('schedule_set_enabled', { taskId, enabled })

export const scheduleRunNow = (taskId: string) =>
  invoke<ScheduleRun>('schedule_run_now', { taskId })

export const scheduleRuns = (taskId: string, limit?: number) =>
  invoke<ScheduleRun[]>('schedule_runs', { taskId, limit })

export const scheduleCancelRun = (taskId: string, runId: string) =>
  invoke<void>('schedule_cancel_run', { taskId, runId })

/** Next fire times for a schedule that is still being edited. */
export const schedulePreview = (
  schedule: ScheduleSpec,
  timezone: string,
  count = 5
) => invoke<string[]>('schedule_preview', { schedule, timezone, count })

export const scheduleTimeZones = () => invoke<string[]>('schedule_time_zones')

export const scheduleTools = () => invoke<ScheduleTool[]>('schedule_tools')
