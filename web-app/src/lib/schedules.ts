/**
 * Scheduled tasks: the shapes the backend stores and the typed calls the
 * Schedules page makes. The Rust side (`core/schedule`) owns validation; these
 * types mirror its JSON (camelCase fields, snake_case enum values).
 */
import { invokeCommand as invoke } from '@/lib/backend'

export type TimeOfDay = { hour: number; minute: number }

export type ScheduleSpec =
  | { kind: 'daily'; times: TimeOfDay[] }
  | { kind: 'weekdays'; times: TimeOfDay[] }
  | { kind: 'weekly'; days: number[]; times: TimeOfDay[] }
  | { kind: 'cron'; expr: string }
  /** One run, at this local date and time (`YYYY-MM-DDTHH:MM`). */
  | { kind: 'once'; at: string }
  /** Never on a timetable: an inbound HTTP request starts it. */
  | { kind: 'webhook' }

export type CatchUp = 'skip' | 'once' | 'all_capped'
export type OnBlock = 'continue' | 'end'
export type WriteMode = 'read_only' | 'worktree'

export type WebhookEncoding = 'hex' | 'base64'
export type WebhookFilterOp = 'equals' | 'not_equals' | 'one_of' | 'contains'

/**
 * How the sender signs a body. The secret is write-only: the backend never
 * sends it back, `hasSecret` says one is stored, and an empty `secret` on save
 * keeps it.
 */
export type WebhookSignature = {
  header: string
  secret?: string
  encoding: WebhookEncoding
  prefix: string
  hasSecret?: boolean
}

export type WebhookFilter = { path: string; op: WebhookFilterOp; value: string }

export type WebhookConfig = {
  /** The secret half of the URL; empty for a task not saved yet. */
  token: string
  signature?: WebhookSignature | null
  filters: WebhookFilter[]
}

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
  /** Settings of an `on webhook` schedule. */
  webhook?: WebhookConfig | null
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

export type RunTrigger = 'manual' | 'on_time' | 'catch_up' | 'webhook'

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

/** Replace a webhook task's URL token; the old URL stops working at once. */
export const scheduleRotateWebhook = (taskId: string) =>
  invoke<ScheduledTaskView>('schedule_rotate_webhook', { taskId })

/** The path a sender calls (no host: the server's address is the sender's to know). */
export const webhookPath = (taskId: string, token: string) => `/hooks/${taskId}/${token}`

export const scheduleRuns = (taskId: string, limit?: number) =>
  invoke<ScheduleRun[]>('schedule_runs', { taskId, limit })

export const scheduleCancelRun = (taskId: string, runId: string) =>
  invoke<void>('schedule_cancel_run', { taskId, runId })

/**
 * Next fire times for a schedule that is still being edited. `neverFires` is
 * set for a valid schedule with no future fire time (31 February); a schedule
 * the backend would refuse rejects with the reason.
 */
export type SchedulePreview = { fires: string[]; neverFires: boolean }

export const schedulePreview = (
  schedule: ScheduleSpec,
  timezone: string,
  count = 5
) => invoke<SchedulePreview>('schedule_preview', { schedule, timezone, count })

export const scheduleTimeZones = () => invoke<string[]>('schedule_time_zones')

export const scheduleTools = () => invoke<ScheduleTool[]>('schedule_tools')

/** The OS-scheduler entry that runs due tasks while the app is closed. */
export type OsSchedulerStatus = {
  platform: 'windows' | 'mac_os' | 'linux'
  platformLabel: string
  installed: boolean
  intervalMinutes: number
  /** What installing writes and runs, one line each. */
  preview: string[]
  /** The line the OS scheduler executes each time. */
  tickCommand: string
  /** Why the last attempt did not work, if it did not. */
  detail?: string | null
}

export const scheduleOsStatus = () => invoke<OsSchedulerStatus>('schedule_os_status', {})

export const scheduleOsEnable = () => invoke<OsSchedulerStatus>('schedule_os_enable', {})

export const scheduleOsDisable = () => invoke<OsSchedulerStatus>('schedule_os_disable', {})
