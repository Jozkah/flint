/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import React from 'react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/lib/extensionsStore', () => ({
  getMatrix: vi.fn(),
  listProjects: vi.fn(),
  setItemSurfaces: vi.fn(),
}))

import { getMatrix, listProjects, setItemSurfaces } from '@/lib/extensionsStore'
import EnablementGrid from '../EnablementGrid'

const mockedGetMatrix = vi.mocked(getMatrix)
const mockedListProjects = vi.mocked(listProjects)
const mockedSetItemSurfaces = vi.mocked(setItemSurfaces)

describe('EnablementGrid', () => {
  it('renders columns for Home, Rooms, and each project', async () => {
    mockedGetMatrix.mockResolvedValue({ skills: {}, plugins: {} })
    mockedListProjects.mockResolvedValue([
      { id: 'p1', folder: '/path/proj', name: 'My Project' },
    ])

    render(<EnablementGrid kind="skill" id="caveman" />)

    await waitFor(() => {
      expect(screen.getByLabelText('common:extensions.surfaces.home')).toBeInTheDocument()
    })
    expect(screen.getByLabelText('common:extensions.surfaces.rooms')).toBeInTheDocument()
    expect(screen.getByLabelText('My Project')).toBeInTheDocument()
  })

  it('shows all boxes checked when the item is absent from the matrix', async () => {
    mockedGetMatrix.mockResolvedValue({ skills: {}, plugins: {} })
    mockedListProjects.mockResolvedValue([])

    render(<EnablementGrid kind="skill" id="caveman" />)

    await waitFor(() => {
      expect(screen.getByLabelText('common:extensions.surfaces.home')).toBeChecked()
    })
    expect(screen.getByLabelText('common:extensions.surfaces.rooms')).toBeChecked()
  })

  it('unchecking Rooms calls setItemSurfaces with the surfaces minus rooms', async () => {
    mockedGetMatrix.mockResolvedValue({ skills: {}, plugins: {} })
    mockedListProjects.mockResolvedValue([])
    mockedSetItemSurfaces.mockResolvedValue({ skills: {}, plugins: {} })

    const user = userEvent.setup()
    render(<EnablementGrid kind="skill" id="caveman" />)

    await waitFor(() => {
      expect(screen.getByLabelText('common:extensions.surfaces.rooms')).toBeChecked()
    })

    await user.click(screen.getByLabelText('common:extensions.surfaces.rooms'))

    await waitFor(() => {
      expect(mockedSetItemSurfaces).toHaveBeenCalledWith('skill', 'caveman', ['home'])
    })
  })

  it('re-checking back to all surfaces clears the item (calls with null)', async () => {
    mockedGetMatrix.mockResolvedValue({
      skills: { caveman: { surfaces: ['home'] } },
      plugins: {},
    })
    mockedListProjects.mockResolvedValue([])
    mockedSetItemSurfaces.mockResolvedValue({ skills: {}, plugins: {} })

    const user = userEvent.setup()
    render(<EnablementGrid kind="skill" id="caveman" />)

    await waitFor(() => {
      expect(screen.getByLabelText('common:extensions.surfaces.home')).toBeChecked()
    })
    expect(screen.getByLabelText('common:extensions.surfaces.rooms')).not.toBeChecked()

    await user.click(screen.getByLabelText('common:extensions.surfaces.rooms'))

    await waitFor(() => {
      expect(mockedSetItemSurfaces).toHaveBeenCalledWith('skill', 'caveman', null)
    })
  })
})
