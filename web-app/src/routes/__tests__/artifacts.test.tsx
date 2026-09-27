/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import React from 'react'

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  selectSession: vi.fn(),
  requestPreview: vi.fn(),
  openPath: vi.fn(),
  revealItemInDir: vi.fn(),
  existsSync: vi.fn(),
  sessions: [] as any[],
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: any) => ({ ...config, id: '/artifacts' }),
  useNavigate: () => h.navigate,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/constants/routes', () => ({
  route: { artifacts: '/artifacts', cowork: '/cowork' },
}))

vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: any) => <header>{children}</header>,
}))

vi.mock('@/hooks/useCoworkSessions', () => ({
  useCoworkSessions: Object.assign(
    (selector: any) => selector({ sessions: h.sessions }),
    { getState: () => ({ selectSession: h.selectSession }) }
  ),
}))

vi.mock('@/hooks/useCoworkRun', () => ({
  useCoworkRun: { getState: () => ({ requestPreview: h.requestPreview }) },
}))

vi.mock('@/hooks/useServiceHub', () => {
  const hub = {
    app: () => ({ getJanDataFolder: async () => '/data' }),
    core: () => ({ convertFileSrc: (p: string) => p }),
    opener: () => ({
      openPath: h.openPath,
      revealItemInDir: h.revealItemInDir,
    }),
  }
  return { useServiceHub: () => hub, getServiceHub: () => hub }
})

vi.mock('@janhq/tauri-plugin-agent-tools-api', () => ({
  sessionWorkspacePath: async (_data: string, id: string) => `/data/ws/${id}`,
}))

vi.mock('@janhq/core', () => ({
  fs: { existsSync: h.existsSync },
}))

import { Route } from '../artifacts'

const renderPage = async () => {
  const Component = Route.component as React.ComponentType
  const utils = render(<Component />)
  // Let the sandbox lookup settle.
  await act(async () => {})
  return utils
}

const selectFirst = async () => {
  fireEvent.click(screen.getByTestId('artifact-row'))
  await act(async () => {})
}

const session = {
  id: 's1',
  title: 'Landing page draft',
  folder: '/home/me/projects/site',
  updated: Date.UTC(2026, 8, 1, 12, 0),
  turns: [
    {
      role: 'tool',
      name: 'write',
      content: '',
      args: { path: 'index.html' },
      result: 'Created index.html (120 bytes)',
    },
  ],
}

describe('Library route (/artifacts)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.sessions = [session]
    h.existsSync.mockResolvedValue(true)
  })

  it('lists each artifact with its kind and session, and its project in the details', async () => {
    await renderPage()
    const row = screen.getByTestId('artifact-card')
    expect(row).toHaveTextContent('index')
    expect(row).toHaveTextContent('engine:library.htmlPage')
    expect(row).toHaveTextContent('Landing page draft')
    await selectFirst()
    expect(screen.getByTestId('artifact-inspector')).toHaveTextContent('site')
    expect(screen.getAllByTitle('index').length).toBeGreaterThan(0)
    expect(screen.getByText('common:artifactsCount')).toBeInTheDocument()
  })

  it('opens the artifact in the Cowork preview straight from the list', async () => {
    await renderPage()
    fireEvent.click(screen.getByTestId('artifact-open'))
    expect(h.selectSession).toHaveBeenCalledWith('s1')
    expect(h.requestPreview).toHaveBeenCalledWith('s1', 'index.html')
    expect(h.navigate).toHaveBeenCalledWith({ to: '/cowork' })
  })

  it('goes to the source session straight from the list, without a preview', async () => {
    await renderPage()
    fireEvent.click(screen.getByTestId('artifact-go-to-session'))
    expect(h.selectSession).toHaveBeenCalledWith('s1')
    expect(h.navigate).toHaveBeenCalledWith({ to: '/cowork' })
    expect(h.requestPreview).not.toHaveBeenCalled()
  })

  it('opens the preview when a row is double-clicked', async () => {
    await renderPage()
    fireEvent.doubleClick(screen.getByTestId('artifact-row'))
    expect(h.requestPreview).toHaveBeenCalledWith('s1', 'index.html')
  })

  it('shows details beside the list, with the same two actions', async () => {
    await renderPage()
    expect(screen.queryByTestId('artifact-inspector')).not.toBeInTheDocument()
    await selectFirst()
    expect(screen.getByTestId('artifact-inspector')).toHaveTextContent(
      'Landing page draft'
    )
    expect(screen.getByTestId('artifact-row')).toHaveAttribute(
      'aria-current',
      'true'
    )
    fireEvent.click(screen.getByTestId('artifact-inspector-go-to-session'))
    expect(h.selectSession).toHaveBeenCalledWith('s1')
    expect(h.requestPreview).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('artifact-inspector-open'))
    expect(h.requestPreview).toHaveBeenCalledWith('s1', 'index.html')
    fireEvent.click(screen.getByLabelText('common:artifactClose'))
    expect(screen.queryByTestId('artifact-inspector')).not.toBeInTheDocument()
  })

  it('offers no way to delete a file', async () => {
    await renderPage()
    await selectFirst()
    expect(screen.queryByText('common:artifactDelete')).not.toBeInTheDocument()
    expect(screen.queryByTestId('artifact-delete')).not.toBeInTheDocument()
  })

  it('says when the file is no longer on disk and keeps the way back', async () => {
    h.existsSync.mockResolvedValue(false)
    await renderPage()
    await selectFirst()
    expect(await screen.findByTestId('artifact-missing')).toBeInTheDocument()
    expect(screen.getByTestId('artifact-inspector-open')).toBeDisabled()
    expect(
      screen.getByTestId('artifact-inspector-go-to-session')
    ).toBeEnabled()
  })

  it('disables the preview for a path outside the session root (#183)', async () => {
    h.sessions = [
      {
        ...session,
        turns: [
          {
            role: 'tool',
            name: 'write',
            content: '',
            args: { path: '/etc/outside.html' },
            result: 'Created /etc/outside.html (1 bytes)',
          },
        ],
      },
    ]
    await renderPage()
    await selectFirst()
    expect(screen.getByTestId('artifact-inspector-open')).toBeDisabled()
    expect(
      screen.getByTestId('artifact-inspector-go-to-session')
    ).toBeEnabled()
  })

  it('narrows the list with the search box', async () => {
    await renderPage()
    fireEvent.change(screen.getByLabelText('common:artifactsSearch'), {
      target: { value: 'nothing-like-this' },
    })
    expect(screen.queryByTestId('artifact-card')).not.toBeInTheDocument()
    expect(screen.getByText('common:artifactsNoMatch')).toBeInTheDocument()
  })

  it('narrows the list by kind', async () => {
    await renderPage()
    // The kind filter is a segmented control: one radio per kind.
    fireEvent.click(screen.getByRole('radio', { name: 'engine:library.kindImages' }))
    expect(screen.queryByTestId('artifact-card')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'common:artifactsAll' }))
    expect(screen.getByTestId('artifact-card')).toBeInTheDocument()
  })

  it('marks the card selected in the same tick as the click', async () => {
    await renderPage()
    const card = screen.getByTestId('artifact-card').firstElementChild!
    expect(card).not.toHaveAttribute('data-selected')
    // No act() flush: the highlight must not wait on the details panel.
    fireEvent.click(screen.getByTestId('artifact-row'))
    expect(card).toHaveAttribute('data-selected', 'true')
    expect(card.className).toContain('var(--primary)')
    await act(async () => {})
    expect(screen.getByTestId('artifact-inspector')).toBeInTheDocument()
  })

  it('outlines a card on hover and on keyboard focus', async () => {
    await renderPage()
    const card = screen.getByTestId('artifact-card').firstElementChild!
    expect(card.className).toContain(
      'hover:[&>[data-slot=frame-body]]:shadow-[0_0_0_1px_var(--ring),var(--lift)]'
    )
    expect(card.className).toContain(
      'has-[[data-testid=artifact-row]:focus-visible]'
    )
  })

  it('previews the first lines of a Markdown artifact on its card', async () => {
    const { clearPreviewCache } = await import('@/lib/artifactCardPreview')
    clearPreviewCache()
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('# Release notes\n\n- Added **gusts**\n- Fixed [cache](x)')
      )
    h.sessions = [
      {
        ...session,
        turns: [
          {
            role: 'tool',
            name: 'write',
            content: '',
            args: { path: 'notes.md' },
            result: 'Created notes.md (60 bytes)',
          },
        ],
      },
    ]
    await renderPage()
    const thumb = await screen.findByTestId('artifact-thumb-text')
    expect(thumb).toHaveTextContent('Release notes')
    expect(thumb).toHaveTextContent('• Added gusts')
    expect(thumb).toHaveTextContent('• Fixed cache')
    expect(fetchMock).toHaveBeenCalledWith('/data/ws/s1/notes.md')
    fetchMock.mockRestore()
  })

  it('shows a headline and a next step when nothing has been made', async () => {
    h.sessions = []
    await renderPage()
    expect(screen.getByTestId('artifacts-empty')).toHaveTextContent(
      'common:artifactsEmptyTitle'
    )
    fireEvent.click(screen.getByText('common:artifactsOpenCowork'))
    expect(h.navigate).toHaveBeenCalledWith({ to: '/cowork' })
  })
})
