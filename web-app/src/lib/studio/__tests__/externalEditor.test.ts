import { beforeEach, describe, expect, it, vi } from 'vitest'

const openExternal = vi.fn()
vi.mock('@/lib/studio/studio', () => ({ studioApi: { openExternal: (...a: unknown[]) => openExternal(...a) } }))

import {
  EMPTY_EDITOR,
  isEditorConfigured,
  openInEditor,
  readEditor,
  subscribeEditor,
  writeEditor,
} from '../externalEditor'
import type { GalleryItem } from '../studio'

const item = { id: 'abc', kind: 'image', path: 'C:\\d\\images\\abc.png' } as unknown as GalleryItem

describe('external editor setting', () => {
  beforeEach(() => {
    localStorage.clear()
    openExternal.mockReset()
  })

  it('starts empty and not configured', () => {
    expect(readEditor()).toEqual(EMPTY_EDITOR)
    expect(isEditorConfigured(EMPTY_EDITOR)).toBe(false)
    expect(isEditorConfigured({ ...EMPTY_EDITOR, program: '   ' })).toBe(false)
  })

  it('round-trips a saved editor and tells subscribers', () => {
    const seen = vi.fn()
    const off = subscribeEditor(seen)
    writeEditor({ preset: 'custom', program: 'C:\\Apps\\gimp.exe', args: '--new {file}' })
    expect(seen).toHaveBeenCalledTimes(1)
    expect(readEditor()).toEqual({ preset: 'custom', program: 'C:\\Apps\\gimp.exe', args: '--new {file}' })
    off()
  })

  it('reads damaged storage as empty and clamps odd fields', () => {
    localStorage.setItem('studio-external-editor', '{nope')
    expect(readEditor()).toEqual(EMPTY_EDITOR)
    localStorage.setItem('studio-external-editor', JSON.stringify({ preset: 'x', program: 7, args: null }))
    expect(readEditor()).toEqual(EMPTY_EDITOR)
  })

  it('asks the backend by gallery id, never by path', async () => {
    openExternal.mockResolvedValue(undefined)
    await openInEditor(item, { preset: 'gmic', program: 'C:\\g\\gmic_qt.exe', args: '' })
    expect(openExternal).toHaveBeenCalledWith('image', 'abc', 'C:\\g\\gmic_qt.exe', '')
  })

  it('passes the backend refusal on', async () => {
    openExternal.mockRejectedValue('That app could not be found.')
    await expect(openInEditor(item, { preset: 'gmic', program: 'x', args: '' })).rejects.toBe(
      'That app could not be found.'
    )
  })
})
