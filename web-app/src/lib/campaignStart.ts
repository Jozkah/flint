/**
 * Starting a campaign on purpose (docs/CAMPAIGNS.md, "Using campaigns").
 *
 * A campaign still begins the way it always did: a Cowork session on a git
 * folder whose model calls `campaign_plan`. "New campaign" only saves the
 * person from knowing that: it opens such a session with a first message that
 * asks for the plan, so the model needs no more from the user than the goal.
 */

import { create } from 'zustand'

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

/** A model a session can be sent with. */
export type StartModel = { provider: string; id: string }

/**
 * The opening message of a campaign waiting to be sent by the Cowork page of
 * its session. It goes through the page's own send path (the one the Send
 * button uses), so the model check, the run, the title and the transcript are
 * all the ordinary ones; nothing here drains a queue.
 */
type LaunchState = {
  pending: Record<string, string>
  request: (sessionId: string, text: string) => void
  take: (sessionId: string) => string | undefined
}

export const useCampaignLaunch = create<LaunchState>((set, get) => ({
  pending: {},
  request: (sessionId, text) =>
    set((s) => ({ pending: { ...s.pending, [sessionId]: text } })),
  take: (sessionId) => {
    const text = get().pending[sessionId]
    if (text === undefined) return undefined
    set((s) => {
      const rest = { ...s.pending }
      delete rest[sessionId]
      return { pending: rest }
    })
    return text
  },
}))

export type StartDeps = {
  /** The model the campaign's session will use, or null when none is usable. */
  resolveModel: () => StartModel | null
  createSession: () => string
  setFolder: (id: string, folder: string) => void
  setTitle: (id: string, title: string) => void
  setModel: (id: string, model: StartModel) => void
  /** Ask the Cowork page of the session to send its first message. */
  launch: (id: string, text: string) => void
  select: (id: string) => void
  /** Delete a session this flow created and could not finish. */
  remove: (id: string) => void
}

export type StartResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: 'empty-goal' | 'no-folder' | 'no-model' | 'failed' }

/**
 * Create the coordinator session on the model in use and ask for its opening
 * message to be sent. No session is created when there is no usable model, and
 * one that fails halfway is deleted, so no empty session is left behind.
 */
export function startCampaign(
  input: { goal: string; folder: string | null | undefined },
  deps: StartDeps
): StartResult {
  const goal = cleanGoal(input.goal)
  if (!goal) return { ok: false, reason: 'empty-goal' }
  if (!input.folder) return { ok: false, reason: 'no-folder' }
  const model = deps.resolveModel()
  if (!model) return { ok: false, reason: 'no-model' }
  let id: string | null = null
  try {
    id = deps.createSession()
    deps.setFolder(id, input.folder)
    deps.setTitle(id, titleFromGoal(goal))
    deps.setModel(id, model)
    deps.select(id)
    deps.launch(id, buildCoordinatorOpening(goal))
    return { ok: true, sessionId: id }
  } catch {
    if (id) {
      try {
        deps.remove(id)
      } catch {
        // Nothing more can be done; the caller reports the failure.
      }
    }
    return { ok: false, reason: 'failed' }
  }
}
