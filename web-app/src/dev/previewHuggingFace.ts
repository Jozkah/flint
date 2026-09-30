/**
 * Development-only example answers for Discover, so the Hugging Face pages can
 * be looked at in a plain browser (`?preview`). The models, counts and files are
 * invented; nothing here talks to Hugging Face, and downloads only report a
 * made-up progress.
 */
import type { HuggingFaceModel } from '@/lib/huggingface'
import { answer } from './previewTauri'

const GB = 1024 ** 3

const model = (
  id: string,
  downloads: number,
  likes: number,
  files: Array<[string, number]>,
  extra: Partial<HuggingFaceModel> = {}
): HuggingFaceModel => ({
  id,
  author: id.split('/')[0],
  downloads,
  likes,
  gated: false,
  tags: ['gguf', 'text-generation'],
  pipelineTag: 'text-generation',
  libraryName: 'gguf',
  lastModified: '2026-09-20T10:00:00Z',
  files: files.map(([name, size]) => ({ name, size: Math.round(size * GB) })),
  ...extra,
})

const MODELS: HuggingFaceModel[] = [
  model('acme-labs/Aurora-8B-Instruct-GGUF', 1_284_000, 3120, [
    ['Aurora-8B-Instruct-Q4_K_M.gguf', 4.9],
    ['Aurora-8B-Instruct-Q5_K_M.gguf', 5.7],
    ['Aurora-8B-Instruct-Q8_0.gguf', 8.5],
  ]),
  model(
    'acme-labs/Aurora-VL-12B-GGUF',
    402_000,
    980,
    [
      ['Aurora-VL-12B-Q4_K_M.gguf', 7.4],
      ['Aurora-VL-12B-Q8_0.gguf', 12.7],
      ['mmproj-Aurora-VL-12B-f16.gguf', 0.9],
    ],
    { pipelineTag: 'image-text-to-text', tags: ['gguf', 'vision'] }
  ),
  model(
    'northwind/Cinder-70B-GGUF',
    88_000,
    640,
    [
      ['Cinder-70B-Q4_K_M.gguf', 42.5],
      ['Cinder-70B-Q2_K.gguf', 26.4],
    ],
    { gated: true }
  ),
  model('northwind/Ember-3B-GGUF', 2_940_000, 5210, [
    ['Ember-3B-Q4_K_M.gguf', 1.9],
    ['Ember-3B-Q8_0.gguf', 3.3],
  ]),
]

export function seedHuggingFacePreview() {
  answer('provider_http_request', (args) => {
    const request = args.request as { url: string; body?: string }
    const action = request.url.replace('flint://huggingface/', '')
    const body = request.body ? JSON.parse(request.body) : {}
    let value: unknown = null
    if (action === 'search') {
      const q = String(body.query ?? '').toLowerCase()
      value = MODELS.filter((m) => !q || m.id.toLowerCase().includes(q))
    } else if (action === 'files') {
      value = MODELS.find((m) => m.id === body.repo)?.files ?? []
    } else if (action === 'readme') {
      value = `# ${body.repo}\n\nExample model card for the browser preview.\n\n## Usage\n\nPick a quantization that fits your memory, then choose **Download**.`
    }
    return {
      status: 200,
      statusText: 'OK',
      headers: {},
      body: JSON.stringify(value),
    }
  })
}
