import { beforeEach, describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { useVisualizeConfig } from '@/hooks/useVisualizeConfig'
import {
  executeVisualizeTool,
  parseShowWidgetInput,
  resetVisualizeState,
  visualizeSchemas,
} from '../tools'
import {
  MAX_WIDGET_CODE_CHARS,
  MAX_WIDGETS_PER_RUN,
  READ_ME_TOOL,
  SHOW_WIDGET_TOOL,
} from '../constants'
import { buildGuide } from '../guide'
import { normalizeWidgetCode, partialMarkup } from '../code'
import {
  buildStandalonePage,
  buildWidgetShell,
  parseFrameMessage,
  widgetCsp,
  WIDGET_SANDBOX,
} from '../document'
import {
  checkOpenLink,
  checkSendPrompt,
  newBridgeState,
  PROMPT_MIN_INTERVAL_MS,
} from '../bridge'
import { OMITTED_WIDGET_CODE, truncateStaleWidgetCode } from '../history'
import { readThemeSnapshot } from '../themeVars'
import { coworkToolsFromSchemas } from '@/lib/coworkTools'

beforeEach(() => {
  resetVisualizeState()
  useVisualizeConfig.setState({ enabled: true, allowCdn: false, maxHeight: 640 })
})

describe('schemas', () => {
  it('keeps the schema footprint small and requires what it needs', () => {
    const [readMe, show] = visualizeSchemas()
    expect(readMe.function.name).toBe(READ_ME_TOOL)
    expect(show.function.name).toBe(SHOW_WIDGET_TOOL)
    expect(show.function.parameters.required).toEqual(['title', 'widget_code'])
    expect(JSON.stringify(visualizeSchemas()).length).toBeLessThan(2600)
  })
})

describe('parseShowWidgetInput', () => {
  it('accepts a fragment, trims the title and caps loading messages', () => {
    const r = parseShowWidgetInput({
      title: '  Flow  ',
      loading_messages: ['a', 'b', 'c', 'd', 'e', 7, ''],
      widget_code: '<div>hi</div>',
    })
    expect(r).toEqual({
      ok: true,
      value: { title: 'Flow', loadingMessages: ['a', 'b', 'c', 'd'], code: '<div>hi</div>' },
    })
  })
  it.each([null, 'x', [], {}, { widget_code: 5 }, { widget_code: '   ' }])(
    'refuses malformed input %j',
    (input) => {
      expect(parseShowWidgetInput(input).ok).toBe(false)
    }
  )
  it('rejects a huge payload with a clear error', () => {
    const r = parseShowWidgetInput({
      title: 't',
      widget_code: 'x'.repeat(MAX_WIDGET_CODE_CHARS + 1),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/limit is 200000/)
  })
  it('strips document wrappers and a markdown fence', () => {
    const r = parseShowWidgetInput({
      title: 't',
      widget_code:
        '```html\n<!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://x"></head><body><p>a</p></body></html>\n```',
    })
    expect(r.ok && r.value.code).toBe('<p>a</p>')
  })
  it('falls back to a heading for a missing title', () => {
    const r = parseShowWidgetInput({ widget_code: '<h2>Latency</h2><p>x</p>' })
    expect(r.ok && r.value.title).toBe('Latency')
  })
})

describe('executeVisualizeTool', () => {
  it('teaches the chart module to draw gridlines first and keep a label margin', () => {
    const guide = executeVisualizeTool(READ_ME_TOOL, { modules: ['chart'] }, 'c1')
    expect(guide.content).toContain('gridlines first')
    expect(guide.content).toContain('left margin')
  })

  it('returns the guide for read_me and a short result for show_widget', () => {
    const guide = executeVisualizeTool(READ_ME_TOOL, { modules: ['chart'] }, 'c1')
    expect(guide.content).toContain('## chart')
    expect(guide.content).not.toContain('## diagram')
    const shown = executeVisualizeTool(
      SHOW_WIDGET_TOOL,
      { title: 'T', widget_code: '<div>' + 'y'.repeat(5000) + '</div>' },
      'c1'
    )
    expect(shown.content).toBe('Widget rendered: T, 5011 chars.')
  })
  it('hints at the guide when it was not read', () => {
    const r = executeVisualizeTool(
      SHOW_WIDGET_TOOL,
      { title: 'T', widget_code: '<p>a</p>' },
      'c2'
    )
    expect(r.content).toContain(READ_ME_TOOL)
  })
  it('refuses while the setting is off', () => {
    useVisualizeConfig.setState({ enabled: false })
    expect(executeVisualizeTool(READ_ME_TOOL, { modules: [] }, 'c').error).toMatch(
      /turned off/
    )
  })
  it('limits widgets per run', () => {
    const call = (n: number) =>
      executeVisualizeTool(
        SHOW_WIDGET_TOOL,
        { title: 'T', widget_code: '<p>a</p>' },
        'c3',
        1000 + n
      )
    for (let i = 0; i < MAX_WIDGETS_PER_RUN; i++) expect(call(i).error).toBeUndefined()
    expect(call(9).error).toMatch(/Too many widgets/)
    expect(
      executeVisualizeTool(SHOW_WIDGET_TOOL, { title: 'T', widget_code: '<p>a</p>' }, 'c3', 1000 + 999_999)
        .error
    ).toBeUndefined()
  })
  it('tells the model about invalid modules', () => {
    expect(buildGuide(['nope'])).toContain('No valid module')
  })
})

describe('tool registration gating', () => {
  const widgetTools = (on: boolean) => {
    useVisualizeConfig.setState({ enabled: on })
    return Object.keys(
      coworkToolsFromSchemas([], {
        planMode: false,
        webSearch: false,
        allowSubagents: false,
        subagentNames: [],
      })
    )
  }
  it('advertises both tools only when the setting is on', () => {
    expect(widgetTools(true)).toEqual(expect.arrayContaining([READ_ME_TOOL, SHOW_WIDGET_TOOL]))
    expect(widgetTools(false)).not.toContain(SHOW_WIDGET_TOOL)
  })
})

describe('sandbox, CSP and shell', () => {
  it('never grants same-origin and blocks the network', () => {
    expect(WIDGET_SANDBOX).toBe('allow-scripts')
    expect(WIDGET_SANDBOX).not.toContain('allow-same-origin')
    const csp = widgetCsp(false)
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("frame-src 'none'")
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("script-src 'unsafe-inline'")
    expect(csp).not.toMatch(/https?:/)
  })
  it('adds exactly the two CDN hosts to script-src when allowed', () => {
    const csp = widgetCsp(true)
    expect(csp).toContain(
      "script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net"
    )
    expect(csp).toContain("connect-src 'none'")
    expect(csp.match(/https:\/\//g)).toHaveLength(2)
  })
  it('puts the policy before any other content and carries the prelude', () => {
    const shell = buildWidgetShell(false)
    expect(shell.indexOf('Content-Security-Policy')).toBeLessThan(shell.indexOf('<style>'))
    expect(shell).toContain('window.flint=')
    expect(shell).toContain('--foreground')
    expect(shell).toContain('data-theme=dark')
  })
  it('standalone page keeps scripts and embeds the theme', () => {
    const page = buildStandalonePage('A<b>', '<script>1</script>', { '--background': '#fff', 'x;y': '1' }, true)
    expect(page).toContain('<script>1</script>')
    expect(page).toContain('--background:#fff')
    expect(page).not.toContain('x;y')
    expect(page).toContain('data-theme="dark"')
  })
  it('reads the live theme tokens', () => {
    document.documentElement.style.setProperty('--primary', '#123456')
    document.documentElement.classList.add('dark')
    const snap = readThemeSnapshot()
    expect(snap.vars['--primary']).toBe('#123456')
    expect(snap.dark).toBe(true)
    expect(snap.vars['--radius']).toMatch(/px$/)
    document.documentElement.classList.remove('dark')
    document.documentElement.style.removeProperty('--primary')
  })
})

describe('frame messages and bridge', () => {
  it('parses only well-formed messages', () => {
    expect(parseFrameMessage({ flint: 1, op: 'height', h: 120 })).toEqual({ op: 'height', h: 120 })
    expect(parseFrameMessage({ flint: 1, op: 'height', h: NaN })).toBeNull()
    expect(parseFrameMessage({ op: 'height', h: 1 })).toBeNull()
    expect(parseFrameMessage({ flint: 1, op: 'eval', code: 'x' })).toBeNull()
    expect(parseFrameMessage('hello')).toBeNull()
  })
  it('ignores sendPrompt without a user gesture', () => {
    const s = newBridgeState()
    expect(checkSendPrompt('hi', { userActive: false, now: 10_000 }, s)).toEqual({
      ok: false,
      reason: 'no-gesture',
    })
    expect(s.sent).toBe(0)
  })
  it('accepts one gesture-backed prompt, then rate-limits', () => {
    const s = newBridgeState()
    expect(checkSendPrompt(' go ', { userActive: true, now: 10_000 }, s)).toEqual({ ok: true, text: 'go' })
    expect(checkSendPrompt('again', { userActive: true, now: 10_000 + 100 }, s)).toEqual({
      ok: false,
      reason: 'rate-limited',
    })
    expect(
      checkSendPrompt('later', { userActive: true, now: 10_000 + PROMPT_MIN_INTERVAL_MS }, s).ok
    ).toBe(true)
  })
  it('rejects empty and oversized prompts', () => {
    const s = newBridgeState()
    expect(checkSendPrompt('  ', { userActive: true, now: 1e6 }, s).ok).toBe(false)
    expect(checkSendPrompt('x'.repeat(2001), { userActive: true, now: 1e6 }, s)).toEqual({
      ok: false,
      reason: 'too-long',
    })
  })
  it('only opens http(s) links after a gesture', () => {
    expect(checkOpenLink('https://example.com/a', { userActive: true })).toEqual({
      ok: true,
      url: 'https://example.com/a',
    })
    expect(checkOpenLink('https://example.com', { userActive: false }).ok).toBe(false)
    expect(checkOpenLink('file:///c:/x', { userActive: true }).ok).toBe(false)
    expect(checkOpenLink('javascript:alert(1)', { userActive: true }).ok).toBe(false)
    expect(checkOpenLink('https://u:p@example.com', { userActive: true }).ok).toBe(false)
  })
})

describe('partial streaming gate', () => {
  it('waits for a whole element', () => {
    expect(partialMarkup('<div class="a')).toBeNull()
    expect(partialMarkup('<div')).toBeNull()
    expect(partialMarkup('<div class="card"><h3>Title</h3>')).toBe('<div class="card"><h3>Title</h3>')
  })
  it('drops an unfinished script, style, comment or tag', () => {
    expect(partialMarkup('<p>some text here</p><script>var a = 1; ali')).toBe('<p>some text here</p>')
    expect(partialMarkup('<p>some text here</p><style>.a{col')).toBe('<p>some text here</p>')
    expect(partialMarkup('<p>some text here</p><!-- note')).toBe('<p>some text here</p>')
    expect(partialMarkup('<p>some text here</p><sp')).toBe('<p>some text here</p>')
  })
  it('keeps finished scripts in the markup (they stay inert until final)', () => {
    expect(partialMarkup('<p>some text here</p><script>1</script>')).toContain('<script>1</script>')
  })
  it('normalises wrappers', () => {
    expect(normalizeWidgetCode('<body><p>x</p></body>')).toBe('<p>x</p>')
  })
})

describe('truncateStaleWidgetCode', () => {
  const big = '<div>' + 'z'.repeat(2000) + '</div>'
  const widgetMsg = (id: string): UIMessage =>
    ({
      id,
      role: 'assistant',
      parts: [
        {
          type: `tool-${SHOW_WIDGET_TOOL}`,
          toolCallId: id,
          state: 'output-available',
          input: { title: 'T', widget_code: big },
          output: 'Widget rendered',
        },
      ],
    }) as unknown as UIMessage
  const user = (id: string): UIMessage =>
    ({ id, role: 'user', parts: [{ type: 'text', text: 'q' }] }) as UIMessage
  const codeOf = (m: UIMessage) =>
    ((m.parts[0] as unknown as { input: { widget_code: string } }).input.widget_code)

  it('keeps the newest turns whole and shortens older widgets', () => {
    const history = [user('u1'), widgetMsg('a1'), user('u2'), widgetMsg('a2'), user('u3'), widgetMsg('a3')]
    const out = truncateStaleWidgetCode(history)
    expect(codeOf(out[1])).toBe(OMITTED_WIDGET_CODE(big.length))
    expect(codeOf(out[3])).toBe(big)
    expect(codeOf(out[5])).toBe(big)
    // The stored message is untouched.
    expect(codeOf(history[1])).toBe(big)
    expect(out[3]).toBe(history[3])
  })
  it('is idempotent', () => {
    const history = [user('u1'), widgetMsg('a1'), user('u2'), user('u3')]
    const once = truncateStaleWidgetCode(history)
    expect(truncateStaleWidgetCode(once)[1]).toBe(once[1])
  })
})
