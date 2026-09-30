export type HuggingFaceInstallRecord = {
  modelId: string
  repo: string
  revision?: string | null
  files: string[]
  installedAt: number
  provider: 'llamacpp' | 'mlx'
}

const KEY = 'flint.huggingface.installs.v1'

function readAll(): Record<string, HuggingFaceInstallRecord> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeAll(records: Record<string, HuggingFaceInstallRecord>) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(KEY, JSON.stringify(records))
  } catch {
    // Provenance is advisory. A full localStorage must not make an import fail.
  }
}

export function recordHuggingFaceInstall(record: HuggingFaceInstallRecord) {
  const records = readAll()
  records[record.modelId] = record
  writeAll(records)
}

export function getHuggingFaceInstall(modelId: string): HuggingFaceInstallRecord | undefined {
  return readAll()[modelId]
}

export function removeHuggingFaceInstall(modelId: string) {
  const records = readAll()
  delete records[modelId]
  writeAll(records)
}

export function hasHuggingFaceUpdate(modelId: string, revision?: string | null): boolean {
  if (!revision) return false
  const installed = getHuggingFaceInstall(modelId)
  return Boolean(installed?.revision && installed.revision !== revision)
}
