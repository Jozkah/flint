import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { AddonStatus } from '@/services/engineAddon'

const here = vi.hoisted(() => ({ available: true }))
const api = vi.hoisted(() => ({
  status: vi.fn(),
  check: vi.fn(),
  download: vi.fn(),
  cancel: vi.fn(),
  installFile: vi.fn(),
  remove: vi.fn(),
  verify: vi.fn(),
  onProgress: vi.fn(),
}))

vi.mock('@/services/engineAddon', async (orig) => {
  const real = await orig<typeof import('@/services/engineAddon')>()
  return { ...real, addonsAvailableHere: () => here.available, engineAddon: api }
})
vi.mock('@/i18n/react-i18next-compat', async () => {
  const i18n = (await import('@/i18n/setup')).default
  return {
    useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => i18n.t(k, o) }),
  }
})
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ dialog: () => ({ open: vi.fn().mockResolvedValue('C:/packs/p.zip') }) }),
}))
vi.mock('@/hooks/useLlamacppDevices', () => ({
  useLlamacppDevices: (sel: (s: { fetchDevices: () => void }) => unknown) => sel({ fetchDevices: vi.fn() }),
}))
vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  },
}))

import { EngineAddonOffer, EngineAddonPanel } from '@/containers/EngineAddon'
import { useEngineAddon, offerView } from '@/hooks/useEngineAddon'
import { useAppState } from '@/hooks/useAppState'

function status(over: Partial<AddonStatus> = {}): AddonStatus {
  return {
    supported: true,
    signing_configured: true,
    kind: 'cuda13',
    release_tag: 'v0.9.0',
    eligibility: 'eligible',
    driver_version: '617.12',
    min_driver: 580,
    installed: [],
    in_use: null,
    restart_pending: false,
    downloading: false,
    ...over,
  }
}

const installed = {
  kind: 'cuda13',
  release_tag: 'v0.9.0',
  engine_tag: 'b11627',
  size: 734003200,
  dir: 'C:/data/engine-addons/cuda13-v0.9.0',
  compatible: true,
  problem: null,
}

function reset(s: AddonStatus, extra: Partial<ReturnType<typeof useEngineAddon.getState>> = {}) {
  useEngineAddon.setState({
    status: s,
    remote: null,
    phase: 'idle',
    progress: null,
    error: null,
    modelLoadedOnce: true,
    justInstalled: false,
    neverRemind: false,
    dismissedFor: null,
    driverNoticeFor: null,
    ...extra,
  })
}

beforeEach(() => {
  here.available = true
  for (const fn of Object.values(api)) fn.mockReset()
  api.onProgress.mockResolvedValue(() => undefined)
  api.cancel.mockResolvedValue(undefined)
  api.check.mockRejectedValue(new Error(JSON.stringify({ code: 'not_published', message: 'x' })))
  useAppState.setState({ activeModels: [] })
})

describe('offerView', () => {
  const base = {
    status: status(),
    phase: 'idle' as const,
    neverRemind: false,
    dismissedFor: null,
    driverNoticeFor: null,
    modelLoadedOnce: true,
    justInstalled: false,
  }
  it('offers on an eligible machine once a model has loaded', () => {
    expect(offerView(base)).toBe('offer')
    expect(offerView({ ...base, modelLoadedOnce: false })).toBeNull()
  })
  it('says nothing on AMD, Intel, old NVIDIA GPUs, unknown drivers or CUDA builds', () => {
    for (const eligibility of ['no_nvidia', 'gpu_too_old', 'driver_unknown', 'already_bundled', 'unsupported_platform'] as const) {
      expect(offerView({ ...base, status: status({ eligibility }) })).toBeNull()
    }
  })
  it('turns an old driver into an update notice, once per release', () => {
    const s = status({ eligibility: 'driver_too_old', driver_version: '566.36' })
    expect(offerView({ ...base, status: s })).toBe('driver')
    expect(offerView({ ...base, status: s, driverNoticeFor: 'v0.9.0' })).toBeNull()
  })
  it('respects "Not now" for this release and "Don\'t remind me" for good', () => {
    expect(offerView({ ...base, dismissedFor: 'v0.9.0' })).toBeNull()
    expect(offerView({ ...base, dismissedFor: 'v0.8.0' })).toBe('offer')
    expect(offerView({ ...base, neverRemind: true })).toBeNull()
  })
  it('stops offering once a usable add-on is installed, but offers it again for a broken one', () => {
    expect(offerView({ ...base, status: status({ installed: [installed] }) })).toBeNull()
    expect(
      offerView({ ...base, status: status({ installed: [{ ...installed, compatible: false }] }) })
    ).toBe('offer')
  })
  it('follows a running download whatever else is set', () => {
    expect(offerView({ ...base, neverRemind: true, phase: 'downloading' })).toBe('progress')
    expect(offerView({ ...base, phase: 'failed' })).toBe('failed')
    expect(
      offerView({ ...base, justInstalled: true, status: status({ installed: [installed] }) })
    ).toBe('installed')
    // Removed since: the "installed" note goes away.
    expect(offerView({ ...base, justInstalled: true })).toBe('offer')
  })
  it('a build without the signing key never offers', () => {
    expect(offerView({ ...base, status: status({ supported: false, signing_configured: false }) })).toBeNull()
  })
})

describe('EngineAddonOffer', () => {
  it('shows the offer with an honest benefit line and downloads only on click', async () => {
    reset(status())
    api.status.mockResolvedValue(status())
    render(<EngineAddonOffer />)
    const card = await screen.findByTestId('engine-addon-offer')
    expect(card.dataset.view).toBe('offer')
    expect(card.textContent).toMatch(/usually run faster/)
    expect(card.textContent).toMatch(/10-70%/)
    expect(api.download).not.toHaveBeenCalled()
    api.download.mockResolvedValue(installed)
    api.status.mockResolvedValue(status({ installed: [installed], restart_pending: true }))
    await act(async () => {
      fireEvent.click(screen.getByText('Download'))
    })
    expect(api.download).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('engine-addon-offer').dataset.view).toBe('installed')
    expect(screen.getByTestId('engine-addon-offer').textContent).toMatch(/next model load/)
  })

  it('resets the phase and shows the error when the progress listener cannot attach', async () => {
    reset(status())
    api.onProgress.mockRejectedValue(new Error(JSON.stringify({ code: 'io', message: 'listen failed' })))
    const ok = await useEngineAddon.getState().download()
    expect(ok).toBe(false)
    expect(api.download).not.toHaveBeenCalled()
    expect(useEngineAddon.getState().phase).toBe('failed')
    expect(useEngineAddon.getState().error?.message).toBe('listen failed')
  })

  it('shows progress with a cancel button while downloading', () => {
    reset(status(), {
      phase: 'downloading',
      progress: { phase: 'download', received: 100 * 1048576, total: 700 * 1048576 },
    })
    api.status.mockResolvedValue(status())
    render(<EngineAddonOffer />)
    const card = screen.getByTestId('engine-addon-offer')
    expect(card.dataset.view).toBe('progress')
    expect(card.textContent).toMatch(/Vulkan is used meanwhile/)
    fireEvent.click(screen.getByText('Cancel'))
    expect(api.cancel).toHaveBeenCalled()
  })

  it('reports a failed verification without an error dialog and offers a retry', () => {
    reset(status(), { phase: 'failed', error: { code: 'corrupt', message: 'x' } })
    api.status.mockResolvedValue(status())
    render(<EngineAddonOffer />)
    const card = screen.getByTestId('engine-addon-offer')
    expect(card.dataset.view).toBe('failed')
    expect(card.textContent).toMatch(/did not pass verification/)
    expect(screen.getByText('Try again')).toBeTruthy()
  })

  it('"Don\'t remind me" hides it for good', () => {
    reset(status())
    api.status.mockResolvedValue(status())
    render(<EngineAddonOffer />)
    fireEvent.click(screen.getByText("Don't remind me"))
    expect(useEngineAddon.getState().neverRemind).toBe(true)
    expect(screen.queryByTestId('engine-addon-offer')).toBeNull()
  })

  it('renders nothing in the browser client or flint serve', () => {
    here.available = false
    reset(status())
    render(<EngineAddonOffer />)
    expect(screen.queryByTestId('engine-addon-offer')).toBeNull()
    expect(api.status).not.toHaveBeenCalled()
  })
})

describe('EngineAddonPanel', () => {
  it('lists the installed add-on with remove, file install and check', async () => {
    const s = status({ installed: [installed], in_use: installed.dir })
    reset(s, { phase: 'installed' })
    api.status.mockResolvedValue(s)
    render(<EngineAddonPanel />)
    const panel = await screen.findByTestId('engine-addon-panel')
    expect(panel.textContent).toMatch(/Installed: v0\.9\.0/)
    expect(panel.textContent).toMatch(/in use/)
    expect(screen.getByText('Remove')).toBeTruthy()
    expect(screen.getByText('Install from file...')).toBeTruthy()
    api.remove.mockResolvedValue(undefined)
    api.status.mockResolvedValue(status())
    await act(async () => {
      fireEvent.click(screen.getByText('Remove'))
    })
    expect(api.remove).toHaveBeenCalled()
  })

  it('installs a picked file through the same verification', async () => {
    reset(status())
    api.status.mockResolvedValue(status())
    api.installFile.mockResolvedValue(installed)
    render(<EngineAddonPanel />)
    await act(async () => {
      fireEvent.click(screen.getByText('Install from file...'))
    })
    expect(api.installFile).toHaveBeenCalledWith('C:/packs/p.zip')
  })

  it('is absent on machines with nothing to offer', () => {
    const s = status({ eligibility: 'no_nvidia' })
    reset(s)
    api.status.mockResolvedValue(s)
    render(<EngineAddonPanel />)
    expect(screen.queryByTestId('engine-addon-panel')).toBeNull()
  })

  it('says to update an old driver and offers no download', () => {
    const s = status({ eligibility: 'driver_too_old', driver_version: '566.36' })
    reset(s)
    api.status.mockResolvedValue(s)
    render(<EngineAddonPanel />)
    const panel = screen.getByTestId('engine-addon-panel')
    expect(panel.textContent).toMatch(/Update your NVIDIA driver/)
    expect(panel.textContent).toMatch(/566\.36/)
    expect(screen.queryByText('Download')).toBeNull()
  })
})
