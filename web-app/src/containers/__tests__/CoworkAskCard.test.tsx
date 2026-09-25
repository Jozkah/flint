import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { CoworkAskCard } from '@/containers/CoworkAskCard'
import type { AskRequestPayload } from '@/hooks/useCoworkRun'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars && 'count' in vars ? `${vars.count} selected` : key,
  }),
}))

const single: AskRequestPayload = {
  questions: [
    {
      id: 'scope',
      question: 'Which scope?',
      options: [{ label: 'Small' }, { label: 'Large' }],
    },
  ],
}

const multi: AskRequestPayload = {
  questions: [
    {
      id: 'who',
      question: 'Who reads it?',
      multi: true,
      options: [{ label: 'Team' }, { label: 'Public' }],
    },
  ],
}

const twoQuestions: AskRequestPayload = {
  questions: [
    { id: 'a', question: 'First?', options: [{ label: 'A1' }, { label: 'A2' }] },
    { id: 'b', question: 'Second?', options: [{ label: 'B1' }, { label: 'B2' }] },
  ],
}

let onRespond: ReturnType<typeof vi.fn>
beforeEach(() => {
  onRespond = vi.fn()
})

const submitButton = () => screen.getByLabelText('common:submit')

describe('CoworkAskCard', () => {
  it('renders nothing when there is no pending request', () => {
    const { container } = render(
      <CoworkAskCard requestId={null} request={null} onRespond={onRespond} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('submits the selected option label', () => {
    render(<CoworkAskCard requestId="ask-1" request={single} onRespond={onRespond} />)
    fireEvent.click(screen.getByText('Small'))
    fireEvent.click(submitButton())
    expect(onRespond).toHaveBeenCalledWith('ask-1', [{ id: 'scope', selected: ['Small'] }])
  })

  it('single-select replaces the previous pick rather than accumulating', () => {
    render(<CoworkAskCard requestId="ask-1" request={single} onRespond={onRespond} />)
    fireEvent.click(screen.getByText('Small'))
    fireEvent.click(screen.getByText('Large'))
    fireEvent.click(submitButton())
    expect(onRespond).toHaveBeenCalledWith('ask-1', [{ id: 'scope', selected: ['Large'] }])
  })

  it('multi-select accumulates', () => {
    render(<CoworkAskCard requestId="ask-1" request={multi} onRespond={onRespond} />)
    fireEvent.click(screen.getByText('Team'))
    fireEvent.click(screen.getByText('Public'))
    fireEvent.click(submitButton())
    expect(onRespond).toHaveBeenCalledWith('ask-1', [
      { id: 'who', selected: ['Team', 'Public'] },
    ])
  })

  it('free text and options are mutually exclusive, per the QuestionResult contract', () => {
    render(<CoworkAskCard requestId="ask-1" request={single} onRespond={onRespond} />)
    fireEvent.click(screen.getByText('Small'))
    fireEvent.click(screen.getByText('common:askSomethingElse'))
    fireEvent.change(screen.getByPlaceholderText('common:askSomethingElsePlaceholder'), {
      target: { value: 'neither' },
    })
    fireEvent.click(submitButton())
    // `selected` empty, custom_input set — never both.
    expect(onRespond).toHaveBeenCalledWith('ask-1', [
      { id: 'scope', selected: [], custom_input: 'neither' },
    ])
  })

  it('cannot submit on empty free text', () => {
    render(<CoworkAskCard requestId="ask-1" request={single} onRespond={onRespond} />)
    fireEvent.click(screen.getByText('common:askSomethingElse'))
    expect(submitButton()).toBeDisabled()
    fireEvent.change(screen.getByPlaceholderText('common:askSomethingElsePlaceholder'), {
      target: { value: '   ' },
    })
    expect(submitButton()).toBeDisabled()
  })

  it('requires every question answered before submitting, since the core rejects partial responses', () => {
    render(<CoworkAskCard requestId="ask-1" request={twoQuestions} onRespond={onRespond} />)
    // Answer only the first, then page to the last.
    fireEvent.click(screen.getByText('A1'))
    fireEvent.click(screen.getByLabelText('common:askNext'))
    expect(screen.getByText('Second?')).toBeInTheDocument()
    expect(submitButton()).toBeDisabled()

    fireEvent.click(screen.getByText('B1'))
    fireEvent.click(submitButton())
    expect(onRespond).toHaveBeenCalledWith('ask-1', [
      { id: 'a', selected: ['A1'] },
      { id: 'b', selected: ['B1'] },
    ])
  })

  it('Skip declines the whole request (the core has no per-question skip)', () => {
    render(<CoworkAskCard requestId="ask-1" request={twoQuestions} onRespond={onRespond} />)
    fireEvent.click(screen.getByText('common:skip'))
    expect(onRespond).toHaveBeenCalledWith('ask-1', null)
  })

  it('dismissing declines too, so a paused run never hangs silently', () => {
    render(<CoworkAskCard requestId="ask-1" request={single} onRespond={onRespond} />)
    fireEvent.click(screen.getByLabelText('common:close'))
    expect(onRespond).toHaveBeenCalledWith('ask-1', null)
  })

  it('resets state when a new request arrives', () => {
    const { rerender } = render(
      <CoworkAskCard requestId="ask-1" request={single} onRespond={onRespond} />
    )
    fireEvent.click(screen.getByText('Small'))
    // A second request must not inherit the first one's pick.
    rerender(<CoworkAskCard requestId="ask-2" request={single} onRespond={onRespond} />)
    expect(submitButton()).toBeDisabled()
  })

  it('renders exactly one custom-answer row when the model supplied its own', () => {
    // The duplicate that was on screen: the model's "Something else" plus the
    // card's injected one.
    const withOwnOther: AskRequestPayload = {
      questions: [
        {
          id: 'scope',
          question: 'Which scope?',
          options: [{ label: 'Small' }, { label: 'common:askSomethingElse' }],
        },
      ],
    }
    render(
      <CoworkAskCard requestId="r" request={withOwnOther} onRespond={onRespond} />
    )
    expect(screen.getAllByTestId('ask-custom-option')).toHaveLength(1)
    expect(screen.getAllByText('common:askSomethingElse')).toHaveLength(1)
  })

  it('opens exactly one text input when the custom row is chosen', () => {
    render(<CoworkAskCard requestId="r" request={single} onRespond={onRespond} />)
    fireEvent.click(screen.getByTestId('ask-custom-option'))
    expect(screen.getAllByTestId('ask-custom-input')).toHaveLength(1)
    // And no second row appeared to serve as the input.
    expect(screen.getAllByTestId('ask-custom-option')).toHaveLength(1)
  })

  it('sends the model wording, not the card wording, for a model-supplied row', () => {
    const padded: AskRequestPayload = {
      questions: [
        {
          id: 'scope',
          question: 'Which scope?',
          options: [{ label: 'Small' }, { label: '  Other  ' }],
        },
      ],
    }
    render(<CoworkAskCard requestId="r" request={padded} onRespond={onRespond} />)
    // It is recognised as the custom row, so it opens the input rather than
    // being submitted as a selected label.
    fireEvent.click(screen.getByTestId('ask-custom-option'))
    fireEvent.change(screen.getByTestId('ask-custom-input'), {
      target: { value: 'squash' },
    })
    fireEvent.click(screen.getByLabelText('common:submit'))
    expect(onRespond).toHaveBeenCalledWith('r', [
      { id: 'scope', selected: [], custom_input: 'squash' },
    ])
  })

  it('keeps the selection when a streamed update rewrites a label', () => {
    const { rerender } = render(
      <CoworkAskCard requestId="r" request={single} onRespond={onRespond} />
    )
    fireEvent.click(screen.getByText('Small'))
    rerender(
      <CoworkAskCard
        requestId="r"
        request={{
          questions: [
            {
              id: 'scope',
              question: 'Which scope?',
              options: [{ label: 'Small change' }, { label: 'Large' }],
            },
          ],
        }}
        onRespond={onRespond}
      />
    )
    fireEvent.click(screen.getByLabelText('common:submit'))
    // Identity is positional, so the first option is still the answer -- with
    // whatever wording it now carries.
    expect(onRespond).toHaveBeenCalledWith('r', [
      { id: 'scope', selected: ['Small change'] },
    ])
  })

  it('shows option descriptions and marks the recommended option', () => {
    render(
      <CoworkAskCard
        requestId="ask-r"
        request={{
          questions: [
            {
              id: 'db',
              question: 'Which database?',
              recommended: 1,
              options: [
                { label: 'SQLite', description: 'One file, no server' },
                { label: 'Postgres', description: 'Full server' },
              ],
            },
          ],
        }}
        onRespond={onRespond}
      />
    )
    expect(screen.getByText('One file, no server')).toBeInTheDocument()
    const badge = screen.getByText('common:askRecommended')
    expect(badge.closest('button')).toHaveTextContent('Postgres')
    expect(screen.getAllByText('common:askRecommended')).toHaveLength(1)
  })

  it('renders multi-select options as checkboxes and submits every pick', () => {
    render(<CoworkAskCard requestId="ask-m" request={multi} onRespond={onRespond} />)
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes.length).toBeGreaterThanOrEqual(2)
    fireEvent.click(screen.getByText('Team'))
    fireEvent.click(screen.getByText('Public'))
    expect(screen.getByText('2 selected')).toBeInTheDocument()
    fireEvent.click(submitButton())
    expect(onRespond).toHaveBeenCalledWith('ask-m', [
      { id: 'who', selected: ['Team', 'Public'] },
    ])
  })

  it('shows the staged plan under a plan review question', () => {
    render(
      <CoworkAskCard
        requestId="ask-p"
        request={{
          questions: [
            {
              id: 'plan_review',
              question: 'Add a login page.',
              options: [
                { label: 'Execute plan' },
                { label: 'Keep planning' },
                { label: 'Exit plan mode' },
              ],
            },
          ],
        }}
        plan={{
          phases: [
            {
              name: 'Build',
              tasks: [
                { content: 'Add the route', status: 'pending' },
                { content: 'Write the form', status: 'pending' },
              ],
            },
          ],
        }}
        onRespond={onRespond}
      />
    )
    const steps = screen.getByTestId('ask-plan-steps')
    expect(steps).toHaveTextContent('Build')
    expect(steps).toHaveTextContent('Add the route')
    expect(steps).toHaveTextContent('Write the form')
  })

  it('shows no plan for an ordinary question', () => {
    render(
      <CoworkAskCard
        requestId="ask-o"
        request={single}
        plan={{ phases: [{ name: '', tasks: [{ content: 'x', status: 'pending' }] }] }}
        onRespond={onRespond}
      />
    )
    expect(screen.queryByTestId('ask-plan-steps')).toBeNull()
  })
})
