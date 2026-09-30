import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import '@testing-library/jest-dom'

// ---- Module mocks ----------------------------------------------------------

const hoisted = vi.hoisted(() => ({
  providersMock: {
    getProviderByName: vi.fn(() => ({ models: [] })),
    selectModelProvider: vi.fn(),
    setProviders: vi.fn(),
  },
  startEngineSetupMock: vi.fn().mockResolvedValue(undefined),
  verifyGpuOffloadMock: vi.fn(),
  verifyEmbeddingModelMock: vi.fn(),
  getHardwareInfoMock: vi.fn(),
  navigateMock: vi.fn(),
  eventHandlers: {} as Record<string, any>,
  toastMock: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
  },
}))

vi.mock('sonner', () => ({ toast: hoisted.toastMock }))

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: () => hoisted.providersMock,
}))

vi.mock('@/hooks/useServiceHub', () => {
  const stub = () => ({
    models: () => ({
      isModelSupported: vi.fn().mockResolvedValue('GREEN'),
      startEngineSetup: hoisted.startEngineSetupMock,
      verifyGpuOffload: hoisted.verifyGpuOffloadMock,
      verifyEmbeddingModel: hoisted.verifyEmbeddingModelMock,
    }),
    providers: () => ({
      getProviders: vi.fn().mockResolvedValue([]),
    }),
    hardware: () => ({ getHardwareInfo: hoisted.getHardwareInfoMock }),
  })
  return { useServiceHub: stub, getServiceHub: stub }
})

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: any) => opts?.defaultValue ?? k,
  }),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => hoisted.navigateMock,
}))

vi.mock('@janhq/core', () => ({
  AppEvent: { onModelImported: 'onModelImported' },
  DownloadEvent: { onFileDownloadSuccess: 'onFileDownloadSuccess' },
  events: {
    on: vi.fn((name: string, handler: any) => {
      hoisted.eventHandlers[name] = handler
    }),
    off: vi.fn(),
  },
}))

vi.mock('@/constants/localStorage', () => ({
  localStorageKey: {
    setupCompleted: 'sc',
    lastUsedModel: 'lum',
  },
}))

vi.mock('@/constants/routes', () => ({
  route: {
    home: '/',
    cowork: '/cowork',
    settings: {
      providers: '/settings/providers/$providerName',
      model_providers: '/settings/providers',
    },
  },
}))

vi.mock('@/containers/HeaderPage', () => ({
  default: () => <header data-testid="header-page" />,
}))
vi.mock('../HeaderPage', () => ({
  default: () => <header data-testid="header-page" />,
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, ...rest }: any) => (
    <button onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
}))

import SetupScreen from '../SetupScreen'
import { useOnboardingGuide } from '@/hooks/useOnboardingGuide'
import { INITIAL_GUIDE_STATE } from '@/lib/onboarding'

// The readiness probes resolve after mount, so flush them before asserting to
// keep pending state updates out of the test.
const renderSetup = async () => {
  const utils = render(<SetupScreen />)
  await act(async () => {})
  return utils
}

/** Passes the welcome gate, which is where the flow now begins. */
const start = async () => {
  await act(async () => {
    fireEvent.click(screen.getByText('setup:startSetup'))
  })
}

const renderStarted = async () => {
  const utils = await renderSetup()
  await start()
  return utils
}

/** Advances past the llama.cpp setup page, which never auto-advances. */
const continueSetup = async () => {
  await act(async () => {
    fireEvent.click(
      screen.getByText(/setup:(continueStep|continueAnyway|skipStep)/)
    )
  })
}

const renderPastSetup = async () => {
  const utils = await renderStarted()
  await continueSetup()
  return utils
}

const currentPage = () =>
  screen.getByTestId('setup-wizard').getAttribute('data-page')

describe('SetupScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hoisted.providersMock.getProviderByName.mockReturnValue({ models: [] })
    hoisted.eventHandlers = {}
    // Healthy by default, so the wizard reaches the last page; individual
    // tests opt into a warning to hold an earlier one.
    hoisted.getHardwareInfoMock.mockResolvedValue({
      cpu: { name: 'Ryzen 7 5800X' },
      gpus: [{ name: 'RTX 4070', driver_version: '550.54' }],
    })
    hoisted.verifyGpuOffloadMock.mockResolvedValue({
      status: 'ok',
      backend: 'linux-cuda-12-common_cpus-x64',
      gpuExpected: true,
      engineDeviceCount: 1,
    })
    hoisted.verifyEmbeddingModelMock.mockResolvedValue({
      status: 'ok',
      modelId: 'sentence-transformer-mini',
      dimension: 384,
    })
    localStorage.clear()
    // The guide store is a module singleton; each test starts a fresh setup.
    useOnboardingGuide.setState({ ...INITIAL_GUIDE_STATE })
  })

  it('renders the header page component', async () => {
    await renderStarted()
    expect(screen.getByTestId('header-page')).toBeInTheDocument()
  })

  it('starts no engine download on mount', async () => {
    await renderStarted()
    expect(hoisted.startEngineSetupMock).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('setup-model-card')).not.toBeInTheDocument()
  })

  it('runs the engine and embedding probes on mount', async () => {
    await renderStarted()
    expect(hoisted.verifyGpuOffloadMock).toHaveBeenCalled()
    expect(hoisted.verifyEmbeddingModelMock).toHaveBeenCalled()
  })

  it('routes all visible copy through i18n', async () => {
    await renderStarted()
    expect(screen.queryByText('Hey, welcome to Jan!')).not.toBeInTheDocument()
    expect(screen.queryByText('Recommended model')).not.toBeInTheDocument()
    expect(screen.queryByText('Download')).not.toBeInTheDocument()
  })

  describe('welcome gate', () => {
    it('opens on the welcome page', async () => {
      await renderSetup()

      expect(currentPage()).toBe('welcome')
      expect(screen.getByText('setup:welcomeTitle')).toBeInTheDocument()
      expect(screen.getByText('setup:startSetup')).toBeInTheDocument()
    })

    // The first page is an invitation, not a progress report: nothing is probed
    // until the user asks for it.
    it('probes nothing until the user starts', async () => {
      await renderSetup()

      expect(hoisted.verifyGpuOffloadMock).not.toHaveBeenCalled()
      expect(hoisted.verifyEmbeddingModelMock).not.toHaveBeenCalled()
      expect(hoisted.getHardwareInfoMock).not.toHaveBeenCalled()
    })

    it('begins the checks on start', async () => {
      await renderSetup()
      await start()

      expect(hoisted.verifyGpuOffloadMock).toHaveBeenCalled()
      expect(hoisted.verifyEmbeddingModelMock).toHaveBeenCalled()
    })

    // The engine's own provisioning is hundreds of megabytes. It used to run at
    // app launch regardless, which made asking pointless.
    it('does not provision the engine until the user starts', async () => {
      await renderSetup()

      expect(hoisted.startEngineSetupMock).not.toHaveBeenCalled()
    })

    it('provisions the engine on start', async () => {
      await renderSetup()
      await start()

      expect(hoisted.startEngineSetupMock).toHaveBeenCalledTimes(1)
    })

    it('offers no model download at all', async () => {
      await renderSetup()

      expect(screen.queryByTestId('setup-model-card')).not.toBeInTheDocument()
      expect(screen.queryByText('setup:download')).not.toBeInTheDocument()
    })
  })

  describe('GPU badge', () => {
    const holdSetupPage = () =>
      hoisted.verifyEmbeddingModelMock.mockResolvedValue({
        status: 'ok',
        pending: true,
      })

    it('names the GPU when offload is confirmed', async () => {
      holdSetupPage()

      await renderStarted()

      expect(currentPage()).toBe('setup')
      expect(screen.getByTestId('setup-gpu-badge').textContent).toContain(
        'setup:badgeGpu'
      )
    })

    // A GPU build that found no device runs on the CPU regardless of its name,
    // so the device count decides rather than the backend label.
    it('says CPU when a GPU build sees no device', async () => {
      holdSetupPage()
      hoisted.verifyGpuOffloadMock.mockResolvedValue({
        status: 'warning',
        backend: 'linux-cuda-12-common_cpus-x64',
        gpuExpected: true,
        engineDeviceCount: 0,
        reason: 'runtimeUnreachable',
      })

      await renderStarted()

      expect(screen.getByTestId('setup-gpu-badge').textContent).toContain(
        'setup:badgeCpu'
      )
    })

    it('says CPU for a CPU-only build', async () => {
      holdSetupPage()
      hoisted.getHardwareInfoMock.mockResolvedValue({
        cpu: { name: 'Ryzen 7 5800X' },
        gpus: [],
      })
      hoisted.verifyGpuOffloadMock.mockResolvedValue({
        status: 'ok',
        backend: 'linux-common_cpus-x64',
        gpuExpected: false,
        engineDeviceCount: 0,
      })

      await renderStarted()

      expect(screen.getByTestId('setup-gpu-badge').textContent).toContain(
        'setup:badgeCpu'
      )
    })

    // Neither answer is known until the engine has a backend.
    it('stays undecided while the engine is still setting up', async () => {
      hoisted.verifyGpuOffloadMock.mockResolvedValue({
        status: 'ok',
        backend: '',
        gpuExpected: false,
        engineDeviceCount: 0,
        pending: true,
      })

      await renderStarted()

      expect(screen.getByTestId('setup-gpu-badge').textContent).toContain(
        'setup:badgeGpuUnknown'
      )
    })
  })

  describe('one page at a time', () => {
    it('shows only the current page', async () => {
      await renderPastSetup()

      expect(currentPage()).toBe('finish')
      // Settled check pages are gone rather than stacked above this one.
      expect(screen.queryByText('setup:stageSetup')).not.toBeInTheDocument()
      expect(screen.queryByTestId('setup-gpu-badge')).not.toBeInTheDocument()
    })

    it('holds the setup page while the engine is still setting up', async () => {
      hoisted.verifyGpuOffloadMock.mockResolvedValue({
        status: 'ok',
        backend: '',
        gpuExpected: false,
        engineDeviceCount: 0,
        pending: true,
      })

      await renderStarted()

      expect(currentPage()).toBe('setup')
      expect(screen.getByText('setup:checkEnginePreparing')).toBeInTheDocument()
    })

    it('holds the setup page while the embedding check is pending', async () => {
      hoisted.verifyEmbeddingModelMock.mockResolvedValue({
        status: 'ok',
        pending: true,
      })

      await renderStarted()

      expect(currentPage()).toBe('setup')
    })

    it('reports position within the flow', async () => {
      await renderStarted()
      expect(screen.getByTestId('setup-step-counter')).toBeInTheDocument()
    })

    // Auto-advancing skipped this page whenever the engine was already
    // installed, hiding the GPU badge.
    it('does not advance past the setup page on its own', async () => {
      await renderStarted()

      expect(currentPage()).toBe('setup')
      expect(screen.getByTestId('setup-gpu-badge')).toBeInTheDocument()
    })

    it('offers Continue once the setup work is done', async () => {
      await renderStarted()

      expect(screen.getByText('setup:continueStep')).toBeInTheDocument()
    })

    it('offers a skip while the setup work is still running', async () => {
      hoisted.verifyGpuOffloadMock.mockResolvedValue({
        status: 'ok',
        backend: '',
        gpuExpected: false,
        engineDeviceCount: 0,
        pending: true,
      })

      await renderStarted()

      expect(screen.getByText('setup:skipStep')).toBeInTheDocument()
    })

    // An engine page can sit for the length of a backend download, so waiting
    // must never be the only option.
    it('lets the user skip a page that is still running', async () => {
      hoisted.verifyGpuOffloadMock.mockResolvedValue({
        status: 'ok',
        backend: '',
        gpuExpected: false,
        engineDeviceCount: 0,
        pending: true,
      })

      await renderStarted()
      expect(currentPage()).toBe('setup')

      fireEvent.click(screen.getByText('setup:skipStep'))

      expect(currentPage()).toBe('finish')
    })
  })

  describe('warnings', () => {
    const armEngineWarning = () =>
      hoisted.verifyGpuOffloadMock.mockResolvedValue({
        status: 'warning',
        backend: 'linux-cuda-12-common_cpus-x64',
        gpuExpected: true,
        engineDeviceCount: 0,
        reason: 'runtimeUnreachable',
        error: 'device probe exploded',
      })

    it('holds the page that warned', async () => {
      armEngineWarning()

      await renderStarted()

      expect(currentPage()).toBe('setup')
      expect(
        screen.getByText('setup:checkEngineRuntimeUnreachable')
      ).toBeInTheDocument()
      expect(screen.getByTestId('setup-page-warning')).toBeInTheDocument()
    })

    it('advances past it on Continue', async () => {
      armEngineWarning()

      await renderStarted()
      fireEvent.click(screen.getByText('setup:continueAnyway'))

      expect(currentPage()).toBe('finish')
    })

    it('offers a re-run of the checks', async () => {
      armEngineWarning()

      await renderStarted()
      await act(async () => {
        fireEvent.click(screen.getByText('setup:retryChecks'))
      })

      expect(hoisted.verifyGpuOffloadMock).toHaveBeenCalledTimes(2)
    })

    it('exposes the raw failure detail behind a disclosure', async () => {
      armEngineWarning()

      await renderStarted()
      expect(screen.queryByText(/device probe exploded/)).not.toBeInTheDocument()

      fireEvent.click(screen.getByText('setup:showDetails'))

      expect(screen.getByText(/device probe exploded/)).toBeInTheDocument()
    })

    it('shows dependency install advice inline instead of as a dialog', async () => {
      hoisted.verifyGpuOffloadMock.mockResolvedValue({
        status: 'warning',
        backend: 'linux-cuda-12-common_cpus-x64',
        gpuExpected: true,
        engineDeviceCount: 0,
        reason: 'missingLibrary',
        missingLibraries: ['libnccl.so.2'],
      })

      await renderStarted()

      expect(screen.getByTestId('dependency-advice')).toBeInTheDocument()
    })

    it('shows no advice when no libraries are named', async () => {
      armEngineWarning()

      await renderStarted()

      expect(screen.queryByTestId('dependency-advice')).not.toBeInTheDocument()
    })
  })

  describe('finish page', () => {
    it('says when the app reaches the network', async () => {
      await renderPastSetup()

      expect(currentPage()).toBe('finish')
      expect(screen.getByText('setup:finishBody')).toBeInTheDocument()
    })

    it('offers no download and no catalogue', async () => {
      await renderPastSetup()

      expect(screen.queryByTestId('setup-model-card')).not.toBeInTheDocument()
      expect(screen.queryByText('setup:download')).not.toBeInTheDocument()
    })

    it('links to Discover without starting a download', async () => {
      await renderPastSetup()

      expect(screen.getByTestId('setup-finish-discover')).toBeInTheDocument()
    })

    it('lists the models already on disk', async () => {
      hoisted.providersMock.getProviderByName.mockReturnValue({
        models: [{ id: 'local-a.gguf' }, { id: 'local-b.gguf' }],
      })

      await renderPastSetup()

      expect(
        screen.getAllByTestId('setup-local-model').map((o) => o.textContent)
      ).toEqual(['local-a.gguf', 'local-b.gguf'])
    })

    it('shows a model by the name the user gave it', async () => {
      hoisted.providersMock.getProviderByName.mockReturnValue({
        models: [{ id: 'local-a.gguf', displayName: 'Daily driver' }],
      })

      await renderPastSetup()

      expect(screen.getByTestId('setup-local-model')).toHaveTextContent(
        'Daily driver'
      )
    })

    it('leaves out the embedding model Flint installs for itself', async () => {
      hoisted.providersMock.getProviderByName.mockReturnValue({
        models: [
          { id: 'all-MiniLM-L6-v2', embedding: true },
          { id: 'local-a.gguf' },
        ],
      })
      await renderPastSetup()

      expect(
        screen.getAllByTestId('setup-local-model').map((o) => o.textContent)
      ).toEqual(['local-a.gguf'])
    })

    it('offers no model when only the embedding model is installed', async () => {
      hoisted.providersMock.getProviderByName.mockReturnValue({
        models: [{ id: 'all-MiniLM-L6-v2', embedding: true }],
      })
      await renderPastSetup()

      expect(screen.queryAllByTestId('setup-local-model')).toHaveLength(0)
      expect(screen.getByText('setup:finishNoModels')).toBeInTheDocument()
    })

    it('explains what to do when there are none', async () => {
      await renderPastSetup()

      expect(screen.queryAllByTestId('setup-local-model')).toHaveLength(0)
      expect(screen.getByText('setup:finishNoModels')).toBeInTheDocument()
    })

    it('marks the chosen model, and only that one', async () => {
      hoisted.providersMock.getProviderByName.mockReturnValue({
        models: [{ id: 'local-a.gguf' }, { id: 'local-b.gguf' }],
      })

      await renderPastSetup()
      const options = screen.getAllByTestId('setup-local-model')
      expect(
        options.every((o) => o.getAttribute('aria-checked') === 'false')
      ).toBe(true)

      await act(async () => {
        fireEvent.click(options[0])
      })

      expect(options[0]).toHaveAttribute('aria-checked', 'true')
      expect(options[1]).toHaveAttribute('aria-checked', 'false')
    })

    it('sends the user to the local provider to import one', async () => {
      await renderPastSetup()

      await act(async () => {
        fireEvent.click(screen.getByTestId('setup-finish-import'))
      })

      expect(hoisted.navigateMock).toHaveBeenCalledWith({
        to: '/settings/providers/$providerName',
        params: { providerName: 'llamacpp' },
      })
    })

    it('offers nothing that fetches', async () => {
      await renderPastSetup()
      expect(screen.queryByTestId('setup-model-card')).not.toBeInTheDocument()
      expect(screen.getByTestId('setup-finish-start')).toBeInTheDocument()
    })
  })

  describe('step numbering', () => {
    it('counts the three pages the wizard has', async () => {
      await renderSetup()

      expect(
        screen.getByTestId('setup-wizard').querySelectorAll('span.h-1').length
      ).toBe(3)
    })
  })

  describe('leaving setup', () => {
    it('finishes without a model, and says so on the button', async () => {
      await renderPastSetup()

      expect(screen.getByTestId('setup-finish-start')).toHaveTextContent(
        'setup:finishWithoutModel'
      )
      await act(async () => {
        fireEvent.click(screen.getByTestId('setup-finish-start'))
      })

      expect(localStorage.getItem('sc')).toBe('true')
      expect(hoisted.navigateMock).toHaveBeenCalledWith(
        expect.objectContaining({ to: '/', search: {} })
      )
      // Nothing was chosen, so nothing is remembered as last used.
      expect(localStorage.getItem('lum')).toBeNull()
    })

    it('starts on the model the user picked', async () => {
      hoisted.providersMock.getProviderByName.mockReturnValue({
        models: [{ id: 'local-a.gguf' }, { id: 'local-b.gguf' }],
      })

      await renderPastSetup()
      await act(async () => {
        fireEvent.click(screen.getAllByTestId('setup-local-model')[1])
      })
      await act(async () => {
        fireEvent.click(screen.getByTestId('setup-finish-start'))
      })

      expect(hoisted.providersMock.selectModelProvider).toHaveBeenCalledWith(
        'llamacpp',
        'local-b.gguf'
      )
      expect(localStorage.getItem('lum')).toBe(
        JSON.stringify({ provider: 'llamacpp', model: 'local-b.gguf' })
      )
    })

    it('does not leave on its own', async () => {
      // Earlier versions ended the flow for the user as soon as a download
      // landed. There is no such moment now: finishing is a decision.
      hoisted.providersMock.getProviderByName.mockReturnValue({
        models: [{ id: 'local-a.gguf' }],
      })

      await renderPastSetup()

      expect(currentPage()).toBe('finish')
      expect(hoisted.navigateMock).not.toHaveBeenCalled()
    })

    it('completes after an acknowledged warning', async () => {
      hoisted.verifyEmbeddingModelMock.mockResolvedValue({
        status: 'warning',
        modelId: 'sentence-transformer-mini',
        problem: 'empty',
      })

      await renderStarted()
      expect(currentPage()).toBe('setup')
      await continueSetup()
      expect(currentPage()).toBe('finish')

      await act(async () => {
        fireEvent.click(screen.getByTestId('setup-finish-start'))
      })
      expect(hoisted.navigateMock).toHaveBeenCalled()
    })
  })

  describe('first-run guide', () => {
    it('offers three intentions and starts the guide with the chosen one', async () => {
      await renderSetup()
      expect(screen.getAllByRole('radio')).toHaveLength(3)
      await act(async () => {
        fireEvent.click(screen.getByTestId('setup-intent-documents'))
      })
      expect(screen.getByTestId('setup-intent-documents')).toHaveAttribute(
        'aria-checked',
        'true'
      )
      await start()
      expect(useOnboardingGuide.getState()).toMatchObject({
        status: 'in-progress',
        intent: 'documents',
        setupPage: 'setup',
      })
    })

    it('moves and selects intentions with arrow keys, as a radio group does', async () => {
      await renderSetup()
      const group = screen.getByRole('radiogroup')
      await act(async () => {
        fireEvent.keyDown(group, { key: 'ArrowDown' })
      })
      expect(screen.getByTestId('setup-intent-question')).toHaveAttribute('aria-checked', 'true')
      expect(screen.getByTestId('setup-intent-question')).toHaveFocus()
      await act(async () => {
        fireEvent.keyDown(group, { key: 'ArrowUp' })
      })
      expect(screen.getByTestId('setup-intent-project')).toHaveAttribute('aria-checked', 'true')
      expect(useOnboardingGuide.getState().intent).toBe('project')
    })

    it('lets the user skip the guide without skipping setup', async () => {
      await renderSetup()
      await act(async () => {
        fireEvent.click(screen.getByTestId('setup-skip-guide'))
      })
      expect(useOnboardingGuide.getState().status).toBe('skipped')
      expect(hoisted.startEngineSetupMock).toHaveBeenCalledTimes(1)
      expect(currentPage()).not.toBe('welcome')
    })

    it('explains local and remote processing and links to remote setup', async () => {
      await renderPastSetup()
      expect(screen.getByTestId('setup-processing')).toHaveTextContent(
        'onboarding:processingLocal'
      )
      await act(async () => {
        fireEvent.click(screen.getByTestId('setup-connect-remote'))
      })
      expect(hoisted.navigateMock).toHaveBeenCalledWith({
        to: '/settings/providers',
      })
    })

    it('resumes on the page it was left on', async () => {
      useOnboardingGuide.setState({ setupPage: 'finish', status: 'in-progress' })
      await renderSetup()
      expect(currentPage()).toBe('finish')
      expect(screen.getByTestId('setup-resumed')).toBeInTheDocument()
    })

    it('takes project work to Cowork with the chosen local model', async () => {
      hoisted.providersMock.getProviderByName.mockReturnValue({
        models: [{ id: 'local-a.gguf' }],
      })
      await renderSetup()
      await act(async () => {
        fireEvent.click(screen.getByTestId('setup-intent-project'))
      })
      await start()
      await continueSetup()
      await act(async () => {
        fireEvent.click(screen.getAllByTestId('setup-local-model')[0])
      })
      await act(async () => {
        fireEvent.click(screen.getByTestId('setup-finish-start'))
      })
      expect(hoisted.providersMock.selectModelProvider).toHaveBeenCalledWith(
        'llamacpp',
        'local-a.gguf'
      )
      expect(hoisted.navigateMock).toHaveBeenCalledWith({
        to: '/cowork',
        replace: true,
      })
      expect(useOnboardingGuide.getState().setupPage).toBe('welcome')
    })
  })
})
