/**
 * Starting a campaign on purpose (docs/CAMPAIGNS.md, "Using campaigns").
 *
 * A campaign still begins the way it always did: a Cowork session on a git
 * folder whose model calls `campaign_plan`. "New campaign" only saves the
 * person from knowing that: it opens such a session with a first message that
 * asks for the plan, so the model needs no more from the user than the goal.
 */

/** The longest goal accepted; the plan itself is written by the model. */
export const CAMPAIGN_GOAL_MAX = 4_000

/** A goal worth sending: trimmed and within the cap. */
export function cleanGoal(raw: string): string {
  return raw.trim().slice(0, CAMPAIGN_GOAL_MAX)
}

/** The first message of the coordinator session. */
export function buildCoordinatorOpening(goal: string): string {
  return [
    'I want to run this as a Flint campaign: a big task split into smaller tasks that run in parallel, each in its own worktree, then merged and checked together.',
    '',
    `Goal: ${cleanGoal(goal)}`,
    '',
    'Look at the repository, then plan the work with the campaign_plan tool. Keep the tasks small and independent, say which ones depend on another, and give each one a clear way to tell it is done. If the goal is too unclear to plan, ask me one short question first.',
  ].join('\n')
}

/** A short session title from the goal: its first line, cut at a word. */
export function titleFromGoal(goal: string, max = 60): string {
  const first = cleanGoal(goal).split('\n')[0]?.trim() ?? ''
  if (first.length <= max) return first
  const cut = first.slice(0, max)
  const at = cut.lastIndexOf(' ')
  return `${(at > max / 2 ? cut.slice(0, at) : cut).trimEnd()}…`
}

export type StartDeps = {
  createSession: () => string
  setFolder: (id: string, folder: string) => void
  setTitle: (id: string, title: string) => void
  /** Queue the first message on the session; it is sent when it is shown. */
  enqueue: (id: string, text: string) => void
  select: (id: string) => void
}

export type StartResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: 'empty-goal' | 'no-folder' }

/** Create the coordinator session and queue its opening message. */
export function startCampaign(
  input: { goal: string; folder: string | null | undefined },
  deps: StartDeps
): StartResult {
  const goal = cleanGoal(input.goal)
  if (!goal) return { ok: false, reason: 'empty-goal' }
  if (!input.folder) return { ok: false, reason: 'no-folder' }
  const id = deps.createSession()
  deps.setFolder(id, input.folder)
  deps.setTitle(id, titleFromGoal(goal))
  deps.enqueue(id, buildCoordinatorOpening(goal))
  deps.select(id)
  return { ok: true, sessionId: id }
}
