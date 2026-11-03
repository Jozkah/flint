import { matchesTask, type HubTaskId } from '@/lib/hubTasks'
import {
  inferArchitecture,
  inferParameterCount,
  pinExactRepo,
  type HuggingFaceFile,
  type HuggingFaceModel,
} from '@/lib/huggingface'
import { pinQueryMatches } from '@/lib/huggingfaceSearch'

export type SortMode = 'downloads' | 'likes' | 'updated' | 'newest'
export type ParamFilter = 'all' | 'tiny' | 'small' | 'medium' | 'large'

/** Everything the Hub's filter bar controls, in one value. */
export type HubFilters = {
  sort: SortMode
  params: ParamFilter
  architecture: string
  task: HubTaskId
  includeGated: boolean
  downloadedOnly: boolean
  /** Hide repos whose best variant is larger than this machine's memory. */
  fitsOnly: boolean
}

export function defaultFilters(): HubFilters {
  return {
    sort: 'downloads',
    params: 'all',
    architecture: 'all',
    task: 'all',
    includeGated: true,
    downloadedOnly: false,
    fitsOnly: false,
  }
}

/** True when any filter (sort excluded) narrows the list. */
export function filtersActive(filters: HubFilters): boolean {
  const base = defaultFilters()
  return (
    filters.params !== base.params ||
    filters.architecture !== base.architecture ||
    filters.task !== base.task ||
    filters.downloadedOnly !== base.downloadedOnly ||
    filters.fitsOnly !== base.fitsOnly ||
    filters.includeGated !== base.includeGated
  )
}

/** Resets the narrowing filters and keeps the chosen sort. */
export function clearedFilters(filters: HubFilters): HubFilters {
  return { ...defaultFilters(), sort: filters.sort }
}

export function inParameterBucket(
  value: number | null,
  bucket: ParamFilter
): boolean {
  if (bucket === 'all') return true
  if (value == null) return false
  if (bucket === 'tiny') return value < 3
  if (bucket === 'small') return value >= 3 && value < 8
  if (bucket === 'medium') return value >= 8 && value < 34
  return value >= 34
}

export type HubFilterContext = {
  query: string
  filesFor: (model: HuggingFaceModel) => HuggingFaceFile[]
  isInstalled: (model: HuggingFaceModel) => boolean
  /** Whether the repo's best variant fits this machine. */
  fitsHardware: (
    model: HuggingFaceModel,
    files: HuggingFaceFile[],
    parameterBillions: number | null
  ) => boolean
}

/** Filters, sorts and query-pins a list of repos. Pure. */
export function applyFilters(
  models: HuggingFaceModel[],
  filters: HubFilters,
  ctx: HubFilterContext
): HuggingFaceModel[] {
  const filtered = models.filter((model) => {
    const parameterCount = inferParameterCount(model)
    const files = ctx.filesFor(model)
    return (
      inParameterBucket(parameterCount, filters.params) &&
      (filters.architecture === 'all' ||
        inferArchitecture(model) === filters.architecture) &&
      matchesTask(model, files, filters.task) &&
      (filters.includeGated || !model.gated) &&
      (!filters.downloadedOnly || ctx.isInstalled(model)) &&
      (!filters.fitsOnly || ctx.fitsHardware(model, files, parameterCount))
    )
  })

  const sorted = filtered.sort((a, b) => {
    if (filters.sort === 'likes') return b.likes - a.likes
    if (filters.sort === 'updated') {
      return Date.parse(b.lastModified ?? '') - Date.parse(a.lastModified ?? '')
    }
    if (filters.sort === 'newest') {
      return Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? '')
    }
    return b.downloads - a.downloads
  })
  // A pasted exact repo id comes first, whatever the sort says.
  return pinExactRepo(pinQueryMatches(sorted, ctx.query), ctx.query)
}
