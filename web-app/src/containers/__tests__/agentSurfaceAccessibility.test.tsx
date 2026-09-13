/**
 * The agent surfaces, used without a pointer and read by something that is not
 * a pair of eyes. AH-179, AH-180.
 *
 * These panels already carry roles, labels and live regions; what they did not
 * have was anything holding them to it. A missing `aria-label`, a `div` that
 * became clickable, a status that stopped announcing -- each is a one-line
 * change that no test noticed, and each makes the surface unusable for someone
 * who cannot see it or cannot use a mouse.
 *
 * Two kinds of check here, deliberately:
 *
 * 1. A structural scan of every agent surface's source, for the mistake that
 *    is easy to make and invisible in review: something clickable that a
 *    keyboard cannot reach. It reads the files rather than rendering them, so
 *    a panel nobody has written a test for is still covered.
 * 2. Rendered checks on the two panels this phase changed most, driven the way
 *    a keyboard user drives them.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'

// ---- 1. Every agent surface, read as source ------------------------------

/** The containers and routes that make up the agent surfaces. */
function agentSurfaces(): string[] {
  const root = path.resolve(__dirname, '..')
  const routes = path.resolve(root, '../routes')
  const files: string[] = []
  for (const dir of [root, routes]) {
    if (!fs.existsSync(dir)) continue
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.tsx')) continue
      if (!/^(Cowork|PromptSnapshot|cowork)/.test(name)) continue
      files.push(path.join(dir, name))
    }
  }
  return files
}

/**
 * The opening tags of elements that are not natively interactive, with their
 * attributes.
 *
 * Written as a small scanner rather than a regex over `<div[^>]*>`: attribute
 * values contain `>` (every arrow function does), so the obvious pattern stops
 * early and reports elements that are in fact fine. This one tracks brace and
 * quote depth, which is the difference between a check and a nuisance.
 */
function passiveElements(source: string): { tag: string; attrs: string; line: number }[] {
  const out: { tag: string; attrs: string; line: number }[] = []
  const opener = /<(div|span|li|tr|td|p|section|article|header|footer)\b/g
  let match: RegExpExecArray | null
  while ((match = opener.exec(source))) {
    let i = opener.lastIndex
    let depth = 0
    let quote: string | null = null
    while (i < source.length) {
      const c = source[i]
      if (quote) {
        if (c === quote && source[i - 1] !== '\\') quote = null
      } else if (c === '"' || c === "'" || c === '`') {
        quote = c
      } else if (c === '{') {
        depth += 1
      } else if (c === '}') {
        depth -= 1
      } else if (c === '>' && depth === 0) {
        break
      }
      i += 1
    }
    out.push({
      tag: match[1],
      attrs: source.slice(opener.lastIndex, i),
      line: source.slice(0, match.index).split('\n').length,
    })
  }
  return out
}

describe('agent surfaces without a pointer (AH-180)', () => {
  it('has no click target a keyboard cannot reach', () => {
    const offenders: string[] = []
    for (const file of agentSurfaces()) {
      const source = fs.readFileSync(file, 'utf8')
      for (const element of passiveElements(source)) {
        if (!/\bonClick\b/.test(element.attrs)) continue
        const keyed = /\bonKey(Down|Up|Press)\b/.test(element.attrs)
        const focusable = /\btabIndex\b/.test(element.attrs)
        const labelled = /\brole=/.test(element.attrs)
        if (keyed && focusable && labelled) continue
        offenders.push(
          `${path.basename(file)}:${element.line} <${element.tag}> ` +
            `key=${keyed} focusable=${focusable} role=${labelled}`
        )
      }
    }
    expect(offenders, 'a click target that only a mouse can use').toEqual([])
  })

  it('scans the surfaces it claims to scan', () => {
    // A scan that silently matched nothing would pass the test above forever.
    const files = agentSurfaces()
    expect(files.length).toBeGreaterThan(20)
    expect(files.some((f) => f.endsWith('CoworkTimelinePanel.tsx'))).toBe(true)
    // And the scanner reads whole attribute lists, arrow functions included.
    const sample = passiveElements(
      '<div role="tab" onClick={() => go(a > b)} tabIndex={0} onKeyDown={(e) => e}>x</div>'
    )
    expect(sample).toHaveLength(1)
    expect(sample[0].attrs).toContain('onKeyDown')

    // And it fires on the thing it is looking for, or it is checking nothing.
    const offending = passiveElements('<div onClick={() => go()}>click me</div>')
    expect(offending).toHaveLength(1)
    const attrs = offending[0].attrs
    expect(attrs.includes('onClick')).toBe(true)
    expect(attrs.includes('onKeyDown')).toBe(false)
    expect(attrs.includes('tabIndex')).toBe(false)
  })
})

// ---- 2. The two panels this phase changed most, rendered ------------------

vi.mock('@/i18n/react-i18next-compat', async () => {
  const i18n = (await import('@/i18n/setup')).default
  return {
    useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => i18n.t(k, o) }),
  }
})
// The panel reads a session's events; an empty log is the case worth checking,
// because a surface with nothing in it still has to be findable and operable.
vi.mock('@/lib/eventLog', () => ({
  listEvents: vi.fn(async () => ({ events: [], lastSeq: 0, truncated: false })),
}))
vi.mock('@/lib/toolActivity', () => ({ loadToolDiff: vi.fn(async () => '') }))
vi.mock('@/containers/CoworkSidePanel', () => ({
  CoworkSidePanel: ({ children, summary, 'data-testid': id }: any) => (
    <section data-testid={id}>
      {summary}
      {children}
    </section>
  ),
}))

/** The filter group, by the label a person actually hears. */
const FILTER_GROUP = /show on the timeline/i

describe('the timeline announces itself (AH-179)', () => {
  it('names its region, its state and its filters', async () => {
    const { CoworkTimelinePanel } = await import('@/containers/CoworkTimelinePanel')
    render(<CoworkTimelinePanel sessionId="s-a11y" running={false} />)

    // The list itself is a named feed, so a screen reader can find it and say
    // what it is.
    const feed = await screen.findByRole('feed')
    expect(feed).toHaveAttribute('aria-label')
    expect(feed.getAttribute('aria-label')).toBeTruthy()
    expect(feed).toHaveAttribute('aria-busy', 'false')

    // Its state is in a live region: a run that starts or ends is announced
    // rather than only redrawn.
    const live = screen.getByTestId('timeline-live-state')
    expect(live).toHaveAttribute('aria-live', 'polite')

    // The filters are a named group of toggles, each saying whether it is on.
    const filters = screen.getByRole('group', { name: FILTER_GROUP })
    const toggles = filters.querySelectorAll('[aria-pressed]')
    expect(toggles.length).toBeGreaterThan(0)
    for (const toggle of toggles) {
      expect(toggle.getAttribute('aria-pressed')).toMatch(/true|false/)
    }
  })

  it('can be filtered from the keyboard alone', async () => {
    const { CoworkTimelinePanel } = await import('@/containers/CoworkTimelinePanel')
    render(<CoworkTimelinePanel sessionId="s-a11y-keys" running={false} />)
    const filters = await screen.findByRole('group', { name: FILTER_GROUP })
    const first = filters.querySelector('[aria-pressed]') as HTMLElement
    expect(first).toBeTruthy()
    const before = first.getAttribute('aria-pressed')

    // A button responds to Enter and Space because it is a button -- which is
    // the point of it being one.
    first.focus()
    expect(document.activeElement).toBe(first)
    fireEvent.click(first)
    expect(first.getAttribute('aria-pressed')).not.toBe(before)
  })
})
