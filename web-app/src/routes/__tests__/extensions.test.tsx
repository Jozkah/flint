/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import React from 'react'

import { vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: any) => ({ ...config, id: '/extensions' }),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/components/ui/sidebar', () => ({
  useOptionalSidebar: () => null,
}))

vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: any) => (
    <div data-testid="context-bar">{children}</div>
  ),
}))

import { Route } from '../extensions'
import { RAIL_ITEMS } from '@/lib/shellNavigation'

const renderComponent = () => {
  const Component = Route.component as React.ComponentType
  return render(<Component />)
}

describe('ExtensionsPage route', () => {
  it('renders both the Plugins and Skills tabs', () => {
    renderComponent()
    expect(screen.getByTestId('extensions-tab-plugins')).toHaveTextContent(
      'common:extensions.plugins'
    )
    expect(screen.getByTestId('extensions-tab-skills')).toHaveTextContent(
      'common:extensions.skills'
    )
  })

  it('defaults to the plugins panel and switches to skills on click', () => {
    renderComponent()
    expect(screen.getByTestId('extensions-panel-plugins')).toBeInTheDocument()
    expect(
      screen.queryByTestId('extensions-panel-skills')
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('extensions-tab-skills'))
    expect(screen.getByTestId('extensions-panel-skills')).toBeInTheDocument()
    expect(
      screen.queryByTestId('extensions-panel-plugins')
    ).not.toBeInTheDocument()
  })
})

describe('RAIL_ITEMS', () => {
  it('has an entry that routes to /extensions', () => {
    expect(RAIL_ITEMS.some((item) => item.to === '/extensions')).toBe(true)
  })
})
