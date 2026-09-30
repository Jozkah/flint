import { invoke } from '@tauri-apps/api/core'

export type HuggingFaceFormat = 'gguf' | 'mlx' | 'all'

export type HuggingFaceModel = {
  id: string
  author?: string | null
  sha?: string | null
  downloads: number
  likes: number
  gated: boolean
  private?: boolean
  disabled?: boolean
  tags: string[]
  pipelineTag?: string | null
  libraryName?: string | null
  createdAt?: string | null
  lastModified?: string | null
  cardData?: Record<string, unknown> | null
}

export type HuggingFaceFile = {
  name: string
  size?: number | null
  sha256?: string | null
}

export type HuggingFaceDownloadProgress = {
  taskId: string
  downloaded: number
  total?: number | null
}

type NativeResponse = {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
}

async function call<T>(
  action: 'search' | 'files' | 'readme' | 'download' | 'cancel',
  payload: Record<string, unknown>
): Promise<T> {
  const response = await invoke<NativeResponse>('provider_http_request', {
    request: {
      url: `flint://huggingface/${action}`,
      method: 'POST',
      headers: {},
      body: JSON.stringify(payload),
    },
  })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(response.statusText || `Hugging Face request failed (${response.status})`)
  }
  return JSON.parse(response.body) as T
}

export async function searchHuggingFaceModels(
  query: string,
  token?: string,
  format: HuggingFaceFormat = 'gguf'
): Promise<HuggingFaceModel[]> {
  return call<HuggingFaceModel[]>('search', { query, token, format })
}

export async function getHuggingFaceFiles(
  repo: string,
  token?: string
): Promise<HuggingFaceFile[]> {
  return call<HuggingFaceFile[]>('files', { repo, token })
}

export async function getHuggingFaceReadme(
  repo: string,
  token?: string
): Promise<string> {
  return call<string>('readme', { repo, token })
}

export async function downloadHuggingFaceFile(args: {
  taskId: string
  repo: string
  filename: string
  expectedSize?: number | null
  expectedSha256?: string | null
  token?: string
}): Promise<string> {
  return call<string>('download', args)
}

export async function cancelHuggingFaceDownload(taskId: string): Promise<void> {
  await call<null>('cancel', { taskId })
}

export function cleanHuggingFaceRepo(value: string): string {
  let text = value.trim()
  text = text.replace(/^https?:\/\/(www\.)?huggingface\.co\//i, '')
  text = text.replace(/^models\//i, '')
  text = text.split(/[?#]/)[0]
  const parts = text.split('/').filter(Boolean)
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : text
}

export function quantizationFromFilename(filename: string): string | null {
  const upper = filename.toUpperCase()
  const known = [
    'IQ1_S', 'IQ1_M', 'IQ2_XXS', 'IQ2_XS', 'IQ2_S', 'IQ2_M',
    'IQ3_XXS', 'IQ3_XS', 'IQ3_S', 'IQ3_M', 'IQ4_XS', 'IQ4_NL',
    'Q2_K', 'Q2_K_S', 'Q3_K_S', 'Q3_K_M', 'Q3_K_L',
    'Q4_0', 'Q4_1', 'Q4_K_S', 'Q4_K_M', 'Q4_K_L',
    'Q5_0', 'Q5_1', 'Q5_K_S', 'Q5_K_M', 'Q5_K_L',
    'Q6_K', 'Q6_K_L', 'Q8_0', 'Q8_K', 'F16', 'F32', 'BF16',
  ]
  return known.find((q) => upper.includes(q)) ?? null
}

export function explainQuantization(quant: string | null): string {
  if (!quant) return 'Unknown quantization'
  const q = quant.toUpperCase()
  if (q === 'F32' || q === 'BF16' || q === 'F16') return 'Highest fidelity, very large memory footprint'
  if (q.startsWith('Q8')) return 'Near-original quality, large memory footprint'
  if (q.startsWith('Q6')) return 'Very high quality with moderate compression'
  if (q.startsWith('Q5')) return 'High quality and a strong quality/size trade-off'
  if (q === 'Q4_K_M' || q === 'IQ4_XS' || q === 'Q4_K_L') return 'Recommended balance of quality, speed, and memory for most systems'
  if (q.startsWith('Q4')) return 'Balanced size and quality for everyday local inference'
  if (q.startsWith('Q3') || q.startsWith('IQ3')) return 'Smaller and faster, with a noticeable quality trade-off'
  if (q.startsWith('Q2') || q.startsWith('IQ2') || q.startsWith('IQ1')) return 'Very small footprint with the largest quality trade-off'
  return 'Quantized GGUF model'
}

export type SplitInfo = { index: number; total: number; base: string }

export function splitInfo(filename: string): SplitInfo | null {
  const match = filename.match(/^(.*?)-(\d{5})-of-(\d{5})\.gguf$/i)
  if (!match) return null
  const index = Number(match[2])
  const total = Number(match[3])
  if (!Number.isFinite(index) || !Number.isFinite(total) || index < 1 || total < 2) return null
  return { index, total, base: match[1] }
}

export type HuggingFaceFileGroup = {
  id: string
  files: HuggingFaceFile[]
  primary: HuggingFaceFile
  quantization: string | null
  totalSize: number | null
  multipart: boolean
  kind: 'model' | 'mmproj' | 'draft'
}

function fileKind(name: string): HuggingFaceFileGroup['kind'] {
  const lower = name.toLowerCase()
  if (lower.includes('mmproj')) return 'mmproj'
  if (/(^|[-_.])(draft|mtp|eagle|dflash|dspark)([-_.]|$)/i.test(lower)) return 'draft'
  return 'model'
}

export function isGgufFile(file: HuggingFaceFile): boolean {
  return file.name.toLowerCase().endsWith('.gguf')
}

export function isMlxRuntimeFile(file: HuggingFaceFile): boolean {
  const lower = file.name.toLowerCase()
  if (lower.startsWith('.git') || lower.includes('/.git')) return false
  if (/\.(png|jpe?g|gif|webp|svg|md|pdf|zip|tar|gz)$/i.test(lower)) return false
  return /\.(safetensors|json|txt|model|tiktoken|jinja|yaml|yml)$/i.test(lower) ||
    /(^|\/)(tokenizer|vocab|merges|config|generation_config|special_tokens_map)(\.|$)/i.test(lower)
}

export function groupHuggingFaceFiles(files: HuggingFaceFile[]): HuggingFaceFileGroup[] {
  const groups = new Map<string, HuggingFaceFile[]>()
  for (const file of files.filter(isGgufFile)) {
    const split = splitInfo(file.name)
    const key = split ? `${fileKind(file.name)}:${split.base}` : `${fileKind(file.name)}:${file.name}`
    const list = groups.get(key) ?? []
    list.push(file)
    groups.set(key, list)
  }
  return [...groups.entries()].map(([id, grouped]) => {
    const sorted = [...grouped].sort((a, b) => {
      const ai = splitInfo(a.name)?.index ?? 0
      const bi = splitInfo(b.name)?.index ?? 0
      return ai - bi || a.name.localeCompare(b.name)
    })
    const knownSizes = sorted.map((f) => f.size).filter((n): n is number => typeof n === 'number')
    return {
      id,
      files: sorted,
      primary: sorted[0],
      quantization: quantizationFromFilename(sorted[0].name),
      totalSize: knownSizes.length === sorted.length ? knownSizes.reduce((a, b) => a + b, 0) : null,
      multipart: sorted.length > 1,
      kind: fileKind(sorted[0].name),
    }
  })
}

export function chooseMmproj(groups: HuggingFaceFileGroup[]): HuggingFaceFileGroup | null {
  const mmproj = groups.filter((group) => group.kind === 'mmproj')
  return (
    mmproj.find((group) => /f16/i.test(group.primary.name)) ??
    mmproj.find((group) => /q8/i.test(group.primary.name)) ??
    mmproj[0] ??
    null
  )
}

export function chooseDraft(
  groups: HuggingFaceFileGroup[],
  model: HuggingFaceFileGroup
): HuggingFaceFileGroup | null {
  const drafts = groups.filter((group) => group.kind === 'draft')
  const quant = model.quantization?.toLowerCase()
  if (quant) {
    const sameQuant = drafts.find((group) => group.primary.name.toLowerCase().includes(quant))
    if (sameQuant) return sameQuant
  }
  return drafts[0] ?? null
}

export function modelIdForGroup(repo: string, group: HuggingFaceFileGroup): string {
  const raw = (splitInfo(group.primary.name)?.base ?? group.primary.name)
    .replace(/\.gguf$/i, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${repo}/${raw || 'model'}`
}

export function mlxModelId(repo: string): string {
  return repo
}

export function inferParameterCount(model: HuggingFaceModel): number | null {
  const haystack = [model.id, ...model.tags].join(' ')
  const matches = [...haystack.matchAll(/(?:^|[-_\s])(\d+(?:\.\d+)?)\s*[bB](?:[-_\s]|$)/g)]
  if (!matches.length) return null
  const values = matches.map((m) => Number(m[1])).filter(Number.isFinite)
  return values.length ? Math.max(...values) : null
}

export function inferArchitecture(model: HuggingFaceModel): string | null {
  const haystack = [model.id, ...model.tags].join(' ').toLowerCase()
  const names = [
    'qwen3', 'qwen2', 'llama', 'gemma', 'mistral', 'mixtral', 'phi', 'deepseek',
    'command-r', 'yi', 'falcon', 'starcoder', 'codellama', 'granite', 'smollm',
  ]
  return names.find((name) => haystack.includes(name)) ?? null
}

export function inferModalities(model: HuggingFaceModel, files: HuggingFaceFile[] = []): string[] {
  const tags = model.tags.map((t) => t.toLowerCase())
  const out = new Set<string>()
  if (model.pipelineTag?.includes('image') || tags.some((t) => /vision|multimodal|image-text/.test(t))) out.add('vision')
  if (model.pipelineTag?.includes('audio') || tags.some((t) => /audio|speech/.test(t))) out.add('audio')
  if (tags.some((t) => /embedding|feature-extraction/.test(t))) out.add('embedding')
  if (files.some((f) => f.name.toLowerCase().includes('mmproj'))) out.add('multimodal')
  if (!out.size) out.add('text')
  return [...out]
}

export function formatModelBytes(value?: number | null): string {
  if (!value || value <= 0) return 'Unknown size'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let amount = value
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit += 1
  }
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`
}

export function repoLooksMlx(model: HuggingFaceModel): boolean {
  const tags = model.tags.map((t) => t.toLowerCase())
  return tags.includes('mlx') || /(^|[-_/])mlx([-_/]|$)/i.test(model.id) || model.libraryName?.toLowerCase() === 'mlx'
}

export function repoLooksGguf(model: HuggingFaceModel): boolean {
  return model.tags.some((tag) => tag.toLowerCase() === 'gguf') || /gguf/i.test(model.id)
}
