import { invoke } from '@tauri-apps/api/core'
import { join } from '@tauri-apps/api/path'
import { useNavigate } from '@tanstack/react-router'
import {
  Check,
  Download,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { route } from '@/constants/routes'
import {
  cancelHuggingFaceBundle,
  pauseHuggingFaceBundle,
  resumeHuggingFaceBundle,
  retryHuggingFaceBundle,
  startHuggingFaceBundle,
  useHuggingFaceDownloads,
} from '@/hooks/useHuggingFaceDownloads'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { ExtensionManager } from '@/lib/extension'
import {
  formatModelBytes,
  isMlxRuntimeFile,
  mlxModelId,
  modelIdForGroup,
  type HuggingFaceFile,
  type HuggingFaceFileGroup,
} from '@/lib/huggingface'
import {
  hasHuggingFaceUpdate,
  recordHuggingFaceInstall,
} from '@/lib/huggingfaceRegistry'
import { cn } from '@/lib/utils'
import { formatEta, secondsRemaining } from '@/lib/downloadSpeed'
import { startGgufBundle } from '@/lib/huggingfaceStart'

export type HuggingFaceDownloadActionProps = {
  repo: string
  revision?: string | null
  group?: HuggingFaceFileGroup
  groups?: HuggingFaceFileGroup[]
  files?: HuggingFaceFile[]
  format?: 'gguf' | 'mlx'
  compact?: boolean
  className?: string
}

export function HuggingFaceDownloadAction({
  repo,
  revision,
  group,
  groups = [],
  files = [],
  format = 'gguf',
  compact = false,
  className,
}: HuggingFaceDownloadActionProps) {
  const navigate = useNavigate()
  const token = useGeneralSetting((state) => state.huggingfaceToken)
  const serviceHub = useServiceHub()
  const providers = useModelProvider((state) => state.providers)

  const modelId = format === 'mlx'
    ? mlxModelId(repo)
    : group
      ? modelIdForGroup(repo, group)
      : repo
  const providerName = format === 'mlx' ? 'mlx' : 'llamacpp'
  const provider = providers.find((candidate) => candidate.provider === providerName)
  const installed = Boolean(provider?.models.some((model) => model.id === modelId))
  const updateAvailable = installed && hasHuggingFaceUpdate(modelId, revision)
  const bundleId = `hf:${providerName}:${modelId}`
  const task = useHuggingFaceDownloads((state) => state.tasks[bundleId])

  const useModel = () => {
    navigate({
      to: route.home,
      search: { threadModel: { id: modelId, provider: providerName } },
    })
  }

  const start = async () => {
    try {
      if (format === 'mlx') {
        const runtimeFiles = files.filter(isMlxRuntimeFile)
        if (!runtimeFiles.some((file) => file.name.toLowerCase().endsWith('.safetensors'))) {
          throw new Error('This repository does not contain MLX safetensors files.')
        }
        await startHuggingFaceBundle({
          id: bundleId,
          repo,
          label: modelId,
          files: runtimeFiles,
          token,
          onComplete: async () => {
            if (updateAvailable) {
              await serviceHub.models().deleteModel(modelId, 'mlx').catch(() => {})
            }
            const dataRoot = await invoke<string>('get_jan_data_folder_path')
            const folder = await join(dataRoot, 'downloads', 'huggingface', ...repo.split('/'))
            const engine = ExtensionManager.getInstance().getEngine('mlx')
            if (!engine) throw new Error('MLX engine is not available on this system.')
            await engine.import(modelId, { modelPath: folder })
            recordHuggingFaceInstall({
              modelId,
              repo,
              revision,
              files: runtimeFiles.map((file) => file.name),
              installedAt: Date.now(),
              provider: 'mlx',
            })
          },
        })
        return
      }

      if (!group) throw new Error('No GGUF variant selected.')
      await startGgufBundle({
        bundleId,
        repo,
        revision,
        modelId,
        group,
        groups,
        token,
        replace: updateAvailable,
        models: serviceHub.models(),
      })
    } catch (error) {
      toast.error('Could not start model download', {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (task && ['downloading', 'queued', 'verifying', 'importing'].includes(task.status)) {
    const percent = Math.round(task.progress * 100)
    return (
      <div className={cn('flex min-w-0 items-center gap-2', compact ? 'w-44' : 'w-56', className)}>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span className="truncate">
              {task.status === 'importing'
                ? 'Installing…'
                : task.status === 'verifying'
                  ? 'Verifying…'
                  : `${percent}%`}
            </span>
            {compact && task.status === 'downloading' && Boolean(task.bytesPerSecond) && (
              <span className="shrink-0 tabular-nums">{formatModelBytes(task.bytesPerSecond as number)}/s</span>
            )}
            {!compact && task.total && (
              <span className="shrink-0 tabular-nums">
                {formatModelBytes(task.downloaded)} / {formatModelBytes(task.total)}
                {task.status === 'downloading' && task.bytesPerSecond
                  ? ` · ${formatModelBytes(task.bytesPerSecond)}/s${
                      secondsRemaining(task.downloaded, task.total, task.bytesPerSecond) !== null
                        ? ` · ${formatEta(
                            secondsRemaining(task.downloaded, task.total, task.bytesPerSecond) as number
                          )} left`
                        : ''
                    }`
                  : ''}
              </span>
            )}
          </div>
          <Progress value={task.progress * 100} className="h-1.5" />
        </div>
        {task.status === 'downloading' && (
          <Button variant="ghost" size="icon" className="size-7 shrink-0" onClick={() => void pauseHuggingFaceBundle(bundleId)} title="Pause download">
            <Pause className="size-3.5" />
          </Button>
        )}
      </div>
    )
  }

  if (task?.status === 'paused') {
    return (
      <div className={cn('flex items-center gap-1.5', className)}>
        <Button variant="outline" size="sm" onClick={() => void resumeHuggingFaceBundle(bundleId)}>
          <Play className="size-3.5" /> Resume
        </Button>
        <Button variant="ghost" size="icon" className="size-8" onClick={() => void cancelHuggingFaceBundle(bundleId)} title="Cancel download">
          <X className="size-3.5" />
        </Button>
      </div>
    )
  }

  if (task?.status === 'error') {
    return (
      <div className={cn('flex max-w-72 items-center gap-2', className)} title={task.error}>
        <span className="min-w-0 line-clamp-2 text-right text-xs text-destructive">
          Download failed{task.error ? `: ${task.error}` : ''}
        </span>
        <Button variant="outline" size="sm" className="shrink-0" onClick={() => void retryHuggingFaceBundle(bundleId)}>
          <RotateCcw className="size-3.5" /> Retry
        </Button>
      </div>
    )
  }

  if (task?.status === 'complete' || (installed && !updateAvailable)) {
    return (
      <div className={cn('flex items-center gap-2', className)}>
        <span className="flex items-center gap-1 text-xs text-emerald-500">
          <Check className="size-3.5" /> Installed
        </span>
        <Button size="sm" onClick={useModel}>New Chat</Button>
      </div>
    )
  }

  return (
    <Button variant="outline" size="sm" onClick={() => void start()} className={className}>
      {updateAvailable ? <RefreshCw className="size-3.5" /> : <Download className="size-3.5" />}
      {updateAvailable ? 'Update' : 'Download'}
    </Button>
  )
}
