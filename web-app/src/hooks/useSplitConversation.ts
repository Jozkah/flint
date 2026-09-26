import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'

/**
 * Split view: more conversations shown beside the one the route names.
 *
 * The route owns the main pane (`primary`): the Chat thread in
 * `/threads/$threadId`, or the current Cowork session on `/cowork`. This store
 * remembers the other panes -- which conversation each shows, Chat thread or
 * Cowork session -- which pane the user is working in, and how the width is
 * shared. Everything a conversation owns -- its session, stream, draft,
 * attachments, approvals, model -- stays keyed by its own id, so no two panes
 * share it.
 */

export type SplitPaneKind = 'chat' | 'cowork' | 'room'

/**
 * The rooms engine holds one open room at a time, so split view shows at most
 * one room: opening another retargets the pane that has one.
 */
export const SINGLE_INSTANCE_KINDS: readonly SplitPaneKind[] = ['room']

/** `primary` for the route's pane, otherwise the extra pane's own id. */
export type SplitPaneId = string

export const PRIMARY_PANE: SplitPaneId = 'primary'

/** A pane beside the main one. No `refId` yet: it shows a picker. */
export type SplitPane = {
  id: SplitPaneId
  kind: SplitPaneKind
  refId?: string
}

/** What a pane can show. */
export type SplitTarget = { kind: SplitPaneKind; refId?: string }

export const SPLIT_DEFAULT_MAX_PANES = 4
export const SPLIT_MIN_MAX_PANES = 2
export const SPLIT_MAX_MAX_PANES = 6

/** No pane gets narrower than this; past it the panes take turns as tabs. */
export const PANE_MIN_WIDTH = 420

/** The smallest share of the width a divider can leave a pane. */
export const PANE_MIN_SHARE = 0.12

/** Where an extra pane keeps its composer draft, apart from the main one's. */
export const paneDraftScope = (paneId: SplitPaneId): string | undefined =>
  paneId === PRIMARY_PANE ? undefined : `split:${paneId}`

/** The pane that migrated from the two-pane split keeps its old draft. */
export const SECONDARY_DRAFT_SCOPE = 'split:secondary'

export function clampMaxPanes(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return SPLIT_DEFAULT_MAX_PANES
  return Math.min(
    SPLIT_MAX_MAX_PANES,
    Math.max(SPLIT_MIN_MAX_PANES, Math.round(n))
  )
}

const equalSizes = (count: number) =>
  Array.from({ length: count }, () => 1 / count)

/**
 * Shares of the width for `count` panes: the given ones when they fit,
 * otherwise equal shares. Each is at least the minimum and they sum to one.
 */
export function normalizeSizes(sizes: unknown, count: number): number[] {
  if (count <= 1) return [1]
  if (
    !Array.isArray(sizes) ||
    sizes.length !== count ||
    !sizes.every((s) => typeof s === 'number' && Number.isFinite(s) && s > 0)
  ) {
    return equalSizes(count)
  }
  const floored = (sizes as number[]).map((s) => Math.max(PANE_MIN_SHARE, s))
  const total = floored.reduce((a, b) => a + b, 0)
  return floored.map((s) => s / total)
}

/** Move the divider after pane `index` by `delta` of the width. */
export function moveDivider(
  sizes: number[],
  index: number,
  delta: number
): number[] {
  if (index < 0 || index >= sizes.length - 1) return sizes
  const pair = sizes[index] + sizes[index + 1]
  const left = Math.min(
    pair - PANE_MIN_SHARE,
    Math.max(PANE_MIN_SHARE, sizes[index] + delta)
  )
  const next = [...sizes]
  next[index] = left
  next[index + 1] = pair - left
  return next
}

const newPaneId = () =>
  `pane-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

export type AddPaneResult = 'added' | 'filled' | 'shown' | 'full'

type SplitConversationState = {
  /** The panes beside the main one, left to right. */
  panes: SplitPane[]
  /** Width shares: the main pane first, then each of `panes`. */
  sizes: number[]
  activePane: SplitPaneId
  /** How many panes, the main one included, may be open at once. */
  maxPanes: number
  /**
   * Show `target` in a pane. An empty pane (a picker) takes it first; a pane
   * already showing it becomes the active one; otherwise a new pane opens,
   * unless the cap is reached. With no target, a new empty pane opens.
   */
  addPane: (target?: SplitTarget) => AddPaneResult
  closePane: (id: SplitPaneId) => void
  /** Back to one conversation: the main pane stays. */
  closeAll: () => void
  setPaneTarget: (id: SplitPaneId, target?: SplitTarget) => void
  setActivePane: (id: SplitPaneId) => void
  setSizes: (sizes: number[]) => void
  resizeDivider: (index: number, delta: number) => void
  setMaxPanes: (max: number) => void
  /** Make the pane `step` places over the active one (wrapping). */
  cyclePane: (step: number) => SplitPaneId
}

type Persisted = Pick<SplitConversationState, 'panes' | 'sizes' | 'maxPanes'>

/** The two-pane split's saved state, before split view took N panes. */
type LegacySplit = {
  open?: boolean
  secondaryThreadId?: string
  ratio?: number
}

export function migrateSplitState(persisted: unknown, version: number): Persisted {
  if (version === 0) {
    const legacy = (persisted ?? {}) as LegacySplit
    if (!legacy.open) {
      return { panes: [], sizes: [1], maxPanes: SPLIT_DEFAULT_MAX_PANES }
    }
    const ratio =
      typeof legacy.ratio === 'number' && Number.isFinite(legacy.ratio)
        ? legacy.ratio
        : 0.5
    return {
      // Id 'secondary' so the second pane keeps the draft it had.
      panes: [
        { id: 'secondary', kind: 'chat', refId: legacy.secondaryThreadId },
      ],
      sizes: normalizeSizes([ratio, 1 - ratio], 2),
      maxPanes: SPLIT_DEFAULT_MAX_PANES,
    }
  }
  return sanitize(persisted)
}

function sanitize(persisted: unknown): Persisted {
  const raw = (persisted ?? {}) as Partial<Persisted>
  const maxPanes = clampMaxPanes(raw.maxPanes)
  const panes = (Array.isArray(raw.panes) ? raw.panes : [])
    .filter(
      (p): p is SplitPane =>
        !!p &&
        typeof p.id === 'string' &&
        p.id !== PRIMARY_PANE &&
        (p.kind === 'chat' || p.kind === 'cowork' || p.kind === 'room')
    )
    .slice(0, maxPanes - 1)
  return {
    panes,
    sizes: normalizeSizes(raw.sizes, panes.length + 1),
    maxPanes,
  }
}

const sameTarget = (pane: SplitPane, target: SplitTarget) =>
  pane.kind === target.kind && !!target.refId && pane.refId === target.refId

export const useSplitConversation = create<SplitConversationState>()(
  persist(
    (set, get) => ({
      panes: [],
      sizes: [1],
      activePane: PRIMARY_PANE,
      maxPanes: SPLIT_DEFAULT_MAX_PANES,

      addPane: (target) => {
        const { panes, maxPanes } = get()
        if (target?.refId) {
          const shown = panes.find((p) => sameTarget(p, target))
          if (shown) {
            set({ activePane: shown.id })
            return 'shown'
          }
          if (SINGLE_INSTANCE_KINDS.includes(target.kind)) {
            const same = panes.find((p) => p.kind === target.kind && p.refId)
            if (same) {
              set({
                panes: panes.map((p) =>
                  p.id === same.id ? { ...p, refId: target.refId } : p
                ),
                activePane: same.id,
              })
              return 'filled'
            }
          }
          const empty = panes.find((p) => !p.refId)
          if (empty) {
            set({
              panes: panes.map((p) =>
                p.id === empty.id ? { ...p, ...target } : p
              ),
              activePane: empty.id,
            })
            return 'filled'
          }
        }
        if (panes.length + 1 >= maxPanes) return 'full'
        const pane: SplitPane = {
          id: newPaneId(),
          kind: target?.kind ?? 'chat',
          refId: target?.refId,
        }
        const next = [...panes, pane]
        set({
          panes: next,
          sizes: equalSizes(next.length + 1),
          activePane: pane.id,
        })
        return 'added'
      },

      closePane: (id) => {
        const { panes, sizes, activePane } = get()
        const index = panes.findIndex((p) => p.id === id)
        if (index < 0) return
        const next = panes.filter((p) => p.id !== id)
        // The closed pane's width goes to its left neighbour.
        const nextSizes = [...sizes]
        const [removed] = nextSizes.splice(index + 1, 1)
        nextSizes[index] = (nextSizes[index] ?? 0) + (removed ?? 0)
        set({
          panes: next,
          sizes: normalizeSizes(nextSizes, next.length + 1),
          activePane:
            activePane === id
              ? (next[index - 1]?.id ?? PRIMARY_PANE)
              : activePane,
        })
      },

      closeAll: () =>
        set({ panes: [], sizes: [1], activePane: PRIMARY_PANE }),

      setPaneTarget: (id, target) =>
        set({
          panes: get().panes.map((p) =>
            p.id === id
              ? { id, kind: target?.kind ?? p.kind, refId: target?.refId }
              : p
          ),
        }),

      setActivePane: (id) => {
        if (get().activePane !== id) set({ activePane: id })
      },

      setSizes: (sizes) =>
        set({ sizes: normalizeSizes(sizes, get().panes.length + 1) }),

      resizeDivider: (index, delta) =>
        set({
          sizes: moveDivider(
            normalizeSizes(get().sizes, get().panes.length + 1),
            index,
            delta
          ),
        }),

      cyclePane: (step) => {
        const ids = [PRIMARY_PANE, ...get().panes.map((p) => p.id)]
        const at = Math.max(0, ids.indexOf(get().activePane))
        const next = ids[(((at + step) % ids.length) + ids.length) % ids.length]
        get().setActivePane(next)
        return next
      },

      setMaxPanes: (max) => {
        const maxPanes = clampMaxPanes(max)
        const { panes } = get()
        // Lowering the cap closes the rightmost panes that no longer fit.
        const kept = panes.slice(0, maxPanes - 1)
        const state: Partial<SplitConversationState> = { maxPanes }
        if (kept.length !== panes.length) {
          state.panes = kept
          state.sizes = equalSizes(kept.length + 1)
          if (!kept.some((p) => p.id === get().activePane)) {
            state.activePane = PRIMARY_PANE
          }
        }
        set(state)
      },
    }),
    {
      name: localStorageKey.splitConversation,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      version: 1,
      migrate: (persisted, version) =>
        migrateSplitState(persisted, version) as SplitConversationState,
      // Which pane has focus is a moment, not a preference.
      partialize: (state): Persisted => ({
        panes: state.panes,
        sizes: state.sizes,
        maxPanes: state.maxPanes,
      }),
      merge: (persisted, current) => ({
        ...current,
        ...sanitize(persisted),
      }),
    }
  )
)

/** Whether more than one pane is open. */
export const selectIsSplit = (s: { panes: SplitPane[] }) => s.panes.length > 0
