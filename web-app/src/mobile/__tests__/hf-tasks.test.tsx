import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Shell } from '../shell/Shell'
import { resetApp, useFixtures } from './helpers'

const card = (repo: string, over: Record<string, unknown> = {}) => ({
  repo,
  author: null,
  downloads: 10,
  likes: 1,
  tags: [],
  pipelineTag: 'text-generation',
  installed: false,
  variants: [],
  ...over,
})

describe('phone Discover task chips', () => {
  beforeEach(() => {
    useFixtures({
      'hf.search': {
        models: [card('acme/Qwen2.5-Coder-7B-Instruct'), card('acme/Llama-3.2-3B-Instruct'), card('acme/whisper-small', { pipelineTag: 'automatic-speech-recognition' })],
        device: null,
      },
      'models.downloads': { tasks: [] },
    })
    resetApp({ name: 'hf' })
  })

  it('narrows the list with plain-language chips, without raw tags', async () => {
    render(<Shell />)
    expect(await screen.findByText('Qwen2.5-Coder-7B-Instruct')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Coding' }))
    expect(await screen.findByText('Qwen2.5-Coder-7B-Instruct')).toBeInTheDocument()
    expect(screen.queryByText('Llama-3.2-3B-Instruct')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Small & fast' }))
    expect(await screen.findByText('Llama-3.2-3B-Instruct')).toBeInTheDocument()
    expect(screen.queryByText('Qwen2.5-Coder-7B-Instruct')).not.toBeInTheDocument()
  })
})
