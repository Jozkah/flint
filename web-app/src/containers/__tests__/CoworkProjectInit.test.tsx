/**
 * The project initialization assistant (AH-209): a survey proposes, the user
 * edits, and only acceptance writes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const api = vi.hoisted(() => ({
  projectSurvey: vi.fn(),
  projectInitAccept: vi.fn(),
}))
vi.mock('@janhq/tauri-plugin-agent-tools-api', () => api)

import { CoworkProjectInit } from '../CoworkProjectInit'
import { useProjectInitDrafts } from '@/lib/projectInit'

const survey = {
  draft: '# widget\n\nA small widget library.\n',
  read: ['package.json', 'README.md'],
  notRead: ['3 folder(s) deeper than 4 levels were not listed'],
  filesSeen: 12,
  hasInstructions: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  useProjectInitDrafts.setState({ drafts: {} })
  api.projectSurvey.mockResolvedValue(survey)
  api.projectInitAccept.mockResolvedValue('/repo/FLINT.md')
})

describe('CoworkProjectInit', () => {
  it('is not offered without a folder, or when the folder has a FLINT.md', () => {
    const { rerender } = render(
      <CoworkProjectInit folder={null} hasInstructions={false} />
    )
    expect(screen.queryByTestId('project-init-open')).toBeNull()
    rerender(<CoworkProjectInit folder="/repo" hasInstructions />)
    expect(screen.queryByTestId('project-init-open')).toBeNull()
  })

  it('proposes a draft, says what it did not read, and writes nothing yet', async () => {
    render(<CoworkProjectInit folder="/repo" hasInstructions={false} />)
    await userEvent.click(screen.getByTestId('project-init-open'))
    const text = await screen.findByTestId('project-init-text')
    expect(text).toHaveValue(survey.draft)
    expect(text).toHaveAccessibleName('FLINT.md')
    expect(screen.getByTestId('project-init-not-read')).toHaveTextContent(
      'deeper than 4 levels'
    )
    expect(api.projectInitAccept).not.toHaveBeenCalled()
    expect(screen.getByTestId('project-init-status')).toHaveTextContent(
      'Nothing has been written'
    )
  })

  // Found on Windows: accepting took the offer away -- FLINT.md now exists --
  // and the announcement of the write went with it.
  it('still announces the write once the folder has its FLINT.md', async () => {
    const { rerender } = render(
      <CoworkProjectInit folder="/repo" hasInstructions={false} />
    )
    await userEvent.click(screen.getByTestId('project-init-open'))
    await screen.findByTestId('project-init-text')
    await userEvent.click(screen.getByTestId('project-init-accept'))
    await waitFor(() => expect(api.projectInitAccept).toHaveBeenCalled())
    rerender(<CoworkProjectInit folder="/repo" hasInstructions />)
    expect(screen.queryByTestId('project-init-open')).toBeNull()
    expect(screen.getByTestId('project-init-status')).toHaveTextContent(
      'Wrote FLINT.md'
    )
  })

  it('writes exactly the edited text on accept, then clears the draft', async () => {
    const onAccepted = vi.fn()
    render(
      <CoworkProjectInit
        folder="/repo"
        hasInstructions={false}
        onAccepted={onAccepted}
      />
    )
    await userEvent.click(screen.getByTestId('project-init-open'))
    const text = await screen.findByTestId('project-init-text')
    fireEvent.change(text, { target: { value: '# Mine\n' } })
    await userEvent.click(screen.getByTestId('project-init-accept'))
    await waitFor(() =>
      expect(api.projectInitAccept).toHaveBeenCalledWith(
        '/mock/jan/data',
        '/repo',
        '# Mine\n'
      )
    )
    expect(onAccepted).toHaveBeenCalled()
    expect(useProjectInitDrafts.getState().draftFor('/repo')).toBeNull()
    expect(screen.getByTestId('project-init-status')).toHaveTextContent(
      'Wrote FLINT.md'
    )
  })

  it('announces a refusal and keeps the draft', async () => {
    api.projectInitAccept.mockRejectedValue(
      'this folder already has a FLINT.md, so nothing was written'
    )
    render(<CoworkProjectInit folder="/repo" hasInstructions={false} />)
    await userEvent.click(screen.getByTestId('project-init-open'))
    await screen.findByTestId('project-init-text')
    await userEvent.click(screen.getByTestId('project-init-accept'))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'already has a FLINT.md'
    )
    expect(useProjectInitDrafts.getState().draftFor('/repo')).not.toBeNull()
  })

  it('keeps an edited draft when the dialog closes, and offers to continue it', async () => {
    render(<CoworkProjectInit folder="/repo" hasInstructions={false} />)
    await userEvent.click(screen.getByTestId('project-init-open'))
    fireEvent.change(await screen.findByTestId('project-init-text'), {
      target: { value: '# Edited\n' },
    })
    await userEvent.keyboard('{Escape}')
    expect(useProjectInitDrafts.getState().draftFor('/repo')?.content).toBe(
      '# Edited\n'
    )
    expect(screen.getByTestId('project-init-open')).toHaveTextContent(
      'Continue the FLINT.md draft'
    )
    // Reopening shows the edit rather than surveying over it.
    await userEvent.click(screen.getByTestId('project-init-open'))
    expect(await screen.findByTestId('project-init-text')).toHaveValue(
      '# Edited\n'
    )
    expect(api.projectSurvey).toHaveBeenCalledTimes(1)
  })

  // Cancellation: a survey the user walked away from leaves nothing behind.
  it('drops the result of a survey that was abandoned', async () => {
    let finish: (v: typeof survey) => void = () => {}
    api.projectSurvey.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    render(<CoworkProjectInit folder="/repo" hasInstructions={false} />)
    await userEvent.click(screen.getByTestId('project-init-open'))
    await userEvent.keyboard('{Escape}')
    finish(survey)
    await new Promise((r) => setTimeout(r, 0))
    expect(useProjectInitDrafts.getState().draftFor('/repo')).toBeNull()
  })

  it('persists only the drafts', () => {
    const options = useProjectInitDrafts.persist.getOptions()
    expect(
      Object.keys(options.partialize!(useProjectInitDrafts.getState()))
    ).toEqual(['drafts'])
  })
})
