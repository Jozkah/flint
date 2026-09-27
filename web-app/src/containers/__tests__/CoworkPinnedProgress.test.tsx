import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import {
  CoworkPinnedProgress,
  CoworkProgressButton,
} from '../CoworkPinnedProgress'
import { recordTodoSnapshot } from '@/hooks/useCoworkSessions'

const plan = {
  phases: [
    {
      name: '',
      tasks: [
        { content: 'Read the page', status: 'completed' as const },
        { content: 'Add the form', status: 'in_progress' as const },
        { content: 'Update the README', status: 'pending' as const },
      ],
    },
  ],
}

function Harness({ todos = plan }: { todos?: typeof plan }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 200 }}>
      <CoworkPinnedProgress
        todos={todos}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        onUnpin={() => {}}
      />
      <div data-testid="scroller" style={{ overflowY: 'auto', flex: 1 }}>
        <div style={{ height: 5000 }} />
      </div>
    </div>
  )
}

describe('the pinned progress strip', () => {
  it('is hidden without a plan', () => {
    const { container } = render(
      <CoworkPinnedProgress
        todos={undefined}
        expanded={false}
        onToggle={() => {}}
        onUnpin={() => {}}
      />
    )
    expect(container).toBeEmptyDOMElement()
    render(<CoworkProgressButton todos={{ phases: [] }} onPin={() => {}} />)
    expect(screen.queryByTestId('cowork-progress-button')).toBeNull()
  })

  it('stays outside the scrolling transcript, showing count and current step', () => {
    render(<Harness />)
    const scroller = screen.getByTestId('scroller')
    scroller.scrollTop = 4000
    const strip = screen.getByTestId('cowork-pinned-progress')
    expect(scroller.contains(strip)).toBe(false)
    expect(strip).toHaveTextContent('1/3')
    expect(strip).toHaveTextContent('Add the form')
  })

  it('expands to the full list and collapses again', async () => {
    render(<Harness />)
    const toggle = screen.getByTestId('cowork-pinned-progress-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Update the README')).toBeNull()
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Update the README')).toBeInTheDocument()
    await userEvent.click(toggle)
    expect(screen.queryByText('Update the README')).toBeNull()
  })

  it('unpins, and the header button pins it back', async () => {
    const onUnpin = vi.fn()
    const onPin = vi.fn()
    render(
      <>
        <CoworkPinnedProgress
          todos={plan}
          expanded={false}
          onToggle={() => {}}
          onUnpin={onUnpin}
        />
        <CoworkProgressButton todos={plan} onPin={onPin} />
      </>
    )
    await userEvent.click(screen.getByTestId('cowork-pinned-progress-unpin'))
    await userEvent.click(screen.getByTestId('cowork-progress-button'))
    expect(onUnpin).toHaveBeenCalledOnce()
    expect(onPin).toHaveBeenCalledOnce()
  })
})

describe('plan snapshots', () => {
  it('keep one per run: the same run updates, a new run adds', () => {
    const first = { phases: [{ name: '', tasks: [plan.phases[0].tasks[0]] }] }
    let snaps = recordTodoSnapshot(undefined, 'run-a', first)
    snaps = recordTodoSnapshot(snaps, 'run-a', plan)
    expect(snaps).toEqual([{ anchorId: 'run-a', list: plan }])
    snaps = recordTodoSnapshot(snaps, 'run-b', first)
    expect(snaps.map((s) => s.anchorId)).toEqual(['run-a', 'run-b'])
  })
})
