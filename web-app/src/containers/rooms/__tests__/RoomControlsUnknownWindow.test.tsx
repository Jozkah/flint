import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { createFakeApi, makeRoom, renderWithApi } from './roomsTestUtils'
import { RoomControls } from '../RoomControls'
import { UnknownWindowDialog } from '../UnknownWindowDialog'
import { useModelProvider } from '@/hooks/useModelProvider'
import { resetAcceptedWindows } from '@/lib/rooms/unknownWindows'

vi.mock('@/i18n/react-i18next-compat', async () => {
  const u = await import('./roomsTestUtils')
  return { useTranslation: () => ({ t: u.t }) }
})

beforeEach(() => {
  resetAcceptedWindows()
  useModelProvider.setState({
    providers: [
      {
        provider: 'openai',
        active: true,
        api_key: 'k',
        // No Max Context Tokens and nothing Flint knows about these ids.
        models: [{ id: 'tool-model' }, { id: 'plain-model' }],
      },
    ],
  } as never)
})

function setup() {
  const fake = createFakeApi()
  renderWithApi(
    <>
      <RoomControls room={makeRoom()} />
      <UnknownWindowDialog />
    </>,
    fake.api
  )
  return fake
}

describe('starting a room whose model window is unknown', () => {
  it('blocks start until a window is set, then saves it and starts', async () => {
    const { controller } = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(await screen.findByText('Context window unknown')).toBeInTheDocument()
    expect(controller.start).not.toHaveBeenCalled()

    const cont = screen.getByRole('button', { name: 'Continue' })
    expect(cont).toBeDisabled()
    await userEvent.type(screen.getByLabelText('openai / tool-model'), '32000')
    expect(cont).toBeEnabled()
    await userEvent.click(cont)

    await waitFor(() => expect(controller.start).toHaveBeenCalledWith('r1'))
    const model = useModelProvider
      .getState()
      .providers[0].models.find((m) => m.id === 'tool-model')
    expect(model?.settings?.max_context_tokens?.controller_props?.value).toBe(32000)
  })

  it('cancel leaves the room unstarted', async () => {
    const { controller } = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByText('Context window unknown')).not.toBeInTheDocument())
    expect(controller.start).not.toHaveBeenCalled()
  })

  it('accepting the safe default starts without saving a setting', async () => {
    const { controller } = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Use 8,192 (safe default)' }))
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(controller.start).toHaveBeenCalledWith('r1'))
    const model = useModelProvider
      .getState()
      .providers[0].models.find((m) => m.id === 'tool-model')
    expect(model?.settings?.max_context_tokens).toBeUndefined()
  })
})
