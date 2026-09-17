/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import React from 'react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string, opts?: any) => (opts?.name ? `${key}:${opts.name}` : key) }),
}))

vi.mock('@/lib/skillStore', () => ({
  storeScope: { kind: 'store' },
  projectScope: (folder: string) => ({ kind: 'project', folder }),
  isPluginSkill: (s: any) => Boolean(s?.plugin),
  listSkills: vi.fn(),
  readSkill: vi.fn(),
  writeSkill: vi.fn(),
  deleteSkill: vi.fn(),
}))

vi.mock('@/lib/extensionsStore', () => ({
  listProjects: vi.fn(),
}))

import { listSkills } from '@/lib/skillStore'
import { listProjects } from '@/lib/extensionsStore'
import SkillsTab from '../SkillsTab'

const mockedListSkills = vi.mocked(listSkills)
const mockedListProjects = vi.mocked(listProjects)

describe('SkillsTab', () => {
  it('renders the Global group with a stubbed global skill', async () => {
    mockedListProjects.mockResolvedValue([])
    mockedListSkills.mockImplementation(async (scope: any) => {
      if (scope.kind === 'store') {
        return [{ name: 'global-skill', description: 'A global skill' }] as any
      }
      return []
    })

    render(<SkillsTab />)

    await waitFor(() => {
      expect(screen.getByText('global-skill')).toBeInTheDocument()
    })
    expect(screen.getByText('common:extensionsManager.global')).toBeInTheDocument()
  })

  it('renders a per-project group header and that project skills', async () => {
    mockedListProjects.mockResolvedValue([
      { id: 'p1', folder: '/path/to/proj', name: 'My Project' },
    ])
    mockedListSkills.mockImplementation(async (scope: any) => {
      if (scope.kind === 'store') return []
      if (scope.kind === 'project' && scope.folder === '/path/to/proj') {
        return [{ name: 'proj-skill', description: 'A project skill' }] as any
      }
      return []
    })

    render(<SkillsTab />)

    await waitFor(() => {
      expect(screen.getByText('My Project')).toBeInTheDocument()
    })
    expect(screen.getByText('proj-skill')).toBeInTheDocument()
  })
})
