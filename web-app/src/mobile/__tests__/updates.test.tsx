import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { Shell } from '../shell/Shell'
import { app, openDrawer, openSheet } from '../state/app'
import type { Route } from '../state/router'
import type { ChatDetails } from '@/lib/remote/protocol'
import { resetApp, useFixtures } from './helpers'
import fx from './fixtures.json'

const T = { timeout: 3000 }

const details: ChatDetails = {
  id: 'c1',
  model: { id: 'qwen3-8b', provider: 'llamacpp', name: 'Qwen3 8B' },
  modelMissing: false,
  assistant: { id: 'jan', name: 'Flint', auto: true },
  effort: { levels: ['low', 'medium', 'high', 'xhigh'], recommended: 'xhigh', canDisable: true, value: 'high', overridden: true },
  context: {
    usedTokens: 12300,
    windowTokens: 32000,
    autoCompactOn: true,
    buffer: 3200,
    segments: [
      { id: 'messages', label: 'Messages', tokens: 8000, color: '#3b82f6' },
      { id: 'mcpTools', label: 'MCP tools', tokens: 4300, color: '#10b981' },
    ],
  },
  speed: { last: 41.2, average: 38.9 },
  lastRequest: { inputTokens: 6214, outputTokens: 412, cachedInputTokens: 6000 },
  sections: [
    { id: 'model', title: 'Model', items: [{ label: 'qwen3-8b', detail: 'llamacpp', state: 'Sent with every message' }] },
    { id: 'tools', title: 'Tools', items: [{ label: 'web_search', state: 'Available' }] },
  ],
  serversOff: ['github'],
  files: [{ name: 'forecast.go', state: 'Attached' }],
  canCompact: true,
}

const thread = fx.rpc['thread.messages'].c1 as { messages: Record<string, unknown>[]; start: number; total: number }
const withMeta = {
  ...thread,
  messages: thread.messages.map((m) =>
    m.role === 'assistant'
      ? { ...m, meta: { assistant: 'Quartz', tokensPerSecond: 41.2, outputTokens: 412, cache: 'reused', draft: { accepted: 270, tokens: 380 }, skills: ['acme:go-testing', 'pr-writer'] } }
      : m
  ),
}

const extra = {
  'chat.details': details,
  'thread.messages': { ...fx.rpc['thread.messages'], c1: withMeta },
  'assistants.list': { assistants: [{ id: 'jan', name: 'Flint', builtIn: true }, { id: 'quartz', name: 'Quartz', builtIn: true }, { id: 'coal', name: 'Coal', builtIn: true }], routing: true },
  'chat.effort': { ok: true },
  'chat.assistant': { ok: true },
  'chat.fork': { id: 'c9' },
  'chat.compact': { started: true },
  'title.regenerate': { result: 'done' },
  'room.clear': { ok: true },
  'run.stop': { stopped: 3 },
  'cowork.files': { root: '/home/jo/acme', entries: [{ name: 'internal', relPath: 'internal', isDir: true }, { name: 'go.mod', relPath: 'go.mod', isDir: false }], truncated: false },
  'cowork.file': { path: 'go.mod', status: 'ready', content: 'module acme\n\nfunc main() {\n  return "x"\n}', changed: { 3: 'add', 4: 'mod' }, language: 'Go', touched: ['go.mod'] },
  'cowork.preview': { artifacts: ['radar.html'], path: 'radar.html', kind: 'html', content: '<h1>acme-weather radar</h1>' },
  'models.downloads': { tasks: [{ id: 'd1', label: 'gemma-3-4b', status: 'downloading', progress: 0.62, downloaded: 2.1e9, total: 3.4e9, bytesPerSecond: 18.4e6 }] },
  'hf.search': {
    models: [{ repo: 'Qwen/Qwen3-8B-GGUF', author: 'Qwen', downloads: 120000, likes: 900, tags: ['gguf'], pipelineTag: 'text-generation', installed: true, variants: [{ quant: 'Q4_K_M', sizeBytes: 5e9, fits: true }, { quant: 'Q8_0', sizeBytes: 8.7e9, fits: false }] }],
    device: { name: 'RTX 4070', vramBytes: 8 * 1024 ** 3 },
  },
  'hf.download': { ok: true, id: 'hf:llamacpp:x' },
  'settings.get': {
    ...fx.rpc['settings.get'],
    automation: { routeAssistants: true, activateSkills: false },
    webSearch: { enabled: true, provider: 'duckduckgo' },
    webSearchProviders: [
      { id: 'duckduckgo', name: 'DuckDuckGo', needsKey: false, configured: true },
      { id: 'brave', name: 'Brave', needsKey: true, configured: false },
    ],
  },
}

function show(route: Route) {
  resetApp(route)
  return render(<Shell />)
}

describe('desktop updates #30–#87 on the phone', () => {
  let client: ReturnType<typeof useFixtures>
  beforeEach(() => {
    client = useFixtures(extra)
  })

  it('Chat composer: a single + with add items and Options, the context ring only, and the row under it', async () => {
    show({ name: 'chat', id: 'c1' })
    expect(await screen.findByTestId('effort-button', {}, T)).toHaveTextContent('High')
    expect(screen.queryByText('Options')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Web Search' })).toBeNull()
    const ring = screen.getByTestId('context-ring')
    expect(ring.textContent).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Add and options' }))
    for (const t of ['Photo library', 'Reference a file (@)', 'Assistant', 'Sampling', 'Tools', 'Web search', 'Reasoning']) {
      expect(await screen.findByText(t)).toBeInTheDocument()
    }
    expect(screen.queryByText('Commands & skills')).toBeNull()
  })

  it('Cowork + adds Commands & skills; no inline Options or Web search', async () => {
    show({ name: 'cowork', id: 'w1' })
    await screen.findByText(/I'll read the radar client/, {}, T)
    expect(screen.queryByText('Options')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add and options' }))
    expect(await screen.findByText('Commands & skills')).toBeInTheDocument()
  })

  it('Effort sheet: stops with Off, Recommended under the default, applying through chat.effort', async () => {
    show({ name: 'chat', id: 'c1' })
    fireEvent.click(await screen.findByTestId('effort-button', {}, T))
    const group = await screen.findByRole('radiogroup', { name: 'Effort' })
    const labels = within(group).getAllByRole('radio').map((r) => r.getAttribute('aria-label'))
    expect(labels[0]).toBe('Off')
    expect(labels).toHaveLength(5)
    expect(screen.getByText('Recommended')).toBeInTheDocument()
    fireEvent.click(within(group).getByRole('radio', { name: 'Off' }))
    expect(client.rpc).toHaveBeenCalledWith('chat.effort', { id: 'c1', choice: 'off' })
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(client.rpc).toHaveBeenCalledWith('chat.effort', { id: 'c1', choice: null })
  })

  it('Context ring opens the Context window card with the buffer, free space, compaction and Draft accepted', async () => {
    show({ name: 'chat', id: 'c1' })
    await screen.findByTestId('effort-button', {}, T)
    fireEvent.click(screen.getByTestId('context-ring'))
    const card = await screen.findByTestId('context-card')
    for (const t of ['Messages', 'MCP tools', 'Autocompact buffer', 'Free space', 'Avg. speed']) expect(within(card).getByText(t)).toBeInTheDocument()
    expect(within(card).getByText(/until auto-compact/)).toBeInTheDocument()
    expect(screen.getByText('Draft accepted')).toBeInTheDocument()
    fireEvent.click(within(card).getByRole('button', { name: 'Compact session' }))
    expect(client.rpc).toHaveBeenCalledWith('chat.compact', { id: 'c1' })
  })

  it('Reply row: assistant name, speed · tokens · cache, Used N skills, and Fork chat from here', async () => {
    show({ name: 'chat', id: 'c1' })
    const row = (await screen.findAllByTestId('reply-row', {}, T))[0]
    expect(row).toHaveTextContent('41.2 t/s · 412 tokens · cached')
    expect(screen.getAllByText('Quartz').length).toBeGreaterThan(0)
    fireEvent.click(within(row).getByText('Used 2 skills'))
    expect(await screen.findByText('go-testing')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Fork chat from here' })[0])
    await screen.findByText('Forked into a new chat.', {}, T)
    expect(client.rpc).toHaveBeenCalledWith('chat.fork', expect.objectContaining({ id: 'c1', messageId: expect.any(String) }))
    expect(app.get().route).toEqual({ name: 'chat', id: 'c9' })
  })

  it('Assistant picker offers Auto and the built-ins, and sets one through chat.assistant', async () => {
    show({ name: 'chat', id: 'c1' })
    await screen.findByTestId('effort-button', {}, T)
    openSheet('assistant', { for: 'chat', id: 'c1' })
    expect(await screen.findByText('Auto')).toBeInTheDocument()
    fireEvent.click(await screen.findByText('Coal'))
    expect(client.rpc).toHaveBeenCalledWith('chat.assistant', { id: 'c1', assistant: 'coal' })
  })

  it('Menus: Regenerate title and Fork in the chat menu; Stop all in this chat; Clear this room', async () => {
    show({ name: 'chat', id: 'c1' })
    await screen.findByTestId('effort-button', {}, T)
    openSheet('threadmenu', { id: 'c1', title: 'Forecast' })
    fireEvent.click(await screen.findByText('Regenerate title'))
    expect(client.rpc).toHaveBeenCalledWith('title.regenerate', { kind: 'chat', id: 'c1' })
    openSheet('threadmenu', { id: 'c1', title: 'Forecast' })
    expect(await screen.findByText('Fork chat')).toBeInTheDocument()
    openSheet('stop', { kind: 'chat', id: 'c1' })
    window.confirm = () => true
    fireEvent.click(await screen.findByText('Stop all in this chat'))
    expect(client.rpc).toHaveBeenCalledWith('run.stop', { kind: 'chat', id: 'c1', scope: 'chat' })
    openSheet('clearroom', { id: 'r1' })
    fireEvent.click(await screen.findByText('Chat and knowledge'))
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(client.rpc).toHaveBeenCalledWith('room.clear', { id: 'r1', scope: 'knowledge' })
  })

  it('A model that is gone shows the notice and its sheet', async () => {
    client = useFixtures({ ...extra, 'chat.details': { ...details, modelMissing: true } })
    show({ name: 'chat', id: 'c1' })
    const notice = await screen.findByTestId('model-gone', {}, T)
    fireEvent.click(within(notice).getByRole('button', { name: 'Choose a model' }))
    expect(await screen.findByText('This chat')).toBeInTheDocument()
  })

  it('Permission details lists Allow all temporarily when the computer offers it', async () => {
    show({ name: 'chat', id: 'c1' })
    await screen.findByTestId('effort-button', {}, T)
    openSheet('permdetails', {
      approval: { requestId: 'ap9', threadId: 'c1', toolName: 'git', title: 'Push', consequences: [], argumentsJson: '{}', scopes: [{ scope: 'once', label: 'Allow once', explanation: 'Only this', broader: false }, { scope: 'temporary', label: 'Allow all temporarily', explanation: 'Git remote operations', broader: true }] },
    })
    expect(await screen.findByText('Allow all temporarily')).toBeInTheDocument()
  })

  it('Right panel: What Flint is using with the off server, and the Context tab', async () => {
    show({ name: 'chat', id: 'c1' })
    await screen.findByTestId('effort-button', {}, T)
    openDrawer('right', 'using')
    expect(await screen.findByText('github is off')).toBeInTheDocument()
    expect(screen.getByText('Last request')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Files (1)' }))
    expect(await screen.findByText('forecast.go')).toBeInTheDocument()
  })

  it('Cowork Code tab: explorer sheet, tabs, change markers; Preview tab frames the artifact', async () => {
    show({ name: 'cowork', id: 'w1' })
    await screen.findByText(/I'll read the radar client/, {}, T)
    openDrawer('right', 'code')
    fireEvent.click(await screen.findByRole('button', { name: /Project explorer/ }))
    fireEvent.click(await screen.findByText('go.mod'))
    const code = await screen.findByTestId('code-view', {}, T)
    expect(code.querySelector('.cl.gadd')).not.toBeNull()
    expect(code.querySelector('.cl.gmod')).not.toBeNull()
    expect(code.querySelector('.kw')?.textContent).toBe('func')
    expect(screen.getByRole('button', { name: /Add to chat/ })).toBeDisabled()
    app.set({ rightTab: 'preview' })
    const frame = await screen.findByTestId('preview-frame', {}, T)
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
  })

  it('Models shows download progress and Browse Hugging Face starts a download', async () => {
    show({ name: 'models' })
    const card = await screen.findByTestId('download-card', {}, T)
    expect(card).toHaveTextContent('18.4 MB/s')
    expect(card).toHaveTextContent('left')
    fireEvent.click(screen.getByRole('button', { name: /Browse Hugging Face/ }))
    expect(await screen.findByText('Qwen3-8B-GGUF', {}, T)).toBeInTheDocument()
    expect(screen.getByText(/Best for this device/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Download Q4_K_M' }))
    expect(client.rpc).toHaveBeenCalledWith('hf.download', { repo: 'Qwen/Qwen3-8B-GGUF', quant: 'Q4_K_M' })
  })

  it('Settings: Web Search lists DuckDuckGo needing no setup; Jev shows Automatic choices', async () => {
    const first = show({ name: 'settings-sub', sub: 'websearch' })
    expect(await screen.findByText('DuckDuckGo needs no setup', {}, T)).toBeInTheDocument()
    first.unmount()
    show({ name: 'settings-sub', sub: 'jev' })
    expect(await screen.findByText('Automatic choices', {}, T)).toBeInTheDocument()
    expect(screen.getByTestId('auto-apply')).toHaveAttribute('aria-checked', 'false')
  })
})

