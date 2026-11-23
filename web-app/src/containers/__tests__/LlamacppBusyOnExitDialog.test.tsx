import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import '@testing-library/jest-dom'

const hoisted = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined),
  listeners: {} as Record<string, (event: { payload: unknown }) => void>,
  persist: vi.fn(async () => undefined),
}))

vi.mock('@/lib/persistInterruptedReplies', () => ({
  persistInterruptedReplies: hoisted.persist,
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: hoisted.invoke }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, cb: (event: { payload: unknown }) => void) => {
    hoisted.listeners[name] = cb
    return () => {}
  }),
}))
vi.mock('@janhq/tauri-plugin-llamacpp-api', () => ({
  forceStopEngine: vi.fn(async () => undefined),
}))
vi.mock('@/lib/platform/utils', () => ({ isPlatformTauri: () => true }))
vi.mock('sonner', () => ({
  toast: { loading: vi.fn(), dismiss: vi.fn() },
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import LlamacppBusyOnExitDialog from '../dialogs/LlamacppBusyOnExitDialog'

describe('LlamacppBusyOnExitDialog', () => {
  beforeEach(() => {
    hoisted.invoke.mockClear()
  })

  it('tells the backend to stop the pending quit when Cancel is clicked', async () => {
    render(<LlamacppBusyOnExitDialog />)
    await waitFor(() =>
      expect(hoisted.listeners['llamacpp-busy-on-exit']).toBeDefined()
    )
    act(() => {
      hoisted.listeners['llamacpp-busy-on-exit']({ payload: ['model-a'] })
    })
    fireEvent.click(await screen.findByText('common:cancel'))
    expect(hoisted.invoke).toHaveBeenCalledWith('cancel_exit')
    expect(hoisted.invoke).not.toHaveBeenCalledWith('confirm_exit')
  })

  it('saves the replies still streaming before Force quit exits', async () => {
    render(<LlamacppBusyOnExitDialog />)
    await waitFor(() =>
      expect(hoisted.listeners['llamacpp-busy-on-exit']).toBeDefined()
    )
    act(() => {
      hoisted.listeners['llamacpp-busy-on-exit']({ payload: ['model-a'] })
    })
    fireEvent.click(await screen.findByText('common:llamacppBusyOnExit.forceQuit'))
    await waitFor(() =>
      expect(hoisted.invoke).toHaveBeenCalledWith('confirm_exit')
    )
    expect(hoisted.persist).toHaveBeenCalledTimes(1)
    expect(hoisted.persist.mock.invocationCallOrder[0]).toBeLessThan(
      hoisted.invoke.mock.invocationCallOrder.at(-1)!
    )
  })
})
