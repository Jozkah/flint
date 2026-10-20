import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import ragSettings from '../../../../../extensions/rag-extension/settings.json'

const state = vi.hoisted(() => ({
  defs: [] as {
    key: string
    title: string
    controllerType: string
    controllerProps: object
  }[],
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: Record<string, unknown>) => config,
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/containers/SettingsPageHeader', () => ({
  SettingsPageHeader: () => null,
  SettingsPageBody: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}))
vi.mock('@/containers/Card', () => ({
  Card: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
  CardItem: ({ title, anchor }: { title: string; anchor?: string }) => (
    <div data-anchor={anchor}>{title}</div>
  ),
}))
vi.mock('@/containers/ImageDescriptionCard', () => ({
  ImageDescriptionCard: () => <section aria-label="image-description" />,
}))
vi.mock('@/containers/dynamicControllerSetting', () => ({
  DynamicControllerSetting: () => null,
}))
vi.mock('@/hooks/useAttachments', () => ({
  useAttachments: (sel: (s: object) => unknown) =>
    sel({ settingsDefs: state.defs, loadSettingsDefs: () => {} }),
}))

import { Route } from '../attachments'

const Page = (Route as unknown as { component: React.ComponentType }).component

const titlesIn = (name: string) =>
  within(screen.getByRole('region', { name }))
    .queryAllByText(/.+/)
    .map((e) => e.textContent)

describe('Settings > Attachments', () => {
  it('groups the schema rows into Files, Search and Chunking cards', () => {
    // Titled by key so the assertions read the schema order directly.
    state.defs = ragSettings.map((d) => ({
      key: d.key,
      title: d.key,
      controllerType: d.controllerType,
      controllerProps: d.controllerProps,
    }))
    render(<Page />)
    expect(titlesIn('settings:attachments.featureTitle')).toEqual([
      'enabled',
      'parse_mode',
      'auto_inline_context_ratio',
      'max_file_size_mb',
    ])
    expect(titlesIn('settings:attachments.retrievalTitle')).toEqual([
      'retrieval_limit',
      'retrieval_threshold',
      'search_mode',
    ])
    expect(titlesIn('settings:attachments.chunkingTitle')).toEqual([
      'chunk_size_chars',
      'overlap_chars',
    ])
    expect(
      screen.getByRole('region', { name: 'image-description' })
    ).toBeInTheDocument()
  })

  it('puts a key it does not know in the first card', () => {
    state.defs = [
      {
        key: 'chunk_size_chars',
        title: 'chunk_size_chars',
        controllerType: 'input',
        controllerProps: {},
      },
      {
        key: 'something_new',
        title: 'something_new',
        controllerType: 'input',
        controllerProps: {},
      },
    ]
    render(<Page />)
    expect(titlesIn('settings:attachments.featureTitle')).toEqual([
      'something_new',
    ])
    expect(
      screen.queryByRole('region', {
        name: 'settings:attachments.retrievalTitle',
      })
    ).toBeNull()
  })
})
