/**
 * The chat row's "New group…" opens this dialog; it must say "group", not
 * "collection", in its title and toast. Other callers keep "collection".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
const success = vi.fn()
vi.mock('sonner', () => ({
  toast: { success: (...a: unknown[]) => success(...a), warning: vi.fn() },
}))
vi.mock('@/hooks/useThreadManagement', () => ({
  useThreadManagement: () => ({ folders: [] }),
}))
vi.mock('@/hooks/useAssistant', () => ({
  useAssistant: () => ({ assistants: [], addAssistant: vi.fn() }),
}))
vi.mock('@/hooks/useCoworkRun', () => ({
  useCoworkRun: { getState: () => ({ requestAttachFolder: vi.fn() }) },
}))

import AddProjectDialog from '../AddProjectDialog'

describe('AddProjectDialog wording', () => {
  beforeEach(() => success.mockClear())

  it('uses group wording when noun="group"', () => {
    render(
      <AddProjectDialog open onOpenChange={() => {}} editingKey={null} noun="group" onSave={() => {}} />
    )
    expect(screen.getByText('projects.addGroupDialog.createTitle')).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('projects.addGroupDialog.namePlaceholder'), {
      target: { value: 'Work' },
    })
    fireEvent.click(screen.getByText('projects.addProjectDialog.createButton'))
    expect(success).toHaveBeenCalledWith('projects.addGroupDialog.createSuccess')
  })

  it('keeps collection wording by default', () => {
    render(<AddProjectDialog open onOpenChange={() => {}} editingKey={null} onSave={() => {}} />)
    expect(screen.getByText('projects.addProjectDialog.createTitle')).toBeTruthy()
  })
})
