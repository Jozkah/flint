import { describe, it, expect, vi } from 'vitest'
import { useEffect, useRef, useState } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) =>
      opts ? `${k}#${Object.values(opts).join(',')}` : k,
  }),
}))
const convertFileSrc = vi.fn((p: string) => `asset://${p}`)
const hub = {
  app: () => ({ getJanDataFolder: async () => '/mock/data' }),
  core: () => ({ convertFileSrc }),
}
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => hub,
  getServiceHub: () => hub,
}))
vi.mock('shiki', () => ({ codeToHtml: vi.fn(async (c: string) => `<pre>${c}</pre>`) }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }))
vi.mock('@janhq/tauri-plugin-agent-tools-api', () => ({
  projectListDir: vi.fn(async () => ({ entries: [], truncated: false })),
  projectReadFile: vi.fn(async () => ({
    relPath: 'app.ts',
    size: 10,
    content: 'a\nb\nc\n',
    oversized: false,
    binary: false,
  })),
}))
// A stand-in editor: one button per change marker, and the peek element
// mounted where CodeMirror would place it under the change.
vi.mock('@/components/CodeEditor', () => ({
  default: function Editor({
    hunks,
    onHunk,
    peek,
  }: {
    hunks?: { start: number; kind: string }[]
    onHunk?: (h: unknown) => void
    peek?: { dom: HTMLElement } | null
  }) {
    const host = useRef<HTMLDivElement>(null)
    useEffect(() => {
      if (peek && host.current) host.current.appendChild(peek.dom)
      else if (host.current) host.current.replaceChildren()
    }, [peek])
    return (
      <div>
        {(hunks ?? []).map((h) => (
          <button
            key={h.start}
            data-testid={`marker-${h.kind}-${h.start}`}
            onClick={() => onHunk?.(h)}
          />
        ))}
        <div data-testid="peek-host" ref={host} />
      </div>
    )
  },
}))

import { projectReadFile } from '@janhq/tauri-plugin-agent-tools-api'
import { CoworkCodePanel } from '../CoworkCodePanel'
import {
  emptyCodePanelState,
  openTab,
  projectKeyOf,
  projectTab,
  type CodePanelState,
} from '@/lib/coworkCode'

const ROOT = '/home/dev/project'
const KEY = projectKeyOf(ROOT) as string
vi.stubGlobal(
  'fetch',
  vi.fn(async () => ({ ok: true, text: async () => 'a\nB\nc\n', headers: new Headers() }))
)

function Harness({
  onApply,
  onHunk = vi.fn(async () => 'applied' as const),
}: {
  onApply: (p: string) => void
  onHunk?: (p: string, expected: string, content: string) => Promise<'applied' | 'changed'>
}) {
  const [state, setState] = useState<CodePanelState>(
    openTab(emptyCodePanelState(), projectTab('app.ts', KEY))
  )
  return (
    <>
      <span data-testid="tabs">{state.tabs.map((t) => t.origin.kind).join(',')}</span>
      <CoworkCodePanel
        folder={ROOT}
        workspacePath="/ws/s1"
        sessionKey="s1"
        state={state}
        onStateChange={setState}
        onAddToChat={vi.fn()}
        onAttach={vi.fn()}
        onClose={vi.fn()}
        editAccess={{ destination: 'sandbox', writeGrant: null }}
        readRoot={ROOT}
        sandboxCopyFor={(p) => (p === 'app.ts' ? 'project/app.ts' : null)}
        onApplySandboxCopy={onApply}
        onApplySandboxHunk={onHunk}
      />
    </>
  )
}

async function peekAt(marker = 'marker-modified-2') {
  const found = await screen.findByTestId(marker)
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
  fireEvent.click(found)
  return within(screen.getByTestId('peek-host')).findByTestId('hunk-popover')
}

const readFile = vi.mocked(projectReadFile)
const real = (content: string) => ({
  relPath: 'app.ts', size: content.length, content, oversized: false, binary: false,
})

describe('sandbox changes on the real file', () => {
  it('peeks only the change, as markers then an inline diff', async () => {
    render(<Harness onApply={vi.fn()} />)
    await screen.findByTestId('marker-modified-2')
    expect(screen.queryByTestId('hunk-popover')).toBeNull()
    const peek = await peekAt()
    // Only the lines: no title row.
    expect(peek.textContent?.replace(/\s+/g, '')).toBe('-b+B')
    expect(within(peek).getByTestId('peek-apply-hunk')).toHaveAttribute(
      'title',
      'common:codePanel.applyHunk'
    )
    fireEvent.click(screen.getByTestId('marker-modified-2'))
    expect(screen.queryByTestId('hunk-popover')).toBeNull()
  })

  it('applies just that change to the re-read file', async () => {
    const onHunk = vi.fn(async () => 'applied' as const)
    render(<Harness onApply={vi.fn()} onHunk={onHunk} />)
    const peek = await peekAt()
    readFile.mockResolvedValueOnce(real('a\nb\nc\nd\n'))
    await act(async () => {
      fireEvent.click(within(peek).getByTestId('peek-apply-hunk'))
    })
    expect(onHunk).toHaveBeenCalledWith('app.ts', 'a\nb\nc\nd\n', 'a\nB\nc\nd\n')
  })

  it('writes nothing and says so when those lines changed', async () => {
    const onHunk = vi.fn(async () => 'applied' as const)
    render(<Harness onApply={vi.fn()} onHunk={onHunk} />)
    const peek = await peekAt()
    readFile.mockResolvedValueOnce(real('a\nbee\nc\n'))
    await act(async () => {
      fireEvent.click(within(peek).getByTestId('peek-apply-hunk'))
    })
    expect(onHunk).not.toHaveBeenCalled()
    expect(peek).toHaveTextContent('common:codePanel.hunkConflict')
  })

  it('asks before replacing the whole file', async () => {
    const onApply = vi.fn()
    render(<Harness onApply={onApply} />)
    const peek = await peekAt()
    fireEvent.click(within(peek).getByTestId('peek-apply-whole'))
    expect(onApply).not.toHaveBeenCalled()
    fireEvent.click(within(peek).getByTestId('peek-apply-whole-confirm'))
    expect(onApply).toHaveBeenCalledWith('app.ts')
  })

  it('opens the whole sandbox copy from the header', async () => {
    render(<Harness onApply={vi.fn()} />)
    fireEvent.click(await screen.findByTestId('open-sandbox-copy'))
    expect(screen.getByTestId('tabs')).toHaveTextContent('project,sandbox')
  })
})
