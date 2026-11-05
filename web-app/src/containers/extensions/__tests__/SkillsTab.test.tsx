/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

vi.mock('@/lib/folderTrust', () => ({
  folderTrustStatus: vi.fn(),
}))

import { deleteSkill, listSkills, readSkill, writeSkill } from '@/lib/skillStore'
import { folderTrustStatus } from '@/lib/folderTrust'
import { listProjects } from '@/lib/extensionsStore'
import SkillsTab from '../SkillsTab'

const mockedListSkills = vi.mocked(listSkills)
const mockedListProjects = vi.mocked(listProjects)

describe('SkillsTab', () => {
  it('asks before deleting a global skill, and deletes only on confirm', async () => {
    mockedListProjects.mockResolvedValue([])
    mockedListSkills.mockImplementation(async (scope: any) =>
      scope.kind === 'store'
        ? ([{ name: 'doomed', description: 'x' }] as any)
        : []
    )
    vi.mocked(deleteSkill).mockResolvedValue(undefined as never)

    render(<SkillsTab />)
    const trash = await screen.findByLabelText('common:skillDelete: doomed')

    fireEvent.click(trash)
    expect(deleteSkill).not.toHaveBeenCalled()
    expect(await screen.findByText('common:skillDeleteConfirmTitle')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('skill-delete-confirm'))
    await waitFor(() => expect(deleteSkill).toHaveBeenCalledTimes(1))
    expect(vi.mocked(deleteSkill).mock.calls[0][1]).toBe('doomed')
  })

  it('keeps the skill when the confirmation is cancelled', async () => {
    mockedListProjects.mockResolvedValue([])
    mockedListSkills.mockImplementation(async (scope: any) =>
      scope.kind === 'store'
        ? ([{ name: 'kept', description: 'x' }] as any)
        : []
    )
    vi.mocked(deleteSkill).mockClear()

    render(<SkillsTab />)
    fireEvent.click(await screen.findByLabelText('common:skillDelete: kept'))
    fireEvent.click(await screen.findByText('common:cancel'))

    await waitFor(() =>
      expect(screen.queryByText('common:skillDeleteConfirmTitle')).toBeNull()
    )
    expect(deleteSkill).not.toHaveBeenCalled()
  })

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

  const openProjectSkill = async (trusted: boolean) => {
    mockedListProjects.mockResolvedValue([
      { id: 'p1', folder: '/path/to/proj', name: 'My Project' },
    ])
    mockedListSkills.mockImplementation(async (scope: any) =>
      scope.kind === 'project'
        ? ([{ name: 'proj-skill', description: 'A project skill' }] as any)
        : []
    )
    vi.mocked(readSkill).mockResolvedValue('body' as never)
    vi.mocked(writeSkill).mockReset()
    vi.mocked(writeSkill).mockResolvedValue(undefined as never)
    vi.mocked(folderTrustStatus).mockResolvedValue({
      folder: '/path/to/proj',
      trusted,
      carries: { hooks: false, subagents: false },
    })
    render(<SkillsTab />)
    await screen.findByText('proj-skill')
    fireEvent.click(screen.getByText('engine:extensions.view'))
    await screen.findByText('common:skillContentPlaceholder', {}, { timeout: 100 }).catch(() => {})
    return await screen.findByPlaceholderText('common:skillContentPlaceholder')
  }

  it('saves a project skill in place when its folder is trusted', async () => {
    const area = await openProjectSkill(true)
    expect(area).not.toHaveAttribute('readonly')
    fireEvent.click(screen.getByText('common:skillSave'))
    await waitFor(() => expect(writeSkill).toHaveBeenCalledTimes(1))
    expect(vi.mocked(writeSkill).mock.calls[0][0]).toEqual({
      kind: 'project',
      folder: '/path/to/proj',
    })
  })

  it('keeps a project skill read-only when its folder is not trusted', async () => {
    const area = await openProjectSkill(false)
    expect(area).toHaveAttribute('readonly')
    expect(screen.queryByText('common:skillSave')).toBeNull()
  })
})
