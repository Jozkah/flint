/**
 * "Needs help": a task that stopped because of something it cannot get past
 * by trying again, said plainly with what to do about it, instead of a
 * generic failure (docs/CAMPAIGNS.md).
 *
 * The loop guard (`runLoopGuard.ts`) stops a run that hits the same blocker
 * twice and puts the cause, the shell and the remedy in its notice. This reads
 * that notice back for the task record so the board and the coordinator can
 * show it as help wanted, with a hint ready to retry with.
 */

/** Prefix on a task's `detail` while it is waiting for help. */
export const NEEDS_HELP_PREFIX = 'needs help:'

export type NeedsHelp = {
  /** The task's `detail`: starts with {@link NEEDS_HELP_PREFIX}. */
  detail: string
  /** A sentence to retry the task with (the board's retry hint). */
  hint: string
}

const TEST_RUNNER = /test runner cannot start in the sandbox/i

/** The retry hint the board offers for a task that needs help. */
export const NEEDS_HELP_HINT =
  'Do not run `node --test` the plain way here: its per-file child ' +
  'processes cannot start in the sandbox. Run the tests in this process with ' +
  '`node --test --test-isolation=none <files>` (or one file with `node <file>`), ' +
  'and if that is not enough, say which command the user should run.'

/** What a stopped run's notice says it needs, or `null` for an ordinary stop. */
export function needsHelpFrom(errorText: string | undefined): NeedsHelp | null {
  if (!errorText || !TEST_RUNNER.test(errorText)) return null
  const shell = errorText.match(/\(shell: ([^)]+)\)/)?.[1]
  const hint = NEEDS_HELP_HINT
  return {
    detail:
      `${NEEDS_HELP_PREFIX} the test runner cannot start in the sandbox` +
      `${shell ? ` (${shell})` : ''}. Retry it with the hint below, or run the ` +
      'tests yourself outside the sandbox.',
    hint,
  }
}

/** A task whose detail says it is waiting for help. */
export function isNeedsHelp(task: { status: string; detail: string }): boolean {
  return task.status === 'failed' && task.detail.startsWith(NEEDS_HELP_PREFIX)
}
