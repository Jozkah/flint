// The remote-access wire protocol: Studio and dictation. Re-exported by
// protocol.ts; free of app imports.

// ---------------------------------------------------------------------------
// Studio and dictation (the desktop runs both; phones drive them)
// ---------------------------------------------------------------------------

export type StudioKindWire = 'image' | 'video'
export type StudioModelWire = {
  id: string
  name: string
  kind: StudioKindWire
  installed: boolean
  totalBytes: number
  /** Frames a second, for a video model. */
  fps: number | null
}
export type StudioJobWire = {
  kind: StudioKindWire
  prompt: string
  phase: string
  fraction: number
  startedAt: number
  /** How many images this job makes (1 for a video). */
  count: number
}
export type StudioActivityWire = {
  id: number
  kind: StudioKindWire
  prompt: string
  status: 'making' | 'done' | 'failed' | 'stopped'
  error?: string
  durationMs: number
  at: number
}
export type StudioStatusResult = {
  supported: boolean
  engineTag: string
  engineBackend: string | null
  models: StudioModelWire[]
  resident: { modelId: string; kind: StudioKindWire; busy: boolean } | null
  job: StudioJobWire | null
  download: { modelId: string; bytes: number; total: number } | null
  activity: StudioActivityWire[]
  /** Set when video would swap on this computer; must be acknowledged. */
  memoryWarning: string | null
  memoryGb: number | null
  error: string | null
  sizes: Record<StudioKindWire, { label: string; short: string }[]>
  videoSeconds: number[]
}
export type StudioRecipeWire = {
  prompt: string
  negativePrompt: string
  width: number
  height: number
  seed: number
  modelName: string
  frames: number | null
  fps: number | null
  createdAtMs: number
  durationMs: number
}
export type StudioItemWire = { id: string; kind: StudioKindWire; recipe: StudioRecipeWire }
export type StudioGenerateParams = {
  kind: StudioKindWire
  prompt: string
  negative?: string
  sizeIndex?: number
  count?: number
  seconds?: number
  seed?: number
  /** The phone showed the low-memory warning and the user accepted it. */
  memoryAcknowledged?: boolean
}
export type StudioItemParams = { kind: StudioKindWire; id: string }
export type VoiceStatusResult = { ready: boolean }
/** `audio` is base64 16 kHz mono 16-bit WAV. */
export type VoiceTranscribeParams = { audio: string; language?: string }

export type ArchiveKindWire = 'thread' | 'room' | 'cowork' | 'project' | 'assistant' | 'studio'

export type ArchiveItemWire = {
  /** `<kind>:<name in the archive>`; what restore and purge take back. */
  key: string
  kind: ArchiveKindWire
  title: string
  /** Milliseconds since the epoch. */
  archivedAt: number
  sizeBytes: number
}

export type ArchiveListResult = {
  items: ArchiveItemWire[]
  /** Days an archived item is kept before it is deleted; 0 keeps it for good. */
  retentionDays: number
}

export type ArchiveKeyParams = { key: string }

export type ArchiveEmptyResult = {
  purged: number
  /** Items a guard kept (a Cowork session whose worktree holds unmerged work). */
  blocked: { title: string; reason: string }[]
}
