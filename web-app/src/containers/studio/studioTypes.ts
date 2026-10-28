import { VIDEO_SECONDS } from '@/lib/studio/helpers'
import { type EngineBuild, type StudioLora } from '@/lib/studio/studio'

export const BUILDS: Array<{ id: EngineBuild; label: 'anyGpu' | 'noGpu' | 'nvidia' }> = [
  { id: 'linux-vulkan-x64', label: 'anyGpu' },
  { id: 'linux-cpu-x64', label: 'noGpu' },
  { id: 'win-vulkan-x64', label: 'anyGpu' },
  { id: 'win-cuda12-x64', label: 'nvidia' },
  { id: 'win-cpu-x64', label: 'noGpu' },
]

export type T = (key: string, options?: Record<string, unknown>) => string

/** What the left column and the stage share: the prompt and the options. */
export type Form = {
  prompt: string
  negative: string
  seed: string
  /** The index of a standard shape, or `CUSTOM` for the two boxes. */
  sizeIndex: number
  customWidth: string
  customHeight: string
  /** `provider/model` of a hosted image model, or empty for the model on this computer. */
  cloud: string
  /** The local model chosen, or empty for the first one of the kind. */
  localModel: string
  count: number
  seconds: number
  accepted: boolean
  loras: StudioLora[]
}

export const CUSTOM = -1

export const EMPTY_FORM: Form = {
  prompt: '',
  negative: '',
  seed: '',
  sizeIndex: 0,
  customWidth: '1024',
  customHeight: '1024',
  cloud: '',
  localModel: '',
  count: 1,
  seconds: VIDEO_SECONDS[VIDEO_SECONDS.length - 1],
  accepted: false,
  loras: [],
}
