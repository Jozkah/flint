import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { Shell } from '../shell/Shell'
import { handleEvent, openSheet } from '../state/app'
import { progressText, studioForm, studioJob, studioSummary } from '../state/studio'
import { insertAt } from '../ui/dictate'
import { resetApp, useFixtures } from './helpers'

const T = { timeout: 3000 }
const sizes = [{ label: 'Square', short: '1:1' }, { label: 'Portrait', short: '3:4' }]
const item = { id: 'a1', kind: 'image', recipe: { prompt: 'A fox in snow', negativePrompt: '', width: 1024, height: 1024, seed: 48213, modelName: 'Z-Image Turbo', frames: null, fps: null, createdAtMs: 1, durationMs: 9000 } }
const status = {
  supported: true, engineTag: 'b1', engineBackend: 'vulkan',
  models: [{ id: 'z', name: 'Z-Image Turbo', kind: 'image', installed: true, totalBytes: 1e9, fps: null }, { id: 'w', name: 'Wan 2.2', kind: 'video', installed: false, totalBytes: 2e9, fps: 24 }],
  resident: { modelId: 'z', kind: 'image', busy: false },
  job: { kind: 'image', prompt: 'A lighthouse', phase: 'sampling', fraction: 0.4, startedAt: Date.now() - 4000, count: 4 },
  download: null,
  activity: [{ id: 0, kind: 'image', prompt: 'A lighthouse', status: 'making', durationMs: 0, at: 1 }, { id: 2, kind: 'image', prompt: 'Koi', status: 'failed', error: 'Out of memory', durationMs: 0, at: 1 }],
  memoryWarning: 'This computer has about 16 GB of memory.', memoryGb: 16, error: null,
  sizes: { image: sizes, video: sizes }, videoSeconds: [1, 2, 3, 5],
}

describe('phone Studio', () => {
  let client: ReturnType<typeof useFixtures>
  beforeEach(() => {
    studioForm.reset()
    studioJob.reset()
    client = useFixtures({
      'studio.status': status,
      'studio.gallery': { items: [item] },
      'studio.media': { dataUrl: 'data:image/png;base64,AA' },
      'studio.generate': { started: true },
      'studio.stop': { ok: true },
      'voice.status': { ready: true },
    })
  })

  it('shows progress, activity, the gallery and makes with the settings', async () => {
    resetApp({ name: 'studio' })
    render(<Shell />)
    expect(await screen.findByText('Making image 2 of 4', {}, T)).toBeInTheDocument()
    expect(screen.getByText('Out of memory')).toBeInTheDocument()
    expect(screen.getByTestId('studio-summary')).toHaveTextContent('Square · 1 image · seed random')
    expect(await screen.findAllByRole('button', { name: 'A fox in snow' })).not.toHaveLength(0)
    expect(screen.getByTestId('dictate')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(client.rpc).toHaveBeenCalledWith('studio.stop', {})
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'A red barn' } })
    fireEvent.click(screen.getByRole('button', { name: 'Make' }))
    expect(client.rpc).toHaveBeenCalledWith('studio.generate', expect.objectContaining({ kind: 'image', prompt: 'A red barn', count: 1 }))
    act(() => handleEvent({ type: 'studio.progress', job: null }))
    await waitFor(() => expect(screen.queryByText('Making image 2 of 4')).not.toBeInTheDocument())
  })

  it('the video settings sheet needs the memory warning acknowledged', async () => {
    studioForm.set({ kind: 'video' })
    resetApp({ name: 'studio' })
    render(<Shell />)
    openSheet('studioset')
    expect(await screen.findByTestId('memory-warning', {}, T)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'I understand' }))
    expect(studioForm.get().memoryAck).toBe(true)
    expect(screen.getByText('Download')).toBeInTheDocument()
  })

  it('the item sheet remixes', async () => {
    resetApp({ name: 'studio' })
    render(<Shell />)
    openSheet('studioitem', { item })
    expect(await screen.findByText('48213', {}, T)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remix' }))
    expect(client.rpc).toHaveBeenCalledWith('studio.remix', { kind: 'image', id: 'a1' })
  })

  it('the mic shows when voice is not set up and opens the setup sheet', async () => {
    client = useFixtures({ 'studio.status': status, 'studio.gallery': { items: [] }, 'voice.status': { ready: false } })
    resetApp({ name: 'studio' })
    render(<Shell />)
    fireEvent.click(await screen.findByTestId('dictate', {}, T))
    expect(await screen.findByText('Set up voice input on your computer', {}, T)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith('voice.status', {}))
  })

  it('pure helpers', () => {
    expect(insertAt('hello world', 5, 5, 'big')).toEqual({ value: 'hello big world', caret: 9 })
    expect(insertAt('', 0, 0, 'hi')).toEqual({ value: 'hi', caret: 2 })
    expect(studioSummary('video', { sizeIndex: 1, count: 1, seconds: 3, seed: '5', negative: '' }, sizes)).toBe('Portrait · 3 s · seed 5')
    expect(progressText({ kind: 'video', prompt: '', phase: 'sampling', fraction: 0.5, startedAt: 0, count: 1 }, 60_000)).toEqual({ title: 'Making video', left: '1 min left', percent: 50 })
  })
})
