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

import { Route } from '../artifacts'

const renderPage = async () => {
  const Component = Route.component as React.ComponentType
  const utils = render(<Component />)
  // Let the sandbox lookup settle.
  await act(async () => {})
  return utils
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
  })

  it('shows each artifact as a card with its session and project', async () => {
    await renderPage()
    const card = screen.getByTestId('artifact-card')
    expect(card).toHaveTextContent('index')
    expect(card).toHaveTextContent('Code · HTML')
    expect(card).toHaveTextContent('Landing page draft')
    expect(card).toHaveTextContent('site')
    expect(screen.getByTitle('index')).toBeInTheDocument()
  })

  it('opens the artifact in the Cowork preview', async () => {
    await renderPage()
    fireEvent.click(screen.getByTestId('artifact-open'))
    expect(h.selectSession).toHaveBeenCalledWith('s1')
    expect(h.requestPreview).toHaveBeenCalledWith('s1', 'index.html')
    expect(h.navigate).toHaveBeenCalledWith({ to: '/cowork' })
  })

  it('goes to the source session without opening a preview', async () => {
    await renderPage()
    fireEvent.click(screen.getByTestId('artifact-go-to-session'))
    expect(h.selectSession).toHaveBeenCalledWith('s1')
    expect(h.navigate).toHaveBeenCalledWith({ to: '/cowork' })
    expect(h.requestPreview).not.toHaveBeenCalled()
  })

  it('narrows the gallery with the search box', async () => {
    await renderPage()
    fireEvent.change(screen.getByLabelText('common:artifactsSearch'), {
      target: { value: 'nothing-like-this' },
    })
    expect(screen.queryByTestId('artifact-card')).not.toBeInTheDocument()
    expect(screen.getByText('common:artifactsNoMatch')).toBeInTheDocument()
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
