import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@janhq/tauri-plugin-llamacpp-api', () => ({ readGgufMetadata: vi.fn() }))
vi.mock('sonner', () => ({ toast: { warning: vi.fn() } }))
vi.mock('@/i18n/react-i18next-compat', () => ({ i18n: { t: (k: string) => k } }))

import {
  LLAMA_CPP_ARCHITECTURES,
  LLAMA_CPP_ARCHITECTURES_TAG,
} from '@/lib/llamaArchitectures.generated'
import {
  findUnsupportedArchitecture,
  huggingFaceFileUrl,
  isArchitectureSupported,
} from '@/lib/unsupportedArchitecture'
import { startGgufBundle } from '@/lib/huggingfaceStart'

const startBundle = vi.fn()
vi.mock('@/hooks/useHuggingFaceDownloads', () => ({
  startHuggingFaceBundle: (...args: unknown[]) => startBundle(...args),
}))

describe('the bundled architecture list', () => {
  it('matches the llama.cpp tag the app pins', () => {
    const buildRs = readFileSync(
      resolve(process.cwd(), '../src-tauri/plugins/tauri-plugin-llamacpp/build.rs'),
      'utf8'
    )
    const pinned = /LLAMA_CPP_TAG:\s*&str\s*=\s*"(b\d+)"/.exec(buildRs)?.[1]
    // Fails when the engine moves: run scripts/gen-llama-architectures.mjs.
    expect(LLAMA_CPP_ARCHITECTURES_TAG).toBe(pinned)
  })

  it('knows common architectures and not the unreleased one', () => {
    for (const known of ['llama', 'qwen3', 'gemma3', 'dflash']) {
      expect(LLAMA_CPP_ARCHITECTURES).toContain(known)
    }
    expect(isArchitectureSupported('inkling')).toBe(false)
    expect(isArchitectureSupported('LLAMA')).toBe(true)
  })
})

describe('findUnsupportedArchitecture', () => {
  const header = (architecture?: string) =>
    vi.fn().mockResolvedValue({ metadata: architecture ? { 'general.architecture': architecture } : {} })

  it('reads the start of the file at its resolve url', async () => {
    const read = header('llama')
    await findUnsupportedArchitecture({ repo: 'unsloth/Inkling-2-Mini-GGUF', filename: 'a b.gguf', read })
    expect(read).toHaveBeenCalledWith(
      'https://huggingface.co/unsloth/Inkling-2-Mini-GGUF/resolve/main/a%20b.gguf'
    )
    expect(huggingFaceFileUrl('o/r', 'abc', 'sub/x.gguf')).toBe(
      'https://huggingface.co/o/r/resolve/abc/sub/x.gguf'
    )
  })

  it('names an architecture the engine lacks', async () => {
    expect(
      await findUnsupportedArchitecture({ repo: 'o/r', filename: 'm.gguf', read: header('inkling') })
    ).toBe('inkling')
  })

  it('says nothing for a supported, missing or unreadable header', async () => {
    const args = { repo: 'o/r', filename: 'm.gguf' }
    expect(await findUnsupportedArchitecture({ ...args, read: header('qwen3') })).toBeNull()
    expect(await findUnsupportedArchitecture({ ...args, read: header() })).toBeNull()
    expect(
      await findUnsupportedArchitecture({ ...args, read: vi.fn().mockRejectedValue(new Error('401')) })
    ).toBeNull()
  })
})

describe('startGgufBundle', () => {
  const file = { name: 'm-Q4_K_M.gguf', size: 10, sha256: null } as never
  const group = { id: 'g', files: [file], primary: file, kind: 'model', multipart: false } as never
  const base = {
    bundleId: 'b',
    repo: 'o/r',
    modelId: 'm',
    group,
    groups: [group],
    models: {} as never,
  }

  it('does not download when the person declines an unsupported architecture', async () => {
    const { readGgufMetadata } = await import('@janhq/tauri-plugin-llamacpp-api')
    vi.mocked(readGgufMetadata).mockResolvedValue({
      metadata: { 'general.architecture': 'inkling' },
    } as never)
    startBundle.mockClear()
    const confirmUnsupported = vi.fn().mockResolvedValue(false)
    await startGgufBundle({ ...base, confirmUnsupported })
    expect(confirmUnsupported).toHaveBeenCalledWith('inkling')
    expect(startBundle).not.toHaveBeenCalled()

    confirmUnsupported.mockResolvedValue(true)
    await startGgufBundle({ ...base, confirmUnsupported })
    expect(startBundle).toHaveBeenCalledTimes(1)
  })

  it('downloads without asking when the architecture is supported', async () => {
    const { readGgufMetadata } = await import('@janhq/tauri-plugin-llamacpp-api')
    vi.mocked(readGgufMetadata).mockResolvedValue({
      metadata: { 'general.architecture': 'qwen3' },
    } as never)
    startBundle.mockClear()
    const confirmUnsupported = vi.fn()
    await startGgufBundle({ ...base, confirmUnsupported })
    expect(confirmUnsupported).not.toHaveBeenCalled()
    expect(startBundle).toHaveBeenCalledTimes(1)
  })
})
