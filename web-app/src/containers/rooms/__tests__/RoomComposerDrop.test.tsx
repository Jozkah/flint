import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { createFakeApi, makeRoom, renderWithApi } from './roomsTestUtils'
import { RoomComposer } from '../RoomComposer'

vi.mock('@/i18n/react-i18next-compat', async () => {
  const u = await import('./roomsTestUtils')
  return { useTranslation: () => ({ t: u.t }) }
})
vi.mock('@/lib/platform/utils', async (orig) => ({
  ...(await orig<typeof import('@/lib/platform/utils')>()),
  isPlatformTauri: () => true,
}))
const readDroppedPaths = vi.fn()
vi.mock('@/lib/droppedPaths', async (orig) => ({
  ...(await orig<typeof import('@/lib/droppedPaths')>()),
  readDroppedPaths: (...a: unknown[]) => readDroppedPaths(...a),
}))

const drop = async (data: Record<string, string>) => {
  const { api } = createFakeApi()
  const { container } = renderWithApi(<RoomComposer room={makeRoom()} />, api)
  const form = container.querySelector('[data-drop-zone="true"]') as HTMLElement
  await act(async () => {
    fireEvent.drop(form, {
      dataTransfer: {
        types: Object.keys(data),
        getData: (t: string) => data[t] ?? '',
        files: [],
        items: [],
      },
    })
  })
}

describe('RoomComposer drops that name paths as text', () => {
  beforeEach(() => {
    readDroppedPaths.mockReset()
    readDroppedPaths.mockResolvedValue({ files: [], folders: [], failed: [] })
  })

  it('does not read a path a web page put in text/plain or text/uri-list', async () => {
    await drop({ 'text/plain': '/home/me/.ssh/id_rsa' })
    await drop({ 'text/uri-list': 'file:///home/me/.bashrc' })
    expect(readDroppedPaths).not.toHaveBeenCalled()
  })

  it('reads what the GNOME drag type names', async () => {
    await drop({ 'x-special/gnome-copied-files': 'copy\nfile:///home/me/a.txt' })
    await waitFor(() => expect(readDroppedPaths).toHaveBeenCalled())
  })
})
