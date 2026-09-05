import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { ClaudeSkillRootsSettings } from '../ClaudeSkillRootsSettings'

const HOME = '/home/dev'
const SKILLS = `${HOME}/.claude/skills`
const user = userEvent.setup({ pointerEventsCheck: 0 })

const show = (
  over: Partial<Parameters<typeof ClaudeSkillRootsSettings>[0]> = {}
) => {
  const onChange = vi.fn()
  const pickFolder = vi.fn(async () => SKILLS)
  const confirmDirectory = vi.fn(async () => true)
  render(
    <ClaudeSkillRootsSettings
      roots={[]}
      onChange={onChange}
      pickFolder={pickFolder}
      confirmDirectory={confirmDirectory}
      {...over}
    />
  )
  return { onChange, pickFolder, confirmDirectory }
}

const region = () => screen.getByTestId('claude-skill-roots')
const addButton = () =>
  screen.getByRole('button', { name: 'common:claudeCompat.roots.add' })

describe('adding a skill folder', () => {
  /**
   * The property that makes this safe: every entry was chosen by the person
   * sitting there. A path someone can type is a path something else can
   * suggest, so there is no text field at all.
   */
  it('offers no way to type a path', () => {
    show()

    expect(within(region()).queryByRole('textbox')).toBeNull()
  })

  it('adds the folder the picker returned', async () => {
    const { onChange, pickFolder } = show()

    await user.click(addButton())

    expect(pickFolder).toHaveBeenCalled()
    expect(onChange).toHaveBeenCalledWith([SKILLS])
  })

  // Cancelling is not a failure and says nothing.
  it('does nothing when the picker is cancelled', async () => {
    const { onChange } = show({ pickFolder: vi.fn(async () => null) })

    await user.click(addButton())

    expect(onChange).not.toHaveBeenCalled()
    expect(within(region()).queryByRole('alert')).toBeNull()
  })

  it('says why a folder was refused, and adds nothing', async () => {
    const { onChange } = show({ roots: [SKILLS] })

    await user.click(addButton())

    expect(screen.getByRole('alert')).toHaveTextContent(
      'common:claudeCompat.roots.reject.duplicate'
    )
    expect(onChange).not.toHaveBeenCalled()
  })

  it('refuses Jan’s own storage', async () => {
    const { onChange } = show({
      janData: HOME,
      pickFolder: vi.fn(async () => `${HOME}/threads`),
    })

    await user.click(addButton())

    expect(screen.getByRole('alert')).toHaveTextContent(
      'common:claudeCompat.roots.reject.jan-data'
    )
    expect(onChange).not.toHaveBeenCalled()
  })

  // The picker can return a path that has since gone; the backend is what
  // knows.
  it('refuses a folder the backend cannot confirm', async () => {
    const { onChange } = show({ confirmDirectory: vi.fn(async () => false) })

    await user.click(addButton())

    expect(screen.getByRole('alert')).toHaveTextContent(
      'common:claudeCompat.roots.reject.missing'
    )
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('the folders already approved', () => {
  it('says plainly when there are none', () => {
    show()

    expect(region()).toHaveTextContent('common:claudeCompat.roots.none')
  })

  it('shows each folder and what was found in it', () => {
    show({
      roots: [SKILLS],
      discovered: { [SKILLS]: { skills: ['reviewer', 'auditor'] } },
    })

    expect(region()).toHaveTextContent(SKILLS)
    expect(region()).toHaveTextContent('reviewer, auditor')
  })

  // A folder that is there but unreadable is a visible state, not silence.
  it('shows a folder that could not be read', () => {
    show({
      roots: [SKILLS],
      discovered: { [SKILLS]: { skills: [], error: 'EACCES' } },
    })

    expect(region()).toHaveTextContent('common:claudeCompat.roots.unreadable')
    expect(region()).toHaveTextContent('EACCES')
  })

  it('shows a folder that simply holds no skills', () => {
    show({ roots: [SKILLS], discovered: { [SKILLS]: { skills: [] } } })

    expect(region()).toHaveTextContent('common:claudeCompat.roots.noneFound')
  })

  it('removes one when asked', async () => {
    const { onChange } = show({ roots: [SKILLS, `${HOME}/other`] })

    await user.click(
      screen.getAllByRole('button', {
        name: 'common:claudeCompat.roots.remove',
      })[0]
    )

    expect(onChange).toHaveBeenCalledWith([`${HOME}/other`])
  })

  it('rescans on request', async () => {
    const onRescan = vi.fn()
    show({ roots: [SKILLS], onRescan })

    await user.click(
      screen.getByRole('button', { name: 'common:claudeCompat.roots.rescan' })
    )

    expect(onRescan).toHaveBeenCalled()
  })
})

describe('what the surface tells the user', () => {
  // Said next to the button, not in documentation nobody opens.
  it('says discovery runs nothing and grants no repository access', () => {
    show()

    expect(region()).toHaveTextContent('common:claudeCompat.roots.description')
  })

  it('is its own labelled region', () => {
    show()

    expect(
      screen.getByRole('region', { name: 'common:claudeCompat.roots.title' })
    ).toBe(region())
  })
})
