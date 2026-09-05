import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CoworkContextBreakdown } from '../CoworkContextBreakdown'
import {
  estimated,
  measured,
  type ContextAccounting,
} from '@/lib/coworkReadiness'

const context = (over: Partial<ContextAccounting> = {}): ContextAccounting => ({
  categories: {
    instructions: estimated(1200, '~4 chars per token'),
    skills: measured(0),
    repositoryMap: measured(0),
    conversation: estimated(800, '~4 chars per token'),
    tools: estimated(2000, '~4 chars per token'),
  },
  budget: estimated(8192, 'configured'),
  ...over,
})

const panel = () => screen.getByLabelText('common:readiness.contextBreakdown')

describe('where the context went', () => {
  it('lists every category, including the ones that contributed nothing', () => {
    // The row nobody would think to add. "Repository map — nothing sent" is the
    // answer to the complaint that started this work, and a layout that only
    // lists what it has would silently drop it.
    render(<CoworkContextBreakdown context={context()} />)

    expect(panel()).toHaveTextContent(
      'common:readiness.contextCategory.repositoryMap'
    )
    expect(panel()).toHaveTextContent('common:readiness.categoryNothing')
  })

  it('separates "nothing sent" from "not known yet"', () => {
    render(
      <CoworkContextBreakdown
        context={context({
          categories: {
            ...context().categories,
            conversation: measured(null),
          },
        })}
      />
    )

    expect(panel()).toHaveTextContent('common:readiness.categoryUnknown')
    expect(panel()).toHaveTextContent('common:readiness.categoryNothing')
  })

  it('marks a derived figure as derived', () => {
    render(<CoworkContextBreakdown context={context()} />)

    expect(panel()).toHaveTextContent('common:readiness.categoryEstimated')
  })

  it('reports a counted figure as counted', () => {
    render(
      <CoworkContextBreakdown
        context={context({
          categories: { ...context().categories, instructions: measured(1200) },
        })}
      />
    )

    expect(panel()).toHaveTextContent('common:readiness.categoryCounted')
  })

  it('will not compute what is left against an unknown window', () => {
    // An invented reassurance is the failure mode here: "6,000 of 8,192 used"
    // when nobody knows the window is worse than saying nothing.
    render(
      <CoworkContextBreakdown
        context={context({ budget: measured(null) })}
      />
    )

    expect(panel()).toHaveTextContent('common:readiness.budgetUnknown')
  })

  it('will not compute what is left from an incomplete total', () => {
    // A total missing a category understates usage, so "remaining" would
    // overstate the headroom — the direction that gets a run truncated.
    render(
      <CoworkContextBreakdown
        context={context({
          categories: { ...context().categories, tools: measured(null) },
        })}
      />
    )

    expect(panel()).toHaveTextContent('common:readiness.budgetUnknown')
  })

  it('says so plainly when the payload exceeds the window', () => {
    render(
      <CoworkContextBreakdown
        context={context({
          categories: {
            instructions: measured(5000),
            skills: measured(0),
            repositoryMap: measured(0),
            conversation: measured(5000),
            tools: measured(1000),
          },
          budget: estimated(8192, 'configured'),
        })}
      />
    )

    expect(panel()).toHaveTextContent('common:readiness.budgetOver')
  })
})
