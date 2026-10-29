import { toast } from 'sonner'
import { useCoworkActivity } from '@/hooks/useCoworkActivity'
import { useCoworkWorktrees } from '@/hooks/useCoworkWorktrees'
import { useDirectEditGrants } from '@/hooks/useDirectEditGrants'
import { useTeamConflictRequests } from '@/hooks/useTeamConflictRequests'
import { useTeamControls } from '@/hooks/useTeamControls'
import { taskIdFor } from '@/lib/coworkActivity'
import { recordAgentDispatch, type RunContext } from '@/lib/coworkActivityRecorder'
import type { ChildRunner } from '@/lib/coworkChildRunner'
import {
  hasSubagent,
  registerSubagent,
  unregisterSubagent,
  type ToolOutcome,
} from '@/lib/coworkRunner'
import {
  applyDecision,
  conflictKey,
  parseTeamRequest,
  refuseGraph,
  refuseUnresolved,
  renderTeamReport,
  renderNotRetried,
  runTeam,
  scopeConflicts,
  teamProgress,
  TEAM_DEFAULT_PROMPT,
  type TaskResult,
  type TeamState,
  type TeamTask,
} from '@/lib/coworkTeam'
import {
  COWORK_DECISION_WINDOW_MS,
  TeamControl,
  awaitingDecision,
} from '@/lib/coworkTeamControl'
import {
  describeDestinations,
  planDestinations,
} from '@/lib/coworkTeamDestinations'
import { runTyped, schemaInstruction } from '@/lib/coworkWorkflowSchema'
import {
  beginTeamChild,
  settleTeamChild,
  useTeamChildrenVersion,
  type ParallelOverride,
} from '@/lib/teamChildren'
import { wrapLoops } from '@/lib/workflowLoops'
import { openRunLog, withRunLog } from '@/lib/workflowRuns'

/** What a run's `team` tool reads, named rather than closed over. */
export type TeamToolContext = {
  sid: string
  runId: string
  run: RunContext
  /** The turn's signal: stopping the run stops the team. */
  signal: AbortSignal
  /** The session's folder when the run started. */
  folder: string | null | undefined
  modelId: string
  canIsolate: boolean
  dataFolder: () => Promise<string | undefined>
  anchorMessageId: () => string | undefined
  dispatchChild: ChildRunner
}

/**
 * The dispatcher's `onTeam` for a main run: scope conflicts go to the user,
 * isolated tasks get their checkouts, and the team runs under the turn's
 * signal with its own record in the Tasks panel.
 */
export function createTeamTool(ctx: TeamToolContext) {
  const { sid, runId, run } = ctx
  return async (callId: string, input: unknown): Promise<ToolOutcome> => {
    const parsed = parseTeamRequest(input)
    if (typeof parsed === 'string') {
      return { output: `ERROR: ${parsed}`, isError: true }
    }
    let tasks: TeamTask[] = parsed
    // Refused here rather than inside `runTeam`, so a graph that
    // cannot run never causes a worktree to be created for it.
    const badGraph = refuseGraph(tasks)
    if (badGraph) {
      return { output: `ERROR: ${badGraph}`, isError: true }
    }
    // AH-109: tasks whose declared changes overlap go to the
    // person before anything is provisioned or dispatched. Each
    // answer is applied and the graph is looked at again, so a
    // revised scope that still overlaps is asked about too.
    const allowParallel = new Set<string>()
    const overrides: ParallelOverride[] = []
    const decided: string[] = []
    for (let round = 0; ; round += 1) {
      const open = scopeConflicts(tasks).filter(
        (c) => !allowParallel.has(conflictKey(c))
      )
      if (open.length === 0) break
      if (round >= 6) {
        return {
          output: `ERROR: ${refuseUnresolved(tasks, allowParallel)}`,
          isError: true,
        }
      }
      const answer = await useTeamConflictRequests
        .getState()
        .request(sid, callId, tasks, open, ctx.signal)
      if (answer.kind === 'cancel') {
        return {
          output:
            'ERROR: the user chose not to run these tasks, because ' +
            `they would change the same paths: ${open
              .map((c) => `${c.tasks.join(' and ')} on ${c.overlaps.map((o) => o.paths[0]).join(', ')}`)
              .join('; ')}. Nothing ran.`,
          isError: true,
        }
      }
      for (const c of open) {
        const d = answer.decisions[conflictKey(c)]
        if (!d) continue
        const where = c.overlaps.map((o) => o.paths[0]).join(', ')
        if (d.kind === 'parallel') {
          allowParallel.add(conflictKey(c))
          overrides.push({
            tasks: [...c.tasks],
            paths: c.overlaps.map((o) => o.paths[0]),
            decidedAt: new Date().toISOString(),
          })
          decided.push(
            `${c.tasks.join(' and ')} ran side by side at the user's decision despite both changing ${where}`
          )
        } else if (d.kind === 'serialize') {
          decided.push(
            `${d.then} ran after ${d.first}, at the user's decision, because both change ${where}`
          )
        } else {
          decided.push(
            `the user limited ${d.task} to: ${d.writes.join(', ') || 'nothing'}`
          )
        }
        tasks = applyDecision(tasks, d)
      }
      const revised = refuseGraph(tasks)
      if (revised) {
        return { output: `ERROR: ${revised}`, isError: true }
      }
    }
    // Every isolated task gets its checkout before any child
    // starts. A team that could only isolate some of its tasks is
    // refused whole: the alternative is children silently writing
    // the folder the request asked them to stay out of.
    const plan = await planDestinations(tasks, {
      parentSessionId: sid,
      project: ctx.folder ?? null,
      // Only asked for when something actually isolates: a team
      // that wants nothing of its own should not depend on this
      // answering at all.
      dataFolder: tasks.some((one) => one.isolate)
        ? ((await ctx.dataFolder().catch(() => '')) ?? '')
        : '',
      canIsolate: ctx.canIsolate,
      ensure: (owner, project, dataFolder) =>
        useCoworkWorktrees
          .getState()
          .ensure(owner, project, dataFolder),
      authorize: (owner, folderPath, dataFolder) =>
        useDirectEditGrants
          .getState()
          .authorize(owner, folderPath, dataFolder),
      revoke: (owner) => {
        useCoworkWorktrees.getState().forget(owner)
        return useDirectEditGrants.getState().revokeSession(owner)
      },
    })
    if (!plan.ok) {
      return { output: `ERROR: ${plan.refusal}`, isError: true }
    }
    // The team is itself a unit of work: without a record of its
    // own, its progress would have nowhere to land and its children
    // would appear in the panel as unrelated errands.
    const teamTaskId = taskIdFor(sid, runId, callId)
    recordAgentDispatch(run, {
      callId,
      agentName: 'team',
      title: 'team',
      description: `${tasks.length} tasks`,
      model: ctx.modelId,
      anchorMessageId: ctx.anchorMessageId(),
    })
    useCoworkActivity.getState().patchTask(teamTaskId, {
      status: 'running',
      startedAt: Date.now(),
    })
    // AH-111: a failed member can be restarted or replaced from the
    // Tasks panel while the team runs; the control lives as long
    // as the team does.
    const teamControl = new TeamControl()
    useTeamControls.getState().register(teamTaskId, teamControl)
    // Its own stop, chained to the turn's: a background workflow
    // is cancelled through this (`cancel_task`, the panel's Stop)
    // without ending the turn.
    const teamAbort = registerSubagent(sid, teamTaskId)
    // Registered only while the run is live; with no run to hang it
    // off, the handle comes back already aborted, which must not
    // cancel a team the turn itself has not stopped.
    const teamSignal = hasSubagent(sid, teamTaskId)
      ? AbortSignal.any([ctx.signal, teamAbort.signal])
      : ctx.signal
    // A workflow keeps each finished agent's result so a stopped run
    // can be resumed; a replay returns saved ones without running.
    const runMeta = (input as { run?: { phases: unknown[]; args?: Record<string, unknown>; resumeRunId?: string } } | null)?.run
    const runLog = runMeta ? await openRunLog(sid, callId, runMeta) : null
    const withLog = (fn: (one: TeamTask, signal: AbortSignal) => Promise<TaskResult>) =>
      runLog
        ? withRunLog(runLog, fn, (one, output) => {
            const childId = `${callId}:${one.id}`
            recordAgentDispatch(run, {
              callId: childId,
              agentName: one.subagentName ?? 'worker',
              title: one.title,
              phase: one.phase,
              description: one.description,
              parentTaskId: teamTaskId,
            })
            useCoworkActivity.getState().patchTask(taskIdFor(sid, runId, childId), {
              status: 'done',
              output,
              detail: 'from saved result',
              endedAt: Date.now(),
            })
          })
        : fn
    try {
      const teamOutcome = await runTeam(tasks, {
        // The turn's controller: stopping the run stops the team,
        // and every child hangs off a signal chained to this one.
        signal: teamSignal,
        allowParallel,
        control: teamControl,
        decisionWindowMs: COWORK_DECISION_WINDOW_MS,
        onPause: (paused) =>
          useCoworkActivity.getState().patchTask(teamTaskId, { paused }),
        onControl: (request, result) => {
          if (!result.ok || request.kind === 'finish' || request.kind === 'pause' || request.kind === 'resume') {
            if (!result.ok) toast.error(result.refusal.message)
            return
          }
          const childTask = taskIdFor(sid, runId, `${callId}:${request.taskId}`)
          const activity = useCoworkActivity.getState()
          const prior = activity.tasks[childTask]
          activity.patchTask(childTask, {
            status: 'running',
            endedAt: undefined,
            attempts: (prior?.attempts ?? 0) + 1,
            ...(request.kind === 'replace'
              ? {
                  replacedWith: {
                    agentName: request.with.subagentName,
                    description: request.with.description,
                  },
                  ...(request.with.description
                    ? { description: request.with.description }
                    : {}),
                }
              : {}),
          })
        },
        onState: (state: TeamState) =>
          useCoworkActivity.getState().patchTask(teamTaskId, {
            detail:
              awaitingDecision(state) &&
              !Object.values(state).some((s) => s.status === 'running' || s.status === 'pending')
                ? `${teamProgress(state)} · waiting for a decision on the failed tasks`
                : teamProgress(state),
          }),
        runTask: wrapLoops(withLog(async (one: TeamTask, signal: AbortSignal) => {
          // One call id per task, so each child gets its own
          // transcript lane and its own entry in the Tasks panel.
          const childId = `${callId}:${one.id}`
          const destination = plan.byTask.get(one.id)
          if (destination) {
            // Said in the panel, not only in the report: someone
            // watching a child work needs to know it is not their
            // folder it is working in.
            useCoworkActivity
              .getState()
              .patchTask(taskIdFor(sid, runId, childId), {
                detail: `own checkout: ${destination.path}`,
              })
            // AH-109: recorded before it runs, so its worktree is
            // listed for review whatever becomes of the run -- and
            // an isolated child that cannot be recorded does not
            // run, rather than leaving work nobody is shown.
            const began = await beginTeamChild({
              parentSession: sid,
              taskId: one.id,
              run: runId,
              call: callId,
              description: one.description,
              agent: one.subagentName ?? 'worker',
              project: ctx.folder ?? '',
              declaredWrites: one.writes,
              overrides: overrides.filter((o) =>
                o.tasks.includes(one.id)
              ),
            })
            useTeamChildrenVersion.getState().bump()
            if (!began.ok) {
              return {
                taskId: one.id,
                ok: false,
                output: `its checkout could not be recorded for review, so it did not run: ${began.reason}`,
                producedBy: childId,
              }
            }
          }
          // How the child ended, for its review record: a Stop
          // from the panel or the run is a cancellation, never a
          // failure and never a success.
          const childTask = taskIdFor(sid, runId, childId)
          const endedAs = (isError: boolean) =>
            signal.aborted ||
            useCoworkActivity.getState().tasks[childTask]
              ?.status === 'cancelled'
              ? ('cancelled' as const)
              : isError
                ? ('failed' as const)
                : ('completed' as const)
          let status: 'completed' | 'failed' | 'cancelled' =
            'failed'
          let detail = ''
          try {
            // A task that names no saved agent still has to be
            // runnable: without a prompt it resolves to nothing
            // and is refused as unknown. A named agent ignores
            // `system_prompt`, as `resolveSubagent` prefers the
            // saved definition.
            const dispatchOne = (
              id: string,
              description: string,
              title: string | undefined
            ) =>
              ctx.dispatchChild(
                id,
                {
                  subagent_name: one.subagentName ?? 'worker',
                  description,
                  ...(title ? { title } : {}),
                  ...(one.model ? { model: one.model } : {}),
                  ...(one.phase ? { phase: one.phase } : {}),
                  system_prompt: TEAM_DEFAULT_PROMPT,
                },
                signal,
                teamTaskId,
                destination,
                one.id
              )
            // A typed answer is checked and re-asked; each retry is
            // its own row, so every attempt stays visible.
            const result = one.schema
              ? await runTyped(
                  one.description + schemaInstruction(one.schema),
                  one.schema,
                  (brief, attempt) =>
                    dispatchOne(
                      attempt === 1 ? childId : `${childId}~r${attempt}`,
                      brief,
                      attempt === 1 || !one.title
                        ? one.title
                        : `${one.title} (try ${attempt})`
                    )
                )
              : await dispatchOne(childId, one.description, one.title)
            status = endedAs(result.isError === true)
            detail = result.output.slice(0, 500)
            return {
              taskId: one.id,
              ok: status === 'completed',
              output: result.output,
              producedBy: childId,
              // Not authority-bearing, and the one thing that stops a
              // completed task reading as "changed your folder".
              ...(destination
                ? { destination: destination.path }
                : {}),
            }
          } catch (error) {
            status = endedAs(true)
            detail =
              error instanceof Error ? error.message : String(error)
            throw error
          } finally {
            if (destination) {
              await settleTeamChild(sid, one.id, status, detail).catch(
                () => {}
              )
              useTeamChildrenVersion.getState().bump()
            }
          }
        })),
      })
      await runLog?.settled()
      if (!teamOutcome.ok) {
        useCoworkActivity.getState().patchTask(teamTaskId, {
          status: 'error',
          output: teamOutcome.refusal,
          endedAt: Date.now(),
        })
        return {
          output: `ERROR: ${teamOutcome.refusal}`,
          isError: true,
        }
      }
      const where = describeDestinations(plan.byTask)
      const rendered = [
        renderTeamReport(teamOutcome.report) +
          (teamOutcome.decision === 'window-elapsed' ||
          teamOutcome.decision === 'not-retried'
            ? `\n\n${renderNotRetried(teamOutcome.report)}`
            : ''),
        where
          ? `${where}\nTheir changes wait for the user's review in the Changes panel; none of them has been applied.`
          : '',
        runLog?.summary() ?? '',
        runLog && !teamOutcome.report.allDone
          ? `This run's run_id is ${runLog.runId}. Relaunch it with \`workflow {resume_run_id: "${runLog.runId}"}\`: finished agents return their saved results; the failed one and everything after it runs again.`
          : '',
        decided.length
          ? `Decided by the user before the team ran:\n${decided.map((d) => `- ${d}`).join('\n')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n')
      useCoworkActivity.getState().patchTask(teamTaskId, {
        // The team's own row settles on what actually happened, so a
        // partial run cannot read as a finished one at a glance.
        status: teamSignal.aborted
          ? ('cancelled' as const)
          : teamOutcome.report.allDone
            ? ('done' as const)
            : ('error' as const),
        output: rendered,
        detail: teamProgress(teamOutcome.state),
        endedAt: Date.now(),
      })
      return {
        output: rendered,
        // A team where something failed is an error result, so the
        // agent cannot read a partial run as a finished one.
        isError: !teamOutcome.report.allDone,
      }
    } finally {
      useTeamControls.getState().unregister(teamTaskId)
      unregisterSubagent(sid, teamTaskId)
      // The children are done, so their authority goes back. The
      // worktrees stay: they hold the work the team was run for,
      // and the report names where each one is.
      await plan.release()
    }
  }
}
