/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import React from 'react'

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  selectSession: vi.fn(),
  requestPreview: vi.fn(),
  openPath: vi.fn(),
  revealItemInDir: vi.fn(),
  existsSync: vi.fn(),
  rm: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
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
  fs: { existsSync: h.existsSync, rm: h.rm },
}))

vi.mock('sonner', () => ({
  toast: { success: h.toastSuccess, error: h.toastError },
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
  fireEvent.click(
    screen.getByTestId('artifact-card').querySelector('button')!
  )
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
    h.rm.mockResolvedValue(undefined)
  })

  it('lists each artifact as a row with its kind, session and project', async () => {
    await renderPage()
    const row = screen.getByTestId('artifact-card')
    expect(row).toHaveTextContent('index')
    expect(row).toHaveTextContent('Code · HTML')
    expect(row).toHaveTextContent('Landing page draft')
    expect(row).toHaveTextContent('site')
    expect(screen.getByTitle('index')).toBeInTheDocument()
    expect(screen.getByText('common:artifactsCount')).toBeInTheDocument()
  })

  it('opens the details of a row without leaving the library', async () => {
    await renderPage()
    expect(screen.queryByTestId('artifact-inspector')).not.toBeInTheDocument()
    await selectFirst()
    expect(screen.getByTestId('artifact-inspector')).toHaveTextContent(
      'common:artifactSource'
    )
    expect(
      screen.getByTestId('artifact-card').querySelector('button')
    ).toHaveAttribute('aria-current', 'true')
    fireEvent.click(screen.getByLabelText('common:artifactClose'))
    expect(screen.queryByTestId('artifact-inspector')).not.toBeInTheDocument()
  })

  it('opens the artifact in the Cowork preview', async () => {
    await renderPage()
    await selectFirst()
    fireEvent.click(screen.getByTestId('artifact-open'))
    expect(h.selectSession).toHaveBeenCalledWith('s1')
    expect(h.requestPreview).toHaveBeenCalledWith('s1', 'index.html')
    expect(h.navigate).toHaveBeenCalledWith({ to: '/cowork' })
  })

  it('goes to the source session without opening a preview', async () => {
    await renderPage()
    await selectFirst()
    fireEvent.click(screen.getByTestId('artifact-go-to-session'))
    expect(h.selectSession).toHaveBeenCalledWith('s1')
    expect(h.navigate).toHaveBeenCalledWith({ to: '/cowork' })
    expect(h.requestPreview).not.toHaveBeenCalled()
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
    fireEvent.click(screen.getByRole('button', { name: 'Image' }))
    expect(screen.queryByTestId('artifact-card')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'common:artifactsAll' }))
    expect(screen.getByTestId('artifact-card')).toBeInTheDocument()
  })

  it('deletes the file only after confirmation, then says it is gone', async () => {
    await renderPage()
    await selectFirst()
    fireEvent.click(screen.getByTestId('artifact-delete'))
    expect(h.rm).not.toHaveBeenCalled()
    h.existsSync.mockResolvedValue(false)
    fireEvent.click(screen.getByTestId('artifact-delete-confirm'))
    await waitFor(() =>
      expect(h.rm).toHaveBeenCalledWith('/data/ws/s1/index.html')
    )
    expect(h.toastSuccess).toHaveBeenCalled()
    expect(await screen.findByTestId('artifact-missing')).toBeInTheDocument()
    expect(screen.queryByTestId('artifact-delete')).not.toBeInTheDocument()
    // The way back to the session stays.
    expect(screen.getByTestId('artifact-go-to-session')).toBeInTheDocument()
  })

  it('reports a failed delete as an error', async () => {
    h.rm.mockRejectedValue(new Error('denied'))
    await renderPage()
    await selectFirst()
    fireEvent.click(screen.getByTestId('artifact-delete'))
    fireEvent.click(screen.getByTestId('artifact-delete-confirm'))
    await waitFor(() => expect(h.toastError).toHaveBeenCalled())
    expect(screen.queryByTestId('artifact-missing')).not.toBeInTheDocument()
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
