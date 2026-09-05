/**
 * Where a team's isolated children write.
 *
 * A team without this shares one write root: every child edits the same
 * checkout, and two of them touching the same file is prevented only by
 * refusing colliding `writes` declarations. Declarations are what a model says
 * it will do, so that is a promise, not a boundary.
 *
 * This is the boundary. A task that asks to be isolated gets its own managed
 * worktree and its own write grant, so a sibling cannot see or overwrite its
 * work whatever it declared. Three rules make that trustworthy:
 *
 * **Everything is provisioned before any child starts.** A team that discovers
 * halfway through that it cannot isolate its fourth task would already have
 * three children's work on the shared tree. So planning either hands back a
 * destination for every isolated task, or refuses the team and hands back
 * nothing.
 *
 * **A failure to isolate is never a silent fallback.** If a worktree cannot be
 * made, or its grant cannot be issued, the team is refused. Running the task
 * against the run's own root instead would be the exact thing this exists to
 * prevent: a child writing the user's checkout while the request said isolated.
 *
 * **What was provisioned is released.** Grants are handed back when the team
 * ends, so authority does not outlive the work. The worktrees stay: they hold
 * the children's changes, and deleting them would throw away the output the
 * team was run for.
 */

import type { TeamTask } from '@/lib/coworkTeam'

/** One child's own place to write. */
export type Destination = {
  /**
   * The derived owner id: the grant's session and the worktree's key.
   *
   * Not the run's session id — the backend keys authority by session, and two
   * children of one session need two live grants. `grants.rs` derives the same
   * shape and recognises it as a child, so revoking the session revokes these
   * with it.
   */
  ownerId: string
  /** The worktree root. Not authority-bearing: safe to show and to log. */
  path: string
  branch: string
  baseSha: string
  /** Opaque, authority-bearing. Goes to the backend and nowhere else. */
  grantId: string
  /** What the source checkout had uncommitted, and this therefore cannot see. */
  uncommittedAtCreation: string[]
}

/** Mirrors `grants::child_session_id`, character for character. */
export function childSessionId(parent: string, child: string): string {
  const safe = [...child]
    .map((c) => (/[A-Za-z0-9._-]/.test(c) ? c : '-'))
    .slice(0, 48)
    .join('')
  return `${parent}--child-${safe}`
}

export type EnsureResult =
  | {
      ok: true
      record: {
        path: string
        branch: string
        baseSha: string
        uncommittedAtCreation: string[]
      }
    }
  | { ok: false; reason: string }

export type AuthorizeResult =
  | { ok: true; grant: { grantId: string } }
  | { ok: false; reason: string }

export type DestinationDeps = {
  parentSessionId: string
  /** The repository the run is bound to. Null when nothing is attached. */
  project: string | null
  dataFolder: string
  /**
   * Whether this platform can confine a run to a managed worktree at all.
   *
   * Read from the run's frozen capability answer rather than asked again here,
   * so a team is refused for the same reason the access selector gives.
   */
  canIsolate: boolean
  ensure: (
    ownerId: string,
    project: string,
    dataFolder: string
  ) => Promise<EnsureResult>
  authorize: (
    ownerId: string,
    folder: string,
    dataFolder: string
  ) => Promise<AuthorizeResult>
  /** Hand a child's grant back. Called for everything this planned. */
  revoke: (ownerId: string) => Promise<unknown>
}

export type DestinationPlan =
  | { ok: false; refusal: string }
  | {
      ok: true
      /** By task id. Tasks that did not ask to be isolated are absent. */
      byTask: Map<string, Destination>
      /** Hand back every grant this issued. Idempotent. */
      release: () => Promise<void>
    }

const isolating = (tasks: readonly TeamTask[]) =>
  tasks.filter((task) => task.isolate === true)

/**
 * Provision a destination for every task that asked for one.
 *
 * Returns a refusal the model can read, or a plan plus the release that undoes
 * it. Nothing partial ever escapes: a failure anywhere releases what was
 * already provisioned before returning.
 */
export async function planDestinations(
  tasks: readonly TeamTask[],
  deps: DestinationDeps
): Promise<DestinationPlan> {
  const wanted = isolating(tasks)
  const done = new Map<string, Destination>()
  const release = async () => {
    for (const one of done.values())
      await deps.revoke(one.ownerId).catch(() => {})
    done.clear()
  }
  if (wanted.length === 0) return { ok: true, byTask: done, release }

  if (!deps.project) {
    return {
      ok: false,
      refusal:
        'these tasks asked for their own checkout, but this session has no folder attached: ' +
        `${wanted.map((one) => one.id).join(', ')}. Attach a folder, or drop \`isolate\`.`,
    }
  }
  if (!deps.canIsolate) {
    return {
      ok: false,
      refusal:
        'this platform cannot give a task its own managed checkout, so these tasks cannot run as asked: ' +
        `${wanted.map((one) => one.id).join(', ')}. Drop \`isolate\` to run them in the session's own destination.`,
    }
  }

  for (const task of wanted) {
    const ownerId = childSessionId(deps.parentSessionId, task.id)
    const made = await deps.ensure(ownerId, deps.project, deps.dataFolder)
    if (!made.ok) {
      await release()
      return {
        ok: false,
        refusal: `task '${task.id}' asked for its own checkout and it could not be created: ${made.reason}`,
      }
    }
    const granted = await deps.authorize(
      ownerId,
      made.record.path,
      deps.dataFolder
    )
    if (!granted.ok) {
      // The worktree exists but nothing may write it. Running the task anyway
      // would put its changes wherever the run's own root is — which is the
      // silent fallback this refuses to make.
      //
      // Withdrawn for this task as well as the earlier ones: the backend may
      // have issued a grant and handed it straight back as superseded, and
      // asking again for something already gone is success.
      await deps.revoke(ownerId).catch(() => {})
      await release()
      return {
        ok: false,
        refusal: `task '${task.id}' has its own checkout but could not be authorized to write it: ${granted.reason}`,
      }
    }
    done.set(task.id, {
      ownerId,
      path: made.record.path,
      branch: made.record.branch,
      baseSha: made.record.baseSha,
      uncommittedAtCreation: made.record.uncommittedAtCreation,
      grantId: granted.grant.grantId,
    })
  }

  return { ok: true, byTask: done, release }
}

/**
 * What the dispatching agent is told about where its team worked.
 *
 * Named destinations, said once, so a report of completed tasks cannot be read
 * as "these changes are in my folder" when they are in several checkouts of
 * their own. Empty when nothing was isolated.
 */
export function describeDestinations(byTask: Map<string, Destination>): string {
  if (byTask.size === 0) return ''
  const lines = [...byTask.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([taskId, one]) =>
        `- ${taskId}: ${one.path} (branch ${one.branch}, from ${one.baseSha.slice(0, 8)})`
    )
  const uncommitted = [...byTask.values()].some(
    (one) => one.uncommittedAtCreation.length > 0
  )
  return [
    'These tasks worked in checkouts of their own. Their changes are not in the attached folder:',
    ...lines,
    ...(uncommitted
      ? [
          'The attached folder had uncommitted changes when these were created, so those changes are not present in them.',
        ]
      : []),
  ].join('\n')
}
