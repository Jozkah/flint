import { expect, afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import * as matchers from '@testing-library/jest-dom/matchers'

// extends Vitest's expect method with methods from react-testing-library
expect.extend(matchers)

// Create a mock ServiceHub
const mockServiceHub = {
  theme: () => ({
    getTheme: vi.fn().mockReturnValue('light'),
    setTheme: vi.fn(),
    toggleTheme: vi.fn(),
  }),
  window: vi.fn().mockReturnValue({
    minimize: vi.fn(),
    maximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn().mockResolvedValue(false),
    openLogsWindow: vi.fn().mockResolvedValue(undefined),
  }),
  events: () => ({
    emit: vi.fn().mockResolvedValue(undefined),
    listen: vi.fn().mockResolvedValue(() => {}),
  }),
  hardware: () => ({
    getHardwareInfo: vi.fn().mockResolvedValue(null),
    getSystemUsage: vi.fn().mockResolvedValue(null),
    getLlamacppDevices: vi.fn().mockResolvedValue([]), // cspell: disable-line
    setActiveGpus: vi.fn().mockResolvedValue(undefined),
    refreshHardwareInfo: vi.fn().mockResolvedValue(undefined),
    // Legacy methods for backward compatibility
    getGpuInfo: vi.fn().mockResolvedValue([]),
    getCpuInfo: vi.fn().mockResolvedValue({}),
    getMemoryInfo: vi.fn().mockResolvedValue({}),
  }),
  app: () => ({
    getAppSettings: vi.fn().mockResolvedValue({}),
    updateAppSettings: vi.fn().mockResolvedValue(undefined),
    getSystemInfo: vi.fn().mockResolvedValue({}),
    relocateJanDataFolder: vi.fn().mockResolvedValue(undefined),
    getJanDataFolder: vi.fn().mockResolvedValue('/mock/jan/data'),
    getUnavailableJanDataFolder: vi.fn().mockResolvedValue(undefined),
  }),
  messages: () => ({
    createMessage: vi.fn().mockResolvedValue({ id: 'test-message' }),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    getMessages: vi.fn().mockResolvedValue([]),
    getMessage: vi.fn().mockResolvedValue(null),
    fetchMessages: vi.fn().mockResolvedValue([]),
  }),
  mcp: () => ({
    updateMCPConfig: vi.fn().mockResolvedValue(undefined),
    restartMCPServers: vi.fn().mockResolvedValue(undefined),
    getMCPConfig: vi.fn().mockResolvedValue({}),
    getTools: vi.fn().mockResolvedValue([]),
    getConnectedServers: vi.fn().mockResolvedValue([]),
    callTool: vi.fn().mockResolvedValue({ error: '', content: [] }),
    callToolWithCancellation: vi.fn().mockReturnValue({
      promise: Promise.resolve({ error: '', content: [] }),
      cancel: vi.fn().mockResolvedValue(undefined),
      token: 'test-token'
    }),
    cancelToolCall: vi.fn().mockResolvedValue(undefined),
    // AH-041: server trust lives in the backend.
    trustedServers: vi.fn().mockResolvedValue([]),
    trustReport: vi.fn().mockResolvedValue({ trusted: [], invalidated: [] }),
    serverFingerprints: vi.fn().mockResolvedValue({}),
    trustServer: vi.fn().mockResolvedValue(undefined),
    revokeServer: vi.fn().mockResolvedValue(undefined),
    forgetServer: vi.fn().mockResolvedValue(undefined),
    allowOnceForServer: vi.fn().mockResolvedValue('ticket-test'),
    activateMCPServer: vi.fn().mockResolvedValue(undefined),
    deactivateMCPServer: vi.fn().mockResolvedValue(undefined),
  }),
  threads: () => ({
    createThread: vi.fn().mockResolvedValue({ id: 'test-thread', messages: [] }),
    deleteThread: vi.fn().mockResolvedValue(undefined),
    updateThread: vi.fn().mockResolvedValue(undefined),
    getThreads: vi.fn().mockResolvedValue([]),
    getThread: vi.fn().mockResolvedValue(null),
    fetchThreads: vi.fn().mockResolvedValue([]),
  }),
  providers: () => ({
    getProviders: vi.fn().mockResolvedValue([]),
    createProvider: vi.fn().mockResolvedValue({ id: 'test-provider' }),
    deleteProvider: vi.fn().mockResolvedValue(undefined),
    updateProvider: vi.fn().mockResolvedValue(undefined),
    getProvider: vi.fn().mockResolvedValue(null),
    fetchModelsFromProvider: vi.fn().mockResolvedValue([]),
  }),
  models: () => ({
    getModels: vi.fn().mockResolvedValue([]),
    getModel: vi.fn().mockResolvedValue(null),
    createModel: vi.fn().mockResolvedValue({ id: 'test-model' }),
    deleteModel: vi.fn().mockResolvedValue(undefined),
    updateModel: vi.fn().mockResolvedValue(undefined),
    startModel: vi.fn().mockResolvedValue(undefined),
    getActiveModels: vi.fn().mockResolvedValue([]),
    isModelSupported: vi.fn().mockResolvedValue('GREEN'),
    checkMmprojExists: vi.fn().mockResolvedValue(true), // cspell: disable-line
    stopAllModels: vi.fn().mockResolvedValue(undefined),
  }),
  assistants: () => ({
    getAssistants: vi.fn().mockResolvedValue([]),
    getAssistant: vi.fn().mockResolvedValue(null),
    createAssistant: vi.fn().mockResolvedValue({ id: 'test-assistant' }),
    deleteAssistant: vi.fn().mockResolvedValue(undefined),
    updateAssistant: vi.fn().mockResolvedValue(undefined),
  }),
  dialog: () => ({
    open: vi.fn().mockResolvedValue({ confirmed: true }),
    save: vi.fn().mockResolvedValue('/path/to/file'),
    message: vi.fn().mockResolvedValue(undefined),
  }),
  opener: vi.fn().mockReturnValue({
    open: vi.fn().mockResolvedValue(undefined),
    revealItemInDir: vi.fn().mockResolvedValue(undefined),
    openPath: vi.fn().mockResolvedValue(undefined),
    openUrl: vi.fn().mockResolvedValue(undefined),
  }),
  updater: () => ({
    checkForUpdates: vi.fn().mockResolvedValue(null),
    installUpdate: vi.fn().mockResolvedValue(undefined),
    downloadAndInstallWithProgress: vi.fn().mockResolvedValue(undefined),
  }),
  path: vi.fn().mockReturnValue({
    sep: () => '/',
    join: vi.fn((...args) => args.join('/')),
    resolve: vi.fn((path) => path),
    dirname: vi.fn((path) => path.split('/').slice(0, -1).join('/')),
    basename: vi.fn((path) => path.split('/').pop()),
  }),
  core: () => ({
    startCore: vi.fn().mockResolvedValue(undefined),
    stopCore: vi.fn().mockResolvedValue(undefined),
    getCoreStatus: vi.fn().mockResolvedValue('stopped'),
  }),
  deeplink: () => ({ // cspell: disable-line
    register: vi.fn().mockResolvedValue(undefined),
    handle: vi.fn().mockResolvedValue(undefined),
    getCurrent: vi.fn().mockResolvedValue(null),
    onOpenUrl: vi.fn().mockResolvedValue(undefined),
  }),
}

// Mock the useServiceHub module
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => mockServiceHub,
  getServiceHub: () => mockServiceHub,
  // The transports read the hub off the store in their constructor, so an
  // incomplete mock here makes the class impossible to instantiate in a test.
  useServiceStore: {
    getState: () => ({ serviceHub: mockServiceHub }),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
  initializeServiceHubStore: vi.fn(),
  isServiceHubInitialized: () => true,
}))

// Radix's floating primitives (Tooltip, Popover, Select) measure with
// ResizeObserver, which jsdom does not implement. Stubbed globally rather than
// per test file, where it was already copied three times.
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

// Mock window.matchMedia for useMediaQuery tests
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(), // deprecated
    removeListener: vi.fn(), // deprecated
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

// Mock globalThis.core.api for @janhq/core functions // cspell: disable-line
;(globalThis as Record<string, unknown>).core = {
  api: {
    getJanDataFolderPath: vi.fn().mockResolvedValue('/mock/jan/data'),
    openFileExplorer: vi.fn().mockResolvedValue(undefined),
    joinPath: vi.fn((...paths: string[]) => paths.join('/')),
  }
}

// Mock globalThis.fs for @janhq/core fs functions // cspell: disable-line
;(globalThis as Record<string, unknown>).fs = {
  existsSync: vi.fn().mockResolvedValue(false),
  readFile: vi.fn().mockResolvedValue(''),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  mkdir: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  rmdir: vi.fn().mockResolvedValue(undefined),
}


// runs a cleanup after each test case (e.g. clearing jsdom)
afterEach(() => {
  cleanup()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.clearAllMocks()
})

/**
 * jsdom's `Blob`/`File` have no `text()`, which every browser and both
 * webviews provide. Without it a component test that reads a dropped or
 * picked file fails on the environment rather than on the code — hiding the
 * production read path instead of exercising it.
 *
 * `FileReader` decodes the way the platform does: UTF-8, substituting U+FFFD
 * for undecodable bytes rather than throwing, so a binary file still reads
 * back as one and the binary check is tested for real.
 */
if (typeof Blob !== 'undefined' && typeof Blob.prototype.text !== 'function') {
  Blob.prototype.text = function text(this: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(reader.error)
      reader.onload = () => resolve(String(reader.result))
      reader.readAsText(this)
    })
  }
}

/**
 * jsdom does no layout, so Range and Text nodes have no client rects.
 * ProseMirror measures through them when it scrolls the cursor into view and
 * throws inside a timer, where the test cannot catch it.
 */
const emptyRects = (): DOMRectList =>
  Object.assign([] as unknown as DOMRectList, { item: () => null })
if (typeof Range !== 'undefined') {
  if (typeof Range.prototype.getClientRects !== 'function') {
    Range.prototype.getClientRects = emptyRects
  }
  if (typeof Range.prototype.getBoundingClientRect !== 'function') {
    Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0)
  }
}
if (typeof Text !== 'undefined') {
  const text = Text.prototype as unknown as { getClientRects?: () => DOMRectList }
  if (typeof text.getClientRects !== 'function') text.getClientRects = emptyRects
}
