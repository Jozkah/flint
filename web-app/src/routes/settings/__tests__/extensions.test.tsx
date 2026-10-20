import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { isRedirect } from '@tanstack/react-router'
import { ExtensionsSettings } from '@/containers/ExtensionsSettings'
import { Route as ExtensionsRoute } from '../extensions'

vi.mock('@/containers/Card', () => ({
  Card: ({
    title,
    aside,
    children,
  }: {
    title?: React.ReactNode
    aside?: React.ReactNode
    children: React.ReactNode
  }) => (
    <div data-testid="card">
      {(title || aside) && (
        <div data-testid="card-header">
          {title}
          {aside}
        </div>
      )}
      {children}
    </div>
  ),
  CardItem: ({
    title,
    description,
  }: {
    title?: React.ReactNode
    description?: React.ReactNode
  }) => (
    <div data-testid="card-item" data-title={title ? 'yes' : undefined}>
      {title && <div data-testid="card-item-title">{title}</div>}
      {description && (
        <div data-testid="card-item-description">{description}</div>
      )}
    </div>
  ),
}))

vi.mock('@/containers/RenderMarkdown', () => ({
  RenderMarkdown: () => <div data-testid="render-markdown" />,
}))

vi.mock('@/lib/extension', () => ({
  ExtensionManager: {
    getInstance: () => ({
      listExtensions: vi.fn().mockReturnValue([
        {
          name: 'test-extension-1',
          productName: 'Test Extension 1',
          description: 'Test extension description 1',
          version: '1.0.0',
        },
        {
          name: 'test-extension-2',
          productName: 'Test Extension 2',
          description: 'Test extension description 2',
          version: '2.0.0',
        },
        {
          name: 'test-extension-3',
          description: 'Test extension description 3',
          version: '3.0.0',
        },
      ]),
    }),
  },
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

describe('Extensions tab of Integrations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the extensions card with its header', () => {
    render(<ExtensionsSettings />)
    expect(screen.getByTestId('card')).toBeInTheDocument()
    expect(screen.getByTestId('card-header')).toBeInTheDocument()
    expect(screen.getByText('settings:extensions.title')).toBeInTheDocument()
  })

  it('renders only cards: the page header belongs to Integrations', () => {
    render(<ExtensionsSettings />)
    expect(screen.queryByText('common:extensions')).toBeNull()
    expect(screen.queryByText('settings:pageDesc.extensions')).toBeNull()
  })

  it('lists every installed extension with its description', () => {
    render(<ExtensionsSettings />)
    expect(screen.getAllByTestId('card-item')).toHaveLength(3)
    expect(screen.getAllByTestId('render-markdown')).toHaveLength(3)
  })

  it('names an extension by productName, falling back to name', () => {
    render(<ExtensionsSettings />)
    expect(screen.getByText('Test Extension 1')).toBeInTheDocument()
    expect(screen.getByText('Test Extension 2')).toBeInTheDocument()
    expect(screen.getByText('test-extension-3')).toBeInTheDocument()
  })

  it('shows each version chip', () => {
    render(<ExtensionsSettings />)
    expect(screen.getByText('v1.0.0')).toBeInTheDocument()
    expect(screen.getByText('v3.0.0')).toBeInTheDocument()
  })

  it('redirects the old /settings/extensions route to the tab', () => {
    let thrown: unknown
    try {
      ;(
        ExtensionsRoute.options.beforeLoad as unknown as (ctx: {
          search: object
        }) => void
      )({ search: {} })
    } catch (e) {
      thrown = e
    }
    expect(isRedirect(thrown)).toBe(true)
    expect((thrown as { options: { search: object } }).options.search).toEqual({
      tab: 'extensions',
    })
  })
})
