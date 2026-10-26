import { beforeEach, describe, expect, it, vi } from 'vitest'

const download = vi.fn()
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}))
vi.mock('@/lib/huggingface', () => ({
  downloadHuggingFaceFile: (args: unknown) => download(args),
  cancelHuggingFaceDownload: vi.fn().mockResolvedValue(undefined),
}))

import {
  restoreHuggingFaceBundle,
  resumeHuggingFaceBundle,
  startHuggingFaceBundle,
  useHuggingFaceDownloads,
} from '@/hooks/useHuggingFaceDownloads'
import {
  readInterruptedDownloads,
  resetInterruptedDownloadsCache,
  writeInterruptedDownloads,
  type InterruptedDownload,
} from '@/lib/interruptedDownloads'

const files = [
  { name: 'model-Q4.gguf', size: 100 },
  { name: 'mmproj.gguf', size: 20 },
]
const finish = { kind: 'voice' as const }

let n = 0
const nextId = () => `hf:test:${++n}`

beforeEach(() => {
  download.mockReset()
  localStorage.clear()
  resetInterruptedDownloadsCache()
})

describe('saving an unfinished download', () => {
  it('saves a download that stops partway, without its token', async () => {
    const id = nextId()
    download
      .mockResolvedValueOnce('/models/model-Q4.gguf')
      .mockRejectedValueOnce(new Error('Download paused'))

    await startHuggingFaceBundle({
      id,
      repo: 'org/repo',
      label: 'Repo Q4',
      files,
      token: 'hf_secret',
      finish,
      onComplete: vi.fn(),
    })

    expect(useHuggingFaceDownloads.getState().tasks[id].status).toBe('paused')
    const saved = readInterruptedDownloads().find((r) => r.id === id)
    expect(saved).toMatchObject({
      repo: 'org/repo',
      label: 'Repo Q4',
      paths: ['/models/model-Q4.gguf'],
      downloaded: 100,
      finish,
    })
    expect(localStorage.getItem('flint-interrupted-downloads')).not.toContain('hf_secret')
  })

  it('forgets a download once it finishes', async () => {
    const id = nextId()
    download.mockResolvedValueOnce('/a').mockResolvedValueOnce('/b')

    await startHuggingFaceBundle({ id, repo: 'org/repo', label: 'Done', files, finish })

    expect(useHuggingFaceDownloads.getState().tasks[id].status).toBe('complete')
    expect(readInterruptedDownloads().some((r) => r.id === id)).toBe(false)
  })

  it('does not save a download that has no finish description', async () => {
    const id = nextId()
    download.mockRejectedValueOnce(new Error('Download paused'))

    await startHuggingFaceBundle({ id, repo: 'org/repo', label: 'Plain', files })

    expect(readInterruptedDownloads().some((r) => r.id === id)).toBe(false)
  })
})

describe('restoring after a relaunch', () => {
  it('comes back paused and resumes from the next unfinished file', async () => {
    const id = nextId()
    const saved: InterruptedDownload = {
      id,
      repo: 'org/repo',
      label: 'Repo Q4',
      files,
      paths: ['/models/model-Q4.gguf'],
      downloaded: 100,
      total: 120,
      finish,
    }
    const onComplete = vi.fn().mockResolvedValue(undefined)

    restoreHuggingFaceBundle(
      { id, repo: saved.repo, label: saved.label, files, finish, onComplete },
      saved
    )

    const task = useHuggingFaceDownloads.getState().tasks[id]
    expect(task).toMatchObject({ status: 'paused', currentFileIndex: 1, downloaded: 100 })
    expect(task.progress).toBeCloseTo(100 / 120)

    download.mockResolvedValueOnce('/models/mmproj.gguf')
    await resumeHuggingFaceBundle(id)

    expect(download).toHaveBeenCalledTimes(1)
    expect(download.mock.calls[0][0]).toMatchObject({ filename: 'mmproj.gguf' })
    expect(onComplete).toHaveBeenCalledWith(['/models/model-Q4.gguf', '/models/mmproj.gguf'])
    expect(useHuggingFaceDownloads.getState().tasks[id].status).toBe('complete')
  })

  it('leaves a download already known this session alone', () => {
    const id = nextId()
    useHuggingFaceDownloads.getState().upsert({
      id,
      repo: 'org/repo',
      label: 'Live',
      status: 'downloading',
      files,
      paths: [],
      currentFileIndex: 0,
      downloaded: 5,
      progress: 0.05,
    })

    restoreHuggingFaceBundle(
      { id, repo: 'org/repo', label: 'Live', files, finish },
      { id, repo: 'org/repo', label: 'Live', files, paths: [], downloaded: 0, finish }
    )

    expect(useHuggingFaceDownloads.getState().tasks[id].status).toBe('downloading')
  })
})

describe('the saved list', () => {
  it('drops entries it cannot use', () => {
    localStorage.setItem(
      'flint-interrupted-downloads',
      JSON.stringify([
        { id: 'ok', repo: 'r', label: 'l', files: [], paths: [], downloaded: 0, finish: { kind: 'mlx', modelId: 'm', repo: 'r' } },
        { id: 'bad-kind', repo: 'r', label: 'l', files: [], paths: [], finish: { kind: 'engine' } },
        'garbage',
      ])
    )
    expect(readInterruptedDownloads().map((r) => r.id)).toEqual(['ok'])
  })

  it('reads an unreadable store as empty', () => {
    localStorage.setItem('flint-interrupted-downloads', '{not json')
    expect(readInterruptedDownloads()).toEqual([])
  })

  it('removes the key when nothing is left', () => {
    writeInterruptedDownloads([
      { id: 'x', repo: 'r', label: 'l', files: [], paths: [], downloaded: 0, finish },
    ])
    writeInterruptedDownloads([])
    expect(localStorage.getItem('flint-interrupted-downloads')).toBeNull()
  })
})
