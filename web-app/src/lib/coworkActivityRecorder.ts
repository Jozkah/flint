/**
 * Where the activity record is written from.
 *
 * The run driver calls these at the exact moments the facts are true: a
 * dispatch as it happens, an outcome as it lands. Keeping the writes here
 * rather than inline in the route keeps one description of what a task record
 * contains, and keeps the route readable.
 *
 * Nothing here infers. Every field comes from the dispatch that is happening or
 * the result that just arrived; a fact the run did not record is left absent.
 */

import { useCoworkActivity } from '@/hooks/useCoworkActivity'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import {
  currentPhase,
  findTaskByJob,
  taskIdFor,
  type ActivityTask,
} from '@/lib/coworkActivity'
import { backgroundJobId } from '@/lib/coworkTasks'
import { PLAN_EXECUTE_INSTRUCTION } from '@/lib/coworkPlanReview'
import { CONTINUATION_PREFIX } from '@/lib/coworkContinuity'
import {
  bashExitCode,
  bashSignalled,
  boundTail,
  redactSecrets,
} from '@/lib/redact'
import type { UIMessage } from 'ai'

/**
 * The question a run is answering, for the workflow's title.
 *
 * A turn taken again carries no new text — the question is the last one in the
 * history — so this reads it back rather than leaving the workflow unnamed.
 */
export function lastUserQuestion(
  messages: UIMessage[] | undefined
): string | undefined {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const message = messages![i]
    if (message.role !== 'user') continue
    // A request Flint wrote itself (the result card's Continue).
    if ((message.metadata as { hidden?: boolean } | undefined)?.hidden) continue
    const text = message.parts
      ?.map((part) => (part.type === 'text' ? part.text : ''))
      .join('')
      .trim()
    if (text && !isAppInstruction(text)) return text
  }
  return undefined
}

/**
 * Whether a turn's text is an instruction the app sent on the user's behalf
 * (carry out the approved plan, go ahead with the accepted proposal) rather
 * than something the user wrote. Never a title: "The user approved the plan.
 * Carry it out now, st..." names nothing.
 */
export function isAppInstruction(text: string): boolean {
  const trimmed = text.trim()
  return (
    trimmed === PLAN_EXECUTE_INSTRUCTION || trimmed.startsWith(CONTINUATION_PREFIX)
  )
}

/**
 * The title of a run's workflow: the turn's own text when the user wrote it,
 * else the question the user last asked -- which, for a run the app started to
 * carry out an approved plan, is the request the plan answers.
 */
export function runTitle(
  text: string | null | undefined,
  messages: UIMessage[] | undefined
): string | undefined {
  if (text && !isAppInstruction(text)) return text
  return lastUserQuestion(messages)
}

/** Identifies the run a dispatch belongs to. */
export type RunContext = {
  sessionId: string
  /** The run id, which is also the workflow id. */
  runId: string
  /** What the user asked for on the turn that started this run. */
  title: string
  /** The model the parent run is using. */
  model?: string
}

/**
 * Make sure the run has a workflow record, and return the phase a dispatch
 * happening now belongs to.
 *
 * The workflow is created by the first dispatch, not by the run starting: a
 * run that never dispatches background work has no background activity, and a
 * card for it in the conversation would be noise.
 */
function openWorkflow(
  run: RunContext,
  anchorMessageId?: string
): string | undefined {
  const activity = useCoworkActivity.getState()
  activity.beginWorkflow({
    id: run.runId,
    sessionId: run.sessionId,
    title: run.title,
    startedAt: Date.now(),
    phases: [],
    anchorMessageId,
    model: run.model,
  })
  const phase = currentPhase(
    useCoworkSessions.getState().sessions.find((s) => s.id === run.sessionId)
      ?.todos
  )
  return phase ? activity.notePhase(run.runId, phase) : undefined
}

/** Record a subagent the `task` tool has just dispatched. */
export function recordAgentDispatch(
  run: RunContext,
  task: {
    /** The dispatching tool call id. Also the task id. */
    callId: string
    agentName: string
    description?: string
    /** The model this child will run on, which may not be the parent's. */
    model?: string
    parentTaskId?: string
    anchorMessageId?: string
  }
): void {
  const phaseId = openWorkflow(run, task.anchorMessageId)
  const record: ActivityTask = {
    id: taskIdFor(run.sessionId, run.runId, task.callId),
    callId: task.callId,
    sessionId: run.sessionId,
    workflowId: run.runId,
    phaseId,
    parentTaskId: task.parentTaskId,
    kind: 'agent',
    title: task.agentName,
    agentName: task.agentName,
    description: task.description,
    model: task.model,
    // Dispatched, not yet started: the child waits for a concurrency slot, and
    // `queued` is what the run actually reports next.
    status: 'queued',
    startedAt: Date.now(),
  }
  useCoworkActivity.getState().beginTask(record)
}

/** Record a shell command the `bash` tool has just started. */
export function recordShellDispatch(
  run: RunContext,
  task: { callId: string; command: string; anchorMessageId?: string }
): void {
  const phaseId = openWorkflow(run, task.anchorMessageId)
  // The command line is shown and persisted: redacted once, here.
  const command = redactSecrets(task.command)
  useCoworkActivity.getState().beginTask({
    id: taskIdFor(run.sessionId, run.runId, task.callId),
    callId: task.callId,
    sessionId: run.sessionId,
    workflowId: run.runId,
    phaseId,
    kind: 'shell',
    title: command,
    command,
    status: 'running',
    startedAt: Date.now(),
  })
}

/**
 * Settle a shell command from the outcome its tool call produced.
 *
 * A command that outran its timeout is *not* finished: the tool returned a job
 * id and the shell is still going. That is recorded as still running, with the
 * job id that makes it killable, rather than as a command that completed.
 */
export function recordShellOutcome(
  run: RunContext,
  callId: string,
  outcome: { output: string; isError?: boolean }
): void {
  const jobId = backgroundJobId(outcome.output)
  useCoworkActivity.getState().patchTask(
    taskIdFor(run.sessionId, run.runId, callId),
    jobId
      ? { jobId, status: 'running' }
      : { ...settledShell(outcome), endedAt: Date.now() }
  )
}

/** Settle the command a collecting `bash {"job_id": ...}` call just waited on. */
export function recordJobCollected(
  sessionId: string,
  jobId: string,
  outcome: { output: string; isError?: boolean }
): void {
  const state = useCoworkActivity.getState()
  // Found by job id within this session only: the backend confines a job to
  // the conversation that started it, and so does the record. The collecting
  // call may be in a later run than the one that started the command.
  const task = findTaskByJob(state, jobId, sessionId)
  if (!task) return
  state.patchTask(task.id, {
    ...settledShell(outcome),
    endedAt: Date.now(),
  })
}

/** Output kept on a shell task: its tail, which is where it says how it ended. */
export const MAX_KEPT_OUTPUT_CHARS = 64 * 1024
export const MAX_KEPT_OUTPUT_LINES = 2000

/**
 * What a finished shell command's row records: how it ended, and its output
 * redacted and bounded before it is stored. The record is persisted, so a
 * credential a command printed must never reach it.
 */
function settledShell(outcome: {
  output: string
  isError?: boolean
}): Partial<ActivityTask> {
  const exitCode = bashExitCode(outcome.output)
  const signalled = bashSignalled(outcome.output) || undefined
  const failed =
    outcome.isError || (exitCode != null && exitCode !== 0) || !!signalled
  const kept = boundTail(
    redactSecrets(outcome.output),
    MAX_KEPT_OUTPUT_CHARS,
    MAX_KEPT_OUTPUT_LINES
  )
  return {
    status: failed ? 'error' : 'done',
    output: kept.text,
    outputTruncated: kept.truncated || undefined,
    exitCode,
    signalled,
  }
}
