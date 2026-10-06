/**
 * Development-only: example answers for the Studio page, so it can be looked at
 * in a plain browser (`/studio?preview`). Pictures are generated SVGs, passed
 * as the "file path" because the preview's `convertFileSrc` returns its input.
 */
import { answer } from '@/dev/previewTauri'

const art = (a: string, b: string, shape: 'sun' | 'hills' | 'rings' | 'grid') => {
  const body =
    shape === 'sun'
      ? `<circle cx="256" cy="300" r="120" fill="#fff" opacity=".85"/><rect y="340" width="512" height="172" fill="#000" opacity=".25"/>`
      : shape === 'hills'
        ? `<path d="M0 360 Q120 240 240 340 T512 300 V512 H0Z" fill="#000" opacity=".28"/><path d="M0 420 Q160 330 300 410 T512 380 V512 H0Z" fill="#000" opacity=".25"/>`
        : shape === 'rings'
          ? `<circle cx="256" cy="256" r="180" fill="none" stroke="#fff" stroke-width="10" opacity=".6"/><circle cx="256" cy="256" r="110" fill="none" stroke="#fff" stroke-width="10" opacity=".7"/><circle cx="256" cy="256" r="40" fill="#fff" opacity=".85"/>`
          : `<g stroke="#fff" opacity=".5">${Array.from({ length: 9 }, (_, i) => `<path d="M${i * 64} 0V512M0 ${i * 64}H512"/>`).join('')}</g>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="512" height="512" fill="url(#g)"/>${body}</svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

const recipe = (i: number, prompt: string, seed: number) => ({
  jobId: `job_${i}`,
  kind: 'image' as const,
  prompt,
  negativePrompt: '',
  width: 1024,
  height: 1024,
  steps: 8,
  seed,
  batchSeed: seed,
  modelId: 'z-image-turbo',
  modelName: 'Z-Image Turbo',
  frames: null,
  fps: null,
  createdAtMs: Date.now() - i * 3_600_000,
  durationMs: 41_000 + i * 2_000,
})

export function seedStudioAnswers() {
  const model = (id: string, name: string, kind: 'image' | 'video', files: number[]) => ({
    id,
    display_name: name,
    kind,
    license: 'Apache-2.0',
    files: files.map((size, i) => ({ role: 'diffusion_model', repo: 'example/repo', filename: `file-${i}.gguf`, size, sha256: '' })),
    defaults: { steps: kind === 'video' ? 30 : 8, cfg_scale: 1, sample_method: null, flow_shift: null, width: 1024, height: 1024 },
    video: kind === 'video' ? { fps: 24, frames: 121, min_frames: 5, max_frames: 241 } : null,
    min_side: 16,
    max_side: kind === 'video' ? 1280 : 2048,
    installed: kind === 'image',
    totalBytes: files.reduce((a, b) => a + b, 0),
  })
  answer('diffusion_status', () => ({
    supported: true,
    engineTag: 'master-883-137f740',
    engineBackend: 'vulkan',
    models: [
      model('z-image-turbo', 'Z-Image Turbo', 'image', [5_017_613_376, 335_304_388, 2_497_281_120]),
      model('wan2.2-ti2v-5b', 'Wan 2.2 TI2V 5B', 'video', [3_433_116_000, 1_409_400_960, 3_655_145_312]),
      { ...model('custom-quantstack-qwen-image-gguf-qwen-image-q4-k-m', 'Qwen_Image Q4_K_M', 'image', [13_065_746_976, 253_806_246, 4_683_072_512]), installed: false, custom: true, family: 'qwen-image', license: 'apache-2.0' },
    ],
    resident: { model_id: 'z-image-turbo', kind: 'image', busy: false },
  }))
  const items = [
    ['A lighthouse on a cliff at sunrise, oil painting', '#f59e0b', '#7c3aed', 'sun'],
    ['Rolling green hills under a stormy sky', '#22c55e', '#0ea5e9', 'hills'],
    ['Concentric rings of light, abstract, minimal', '#ec4899', '#6366f1', 'rings'],
    ['Isometric city grid at night, neon', '#14b8a6', '#1e293b', 'grid'],
    ['A fox in a snowy forest, soft light', '#fb7185', '#f59e0b', 'hills'],
    ['Paper boats on a calm lake', '#38bdf8', '#a78bfa', 'sun'],
  ] as const
  answer('diffusion_gallery', (a) =>
    a.kind === 'image'
      ? items.map(([prompt, from, to, shape], i) => ({
          id: `img-${i}`,
          kind: 'image',
          path: art(from, to, shape),
          recipe: recipe(i, prompt, 1000 + i * 7),
        }))
      : []
  )
  answer('diffusion_families', () => [
    { id: 'z-image', label: 'Z-Image', description: 'A fast model.', hints: [], minSide: 16, maxSide: 2048, companionBytes: 2_832_585_508 },
    { id: 'qwen-image', label: 'Qwen-Image', description: 'Strong at text in pictures.', hints: [], minSide: 16, maxSide: 2048, companionBytes: 4_936_878_758 },
    { id: 'flux1', label: 'FLUX.1', description: 'FLUX.1 dev or schnell.', hints: [], minSide: 16, maxSide: 2048, companionBytes: 3_477_572_612 },
  ])
  answer('diffusion_guess_family', () => 'qwen-image')
  answer('plugin:event|listen', () => 1)
  answer('plugin:event|unlisten', () => undefined)
}
