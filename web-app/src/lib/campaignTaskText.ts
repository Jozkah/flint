// The words a campaign task row shows, kept apart from the component so they
// can be tested without rendering it. Every function takes the translate
// function, so the same code serves any language.

import type { HeadlineKind, StepGroup, StoryHeadline } from '@/lib/campaignStory'

export type Translate = (key: string, options?: Record<string, unknown>) => string

export type HeadlineParams = StoryHeadline['params']

const P = 'settings:campaigns.board'

/** The task's one-word state, naming what it waits on when that is the state. */
export function wordTextOf(t: Translate, word: string, waitingFor: readonly string[]): string {
  return word === 'waiting' || word === 'waitingSkipped'
    ? t(`${P}.word.${word}`, { tasks: waitingFor.join(', ') })
    : t(`${P}.word.${word}`)
}

export function stopClause(t: Translate, failures: number): string {
  return failures <= 0
    ? t(`${P}.story.stop.none`)
    : failures === 1
      ? t(`${P}.story.stop.one`)
      : t(`${P}.story.stop.many`, { count: failures })
}

export function wroteText(t: Translate, params: HeadlineParams): string {
  return t(`${P}.story.${params.counted ? 'wrote' : 'wroteUncounted'}`, {
    count: params.count,
    added: params.added,
    removed: params.removed,
  })
}

export function headlineTextOf(t: Translate, kind: HeadlineKind, params: HeadlineParams): string {
  switch (kind) {
    case 'wrote':
      return wroteText(t, params)
    case 'wroteStopped':
      return `${wroteText(t, params)}. ${stopClause(t, params.failures)}`
    case 'stoppedFailing':
      return `${t(`${P}.story.headline.noOutput`)} ${stopClause(t, params.failures)}`
    case 'working':
      return t(`${P}.story.headline.working`, { count: params.steps })
    case 'waiting':
      return t(`${P}.story.headline.waiting`, { tasks: params.tasks })
    default:
      return t(`${P}.story.headline.${kind}`)
  }
}

export function groupTextOf(t: Translate, g: StepGroup): { main: string; sub?: string } {
  const first = g.steps[0]
  const n = g.steps.length
  const names = g.steps.map((s) => s.label)
  const sub = n > 1 ? names.slice(0, 3).join(', ') + (n > 3 ? `, +${n - 3}` : '') : undefined
  switch (g.kind) {
    case 'read':
      return n > 1
        ? { main: t(`${P}.story.step.readMany`, { count: n }), sub }
        : { main: t(`${P}.story.step.read`, { label: first.label }) }
    case 'search':
      return { main: t(`${P}.story.step.search`, { count: n }) }
    case 'write':
      return n > 1
        ? { main: t(`${P}.story.step.writeMany`, { count: n }), sub }
        : { main: t(`${P}.story.step.write`, { label: first.label }) }
    default:
      return g.ok
        ? { main: t(`${P}.story.step.ran`, { label: first.label }) }
        : { main: t(`${P}.story.step.ranFailed`, { label: first.label }) }
  }
}
