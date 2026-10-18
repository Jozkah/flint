/**
 * `?nested=N` for the web preview: a chat with N forks nested under it (mixed
 * states: working, finished unseen, waiting, idle) and a Cowork session with
 * two forked sessions, to look at the sidebar's nested rows. `?nested` alone
 * is 20. The forks carry the same `forkedFrom` links real forks get.
 */
import { useAppState } from '@/hooks/useAppState'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'

const MIN = 60_000
export const NEST_PARENT = 'nest-parent'

export function nestedCount(): number | null {
  const p = new URLSearchParams(window.location.search)
  if (!p.has('nested')) return null
  const n = Number(p.get('nested'))
  return Number.isFinite(n) && p.get('nested') !== '' ? Math.max(0, n) : 20
}

const TOPICS = [
  'UE: NPCs, animals, AI',
  'Terrain streaming budget',
  'Day-night lighting pass',
  'Input mapping for gamepads',
  'Save system format',
  'Audio occlusion test',
  'Inventory UI layout',
  'Quest graph editor',
  'Pathfinding on slopes',
  'Shader compile times',
  'Weather particles',
  'Foliage LOD tuning',
  'Crash on level load',
  'Physics for ropes',
  'Localization pipeline',
  'Build server cache',
  'Animation retargeting',
  'Water reflections',
  'Dialogue system',
  'Mod support plan',
]

/** The parent chat and its forks, as stored threads. */
export function nestedPreviewThreads(now: number, base: Partial<Thread>): Thread[] {
  const n = nestedCount()
  if (n === null) return []
  const parent = {
    ...base,
    id: NEST_PARENT,
    title: 'Game development environment setup',
    updated: (now - 2 * MIN) / 1000,
    metadata: {},
  } as Thread
  const forks = Array.from({ length: n }, (_, i) => {
    // 0-4 working, 5 waiting, 6-17 finished in the last hour, the rest idle.
    const age = i < 6 ? 1 : i < 18 ? 3 + i * 2 : 200 + i * 30
    return {
      ...base,
      id: `nest-fork-${i}`,
      title: `${TOPICS[i % TOPICS.length]}${i >= TOPICS.length ? ` ${i}` : ''}`,
      updated: (now - age * MIN) / 1000,
      metadata: { forkedFrom: NEST_PARENT },
    } as Thread
  })
  return [parent, ...forks]
}

/** Running and waiting state for the forks above. */
export function seedNestingState() {
  const n = nestedCount()
  if (n === null) return
  const busy: Record<string, boolean> = {}
  for (let i = 0; i < Math.min(5, n); i++) busy[`nest-fork-${i}`] = true
  useAppState.setState((s) => ({ busyThreads: { ...s.busyThreads, ...busy } }))
  if (n > 5) {
    useToolApprovalRequests.setState((s) => ({
      pending: {
        ...s.pending,
        'nest-approval': {
          requestId: 'nest-approval',
          toolCallId: 'nest-call',
          toolName: 'bash',
          threadId: 'nest-fork-5',
        },
      },
    }) as never)
  }
}

/** Cowork: "Website implementation" with two forked sessions. */
export function nestedPreviewSessions<T extends { id: string }>(
  make: (id: string, title: string, age: number) => T
): T[] {
  if (nestedCount() === null) return []
  const parent = make('nest-site', 'Website implementation', 4)
  const forks = [
    make('nest-site-a', 'Website: pricing page', 6),
    make('nest-site-b', 'Website: blog import', 90),
  ].map((s) => ({ ...s, forkedFrom: { sessionId: 'nest-site', turns: 1, at: Date.now() } }))
  return [parent, ...forks]
}
