import { create } from 'zustand'

/** How long the user's allowance lasts. */
export type DomainScope = 'once' | 'session' | 'always'

export type DomainAnswer = {
  /** `deny` declines this time; `never` also saves a block rule. */
  decision: 'allow' | 'deny' | 'never'
  scope: DomainScope
  /** Also cover the site's subdomains. */
  subdomains: boolean
}

export type DomainRequest = {
  /** The full address the assistant wants to open or act on. */
  url: string
  /** The host a grant covers. */
  host: string
  tool: string
  origin?: string
  signal?: AbortSignal
}

export type PendingDomainRequest = Omit<DomainRequest, 'signal'> & {
  id: string
  resolve: (answer: DomainAnswer) => void
}

const DENY: DomainAnswer = {
  decision: 'deny',
  scope: 'once',
  subdomains: false,
}

type State = {
  queue: PendingDomainRequest[]
  request: (req: DomainRequest) => Promise<DomainAnswer>
  answer: (id: string, answer: DomainAnswer) => void
}

let next = 0

/**
 * The first-visit question: may the assistant's browser load this site? One at
 * a time, in the order asked. A run that stops while its question is on screen
 * withdraws it, and a withdrawn question counts as "no".
 */
export const useBrowserAgentPrompt = create<State>()((set, get) => ({
  queue: [],
  request: (req) =>
    new Promise<DomainAnswer>((resolve) => {
      if (req.signal?.aborted) {
        resolve(DENY)
        return
      }
      const id = `domain-${Date.now().toString(36)}-${++next}`
      const { signal, ...rest } = req
      set((s) => ({ queue: [...s.queue, { ...rest, id, resolve }] }))
      signal?.addEventListener(
        'abort',
        () => get().answer(id, DENY),
        { once: true }
      )
    }),
  answer: (id, answer) => {
    const entry = get().queue.find((q) => q.id === id)
    if (!entry) return
    set((s) => ({ queue: s.queue.filter((q) => q.id !== id) }))
    entry.resolve(answer)
  },
}))
