import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { value?: string }) => (o?.value ? `${k}:${o.value}` : k),
  }),
}))

const getHfEndpointSetting = vi.hoisted(() => vi.fn())
const setHfEndpointSetting = vi.hoisted(() => vi.fn())
const hub = vi.hoisted(() => ({
  app: () => ({ getHfEndpointSetting, setHfEndpointSetting }),
}))
vi.mock('@/hooks/useServiceHub', () => ({ useServiceHub: () => hub }))
const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }))

import { HfEndpointSetting, modeOf } from '../HfEndpointSetting'

describe('HfEndpointSetting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setHfEndpointSetting.mockResolvedValue(undefined)
  })

  it('maps a saved endpoint to its choice', () => {
    expect(modeOf('')).toBe('default')
    expect(modeOf('https://hf-mirror.com/')).toBe('mirror')
    expect(modeOf('https://mirror.example')).toBe('custom')
  })

  it('saves hf-mirror.com without the token by default', async () => {
    getHfEndpointSetting.mockResolvedValue({ endpoint: '', sendTokenToMirror: false, envOverride: null })
    render(<HfEndpointSetting />)
    await waitFor(() => expect(getHfEndpointSetting).toHaveBeenCalled())
    fireEvent.click(screen.getByText('hf-mirror.com'))
    await waitFor(() =>
      expect(setHfEndpointSetting).toHaveBeenCalledWith('https://hf-mirror.com', false)
    )
    // The token opt-in appears for a mirror and starts off.
    expect(screen.getByText('settings:general.hfEndpointSendToken')).toBeTruthy()
  })

  it('shows a custom endpoint and says when HF_ENDPOINT overrides it', async () => {
    getHfEndpointSetting.mockResolvedValue({
      endpoint: 'https://mirror.example',
      sendTokenToMirror: true,
      envOverride: 'https://env.example',
    })
    render(<HfEndpointSetting />)
    expect(
      await screen.findByText('settings:general.hfEndpointEnvOverride:https://env.example')
    ).toBeTruthy()
    expect((screen.getByPlaceholderText('https://mirror.example.com') as HTMLInputElement).value).toBe(
      'https://mirror.example'
    )
  })

  it('reports a rejected URL', async () => {
    getHfEndpointSetting.mockResolvedValue({ endpoint: 'https://mirror.example', sendTokenToMirror: false, envOverride: null })
    setHfEndpointSetting.mockRejectedValue('The Hugging Face endpoint must use https')
    render(<HfEndpointSetting />)
    const input = await screen.findByDisplayValue('https://mirror.example')
    fireEvent.change(input, { target: { value: 'http://plain.example' } })
    fireEvent.click(screen.getByText('settings:general.hfEndpointSave'))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(setHfEndpointSetting).toHaveBeenCalledWith('http://plain.example', false)
  })
})
