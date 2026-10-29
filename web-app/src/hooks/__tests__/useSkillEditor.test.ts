import { describe, it, expect, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

const { toast } = vi.hoisted(() => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  i18n: { t: (k: string) => k },
}))

import { NEW_SKILL_TEMPLATE, useSkillEditor } from '../useSkillEditor'

describe('useSkillEditor', () => {
  it('starts a draft, saves it under the trimmed name, and closes', async () => {
    const { result } = renderHook(() => useSkillEditor())
    act(() => result.current.startNew())
    expect(result.current).toMatchObject({ isNew: true, editing: true, content: NEW_SKILL_TEMPLATE })
    act(() => result.current.setName('  mine '))
    const write = vi.fn().mockResolvedValue(undefined)
    const onSaved = vi.fn().mockResolvedValue(undefined)
    await act(() => result.current.save(write, onSaved))
    expect(write).toHaveBeenCalledWith('mine', NEW_SKILL_TEMPLATE)
    expect(onSaved).toHaveBeenCalled()
    expect(result.current).toMatchObject({ selected: 'mine', isNew: false, saving: false })
    act(() => result.current.close())
    expect(result.current).toMatchObject({ selected: null, editing: false, name: '', content: '' })
  })

  it('refuses a blank name and reports a failed write', async () => {
    const { result } = renderHook(() => useSkillEditor())
    const write = vi.fn().mockRejectedValue(new Error('disk full'))
    await act(() => result.current.save(write))
    expect(write).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('common:skillNameRequired')
    act(() => result.current.show('a', 'body'))
    await act(() => result.current.save(write))
    expect(toast.error).toHaveBeenCalledWith('Error: disk full')
    expect(result.current.selected).toBe('a')
  })
})
