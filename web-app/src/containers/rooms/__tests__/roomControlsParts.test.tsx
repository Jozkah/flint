import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { makeParticipant, makeRoom } from './roomsTestUtils'
import { speakingQueue, stageFor } from '../roomStage'
import { SpeakingQueue } from '../controls/SpeakingQueue'
import { SteerPanel } from '../controls/SteerPanel'
import { TransportRow } from '../controls/TransportRow'
import { PreflightPanel } from '../apply/PreflightPanel'
import { PatchFileRow } from '../apply/PatchFileRow'

vi.mock('@/i18n/react-i18next-compat', async () => {
  const u = await import('./roomsT')
  return { useTranslation: () => ({ t: u.t }), i18n: { t: u.t } }
})

const t = (k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k)
const names = (ps: { name: string }[]) => ps.map((p) => p.name)

describe('speakingQueue', () => {
  const three = [
    makeParticipant('a', { name: 'A', order: 0 }),
    makeParticipant('b', { name: 'B', order: 1 }),
    makeParticipant('c', { name: 'C', order: 2 }),
  ]
  it('keeps the plain order while the room is not under way', () => {
    expect(names(speakingQueue(makeRoom({ participants: three }), null))).toEqual(['A', 'B', 'C'])
  })
  it('puts the chosen next speaker first and the current speaker last', () => {
    const room = makeRoom({
      status: 'running',
      participants: three,
      nextSpeakerId: 'c',
      spokenThisRound: ['a'],
    })
    expect(names(speakingQueue(room, 'b'))).toEqual(['C', 'A', 'B'])
  })
})

describe('stageFor', () => {
  const modelName = () => 'GPT'
  it('names the speaker with role and model during a live turn', () => {
    const room = makeRoom({ status: 'running' })
    const live = {
      roomId: 'r1',
      turnId: 't',
      author: { kind: 'participant' as const, participantId: 'p1' },
      text: '',
      startedAt: 1,
    }
    const stage = stageFor(room, live as never, t, modelName)
    expect(stage.speaker?.id).toBe('p1')
    expect(stage.hint).toBe('skeptic · GPT')
  })
  it('says the room is comparing when several turns run in a compare room', () => {
    const room = makeRoom({ status: 'running', mode: 'compare' })
    const live = { roomId: 'r1', turnId: 't', author: { kind: 'system' }, text: '', startedAt: 1 }
    expect(stageFor(room, live as never, t, modelName, 3).title).toBe(
      'rooms:stage.comparing:{"count":3}'
    )
  })
  it('describes an idle room by status', () => {
    expect(stageFor(makeRoom({ status: 'paused' }), null, t, modelName).title).toBe(
      'rooms:stage.paused'
    )
  })
})

describe('SpeakingQueue', () => {
  const queue = [makeParticipant('p1', { name: 'Alice' }), makeParticipant('p2', { name: 'Bob' })]
  it('renders nothing for an empty queue', () => {
    const { container } = render(
      <SpeakingQueue queue={[]} compare={false} active canSelect onPick={vi.fn()} />
    )
    expect(container).toBeEmptyDOMElement()
  })
  it('picks a participant when selecting is allowed', () => {
    const onPick = vi.fn()
    render(<SpeakingQueue queue={queue} compare={false} active canSelect onPick={onPick} />)
    fireEvent.click(screen.getAllByRole('button')[1])
    expect(onPick).toHaveBeenCalledWith('p2')
  })
  it('compare chips are not pickable', () => {
    render(<SpeakingQueue queue={queue} compare active canSelect onPick={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Alice' })).toBeDisabled()
  })
})

describe('TransportRow', () => {
  const avail = {
    start: true,
    pause: true,
    resume: true,
    stop: true,
    selectNext: true,
  } as never
  const handlers = () => ({
    onPause: vi.fn(),
    onResume: vi.fn(),
    onStart: vi.fn(),
    onSelectNext: vi.fn(),
    onStop: vi.fn(),
  })
  it('the main button follows the status', () => {
    const h = handlers()
    const { rerender } = render(
      <TransportRow room={makeRoom({ status: 'draft' })} avail={avail} busy={false} speakers={[]} {...h} />
    )
    fireEvent.click(screen.getAllByRole('button')[0])
    expect(h.onStart).toHaveBeenCalled()
    rerender(
      <TransportRow room={makeRoom({ status: 'running' })} avail={avail} busy={false} speakers={[]} {...h} />
    )
    fireEvent.click(screen.getAllByRole('button')[0])
    expect(h.onPause).toHaveBeenCalled()
    rerender(
      <TransportRow room={makeRoom({ status: 'paused' })} avail={avail} busy={false} speakers={[]} {...h} />
    )
    fireEvent.click(screen.getAllByRole('button')[0])
    expect(h.onResume).toHaveBeenCalled()
  })
  it('a compare room has no Next; busy disables everything', () => {
    const h = handlers()
    render(
      <TransportRow room={makeRoom({ mode: 'compare' })} avail={avail} busy speakers={[]} {...h} />
    )
    expect(screen.getAllByRole('button')).toHaveLength(2)
    screen.getAllByRole('button').forEach((b) => expect(b).toBeDisabled())
  })
})

describe('SteerPanel', () => {
  const avail = {
    callVote: true,
    requestFinalPositions: true,
    synthesize: true,
    cancelTurn: true,
  } as never
  it('opens the vote form and submits a trimmed proposal through run', async () => {
    const onCallVote = vi.fn(async () => {})
    const run = vi.fn((fn: () => Promise<void>) => void fn())
    render(
      <SteerPanel
        roomId="r1"
        avail={avail}
        busy={false}
        active
        error={null}
        onCallVote={onCallVote}
        onFinalPositions={vi.fn()}
        onSynthesize={vi.fn()}
        onCancelTurn={vi.fn()}
        run={run}
      />
    )
    fireEvent.click(screen.getAllByRole('button')[0])
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '  ship it  ' } })
    fireEvent.submit(input.closest('form')!)
    expect(run).toHaveBeenCalled()
    expect(onCallVote).toHaveBeenCalledWith('ship it')
  })
  it('shows locked, busy and error lines', () => {
    render(
      <SteerPanel
        roomId="r1"
        avail={avail}
        busy
        active={false}
        error={{ message: 'boom' } as never}
        onCallVote={vi.fn()}
        onFinalPositions={vi.fn()}
        onSynthesize={vi.fn()}
        onCancelTurn={vi.fn()}
        run={vi.fn()}
      />
    )
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('boom')
  })
})

describe('PreflightPanel', () => {
  it('lists conflicts and leaves them out on request', () => {
    const onLeave = vi.fn()
    render(
      <PreflightPanel
        check={{ state: 'conflict', conflicts: [{ path: 'a.ts', reason: 'context' }] }}
        dirty={[]}
        onLeaveOutConflicts={onLeave}
        t={t}
      />
    )
    expect(screen.getByText('a.ts')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('apply-leave-out'))
    expect(onLeave).toHaveBeenCalled()
  })
  it('shows dirty files and a clean check', () => {
    render(<PreflightPanel check={{ state: 'clean' }} dirty={['x.ts']} onLeaveOutConflicts={vi.fn()} t={t} />)
    expect(screen.getByTestId('apply-dirty')).toHaveTextContent('x.ts')
    expect(screen.getByText('rooms:apply.clean')).toBeInTheDocument()
  })
})

describe('PatchFileRow', () => {
  const file = {
    path: 'src/a.ts',
    status: 'modified',
    additions: 2,
    deletions: 1,
    binary: true,
    diff: { hunks: [] },
  } as never
  it('toggles selection and expansion, shows badges', () => {
    const onSel = vi.fn()
    const onExp = vi.fn()
    render(
      <ul>
        <PatchFileRow
          file={file}
          selected
          expanded
          conflict
          dirty
          onToggleSelected={onSel}
          onToggleExpanded={onExp}
          t={t}
        />
      </ul>
    )
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { expanded: true }))
    expect(onSel).toHaveBeenCalled()
    expect(onExp).toHaveBeenCalled()
    expect(screen.getByText('rooms:apply.fileConflict')).toBeInTheDocument()
    expect(screen.getByText('rooms:apply.fileDirty')).toBeInTheDocument()
    expect(screen.getByText('rooms:apply.binary')).toBeInTheDocument()
  })
})
