/* eslint-disable @typescript-eslint/no-explicit-any */
// Renders the whole Studio page with an installed model, so every panel
// (model, settings, prompt, activity, generations) mounts once. A hook read
// before its declaration crashed the page for everyone; this catches it.
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { StudioModel, StudioStatus } from '@/lib/studio/studio'

const model: StudioModel = {
  id: 'sd-turbo',
  display_name: 'SD Turbo',
  kind: 'image',
  license: 'mit',
  files: [],
  defaults: {
    steps: 4,
    cfg_scale: 1,
    sample_method: null,
    flow_shift: null,
    width: 512,
    height: 512,
  },
  video: null,
  min_side: 256,
  max_side: 1024,
  installed: true,
  totalBytes: 1000,
}
const status: StudioStatus = {
  supported: true,
  engineTag: 'b1',
  engineBackend: 'cpu',
  models: [model],
  resident: null,
}

vi.mock('@/lib/studio/studio', async (orig) => {
  const real: any = await orig()
  return {
    ...real,
    studioApi: new Proxy(
      {},
      {
        get: (_t, key) =>
          key === 'status'
            ? async () => status
            : key === 'gallery'
              ? async () => []
              : async () => undefined,
      }
    ),
  }
})

vi.mock('@tanstack/react-router', async (orig) => ({
  ...((await orig()) as any),
  useNavigate: () => vi.fn(),
}))

import { StudioPage } from '../StudioPage'
import { useStudio } from '@/hooks/useStudio'

describe('StudioPage', () => {
  it('renders every panel without throwing', async () => {
    useStudio.setState({
      status,
      refresh: async () => {},
      refreshGallery: async () => {},
    } as any)
    const errors: unknown[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => {
      errors.push(...a)
    })
    try {
      render(<StudioPage />)
      // The prompt box lives in PromptPanel, the panel that crashed.
      expect(await screen.findAllByRole('textbox')).not.toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
    expect(
      errors.map(String).filter((e) => /before initialization|ReferenceError/.test(e))
    ).toEqual([])
  })
})
