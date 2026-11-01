import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Folder,
  Globe,
  RefreshCw,
  Trash2,
  UploadIcon,
  AlertCircle,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Progress } from '@/components/ui/progress'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn, formatBytes } from '@/lib/utils'
import { toast } from 'sonner'
import { useServiceHub } from '@/hooks/useServiceHub'
import { createDocumentAttachment } from '@/types/attachment'
import { useAttachments } from '@/hooks/useAttachments'
import { ExtensionTypeEnum, VectorDBExtension } from '@janhq/core'
import { ExtensionManager } from '@/lib/extension'
import { Loader2, Paperclip } from 'lucide-react'
import { useProjectUploads } from '@/stores/project-uploads-store'
import {
  SUPPORTED_EXTENSIONS,
  getFilesFromPaths,
  maxBytesOf,
  prepareDocumentAttachments,
  splitDuplicates,
} from '@/lib/documentIngest'
import { useProjectFileDrop } from '@/hooks/useProjectFileDrop'
import { buildProjectFileTree, type TreeNode } from '@/lib/projectFileTree'
import {
  checkProjectFiles,
  reindexProjectFile,
  type ProjectFileFreshness,
} from '@/lib/projectFileFreshness'
import { useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { AddWebPageDialog, useRefreshWebPage } from '@/containers/AddWebPageDialog'
import {
  useProjectUrlSources,
  type UrlSource,
} from '@/stores/project-url-sources-store'

type ProjectFilesProps = {
  projectId: string
  lng: string
}

function extractRagErrorMessage(error: unknown): {
  kind: 'parse' | 'unsupported' | 'io' | 'unknown'
  message: string
} {
  if (error && typeof error === 'object') {
    const obj = error as Record<string, unknown>
    if (typeof obj.ParseError === 'string')
      return { kind: 'parse', message: obj.ParseError }
    if (typeof obj.UnsupportedFileType === 'string')
      return { kind: 'unsupported', message: obj.UnsupportedFileType }
    if (typeof obj.IoError === 'string')
      return { kind: 'io', message: obj.IoError }
    if (error instanceof Error)
      return { kind: 'unknown', message: error.message }
  }
  if (typeof error === 'string') return { kind: 'unknown', message: error }
  return { kind: 'unknown', message: '' }
}

type TFn = (key: string, opts?: Record<string, unknown>) => string

/** Ingestion failed because no embedding model is installed to index the file. */
export function isMissingEmbeddingModel(error: unknown): boolean {
  return /no embedding model/i.test(extractRagErrorMessage(error).message)
}

function humanizeUploadError(
  t: TFn,
  error: unknown,
  fileName?: string
): string {
  const { kind, message } = extractRagErrorMessage(error)
  const subject = fileName
    ? `"${fileName}"`
    : (t('common:toast.uploadFailed.subjectThisFile') ?? 'This file')
  const lower = message.toLowerCase()

  if (isMissingEmbeddingModel(error)) {
    return t('common:toast.uploadFailed.noEmbeddingModel', { subject })
  }

  if (kind === 'parse' && lower.includes('pdf')) {
    if (
      lower.includes('cross-reference') ||
      lower.includes('xref') ||
      lower.includes('invalid start value')
    ) {
      return t('common:toast.uploadFailed.pdfMalformedXref', { subject })
    }
    if (lower.includes('image-based') || lower.includes('scanned')) {
      return t('common:toast.uploadFailed.pdfScanned', { subject })
    }
    if (lower.includes('file too large')) {
      return t('common:toast.uploadFailed.fileTooLarge', { subject, message })
    }
    if (lower.includes('encrypted') || lower.includes('password')) {
      return t('common:toast.uploadFailed.pdfEncrypted', { subject })
    }
    // pdf-extract hard-fails on PDF features it doesn't implement (e.g. a
    // PostScript "unhandled function type" used for color/shading).
    if (
      lower.includes('function type') ||
      lower.includes('not implemented') ||
      lower.includes('unsupported')
    ) {
      return t('common:toast.uploadFailed.pdfUnsupportedFeature', { subject })
    }
    return t('common:toast.uploadFailed.pdfGeneric', { subject })
  }

  if (kind === 'parse' && lower.includes('file too large')) {
    return t('common:toast.uploadFailed.fileTooLarge', { subject, message })
  }

  if (kind === 'unsupported') {
    return t('common:toast.uploadFailed.unsupportedType', { type: message })
  }

  if (kind === 'io') {
    return t('common:toast.uploadFailed.ioError', { subject, message })
  }

  if (kind === 'parse') {
    return t('common:toast.uploadFailed.parseGeneric', { subject, message })
  }

  return (
    message || t('common:toast.uploadFailed.fallback', { subject })
  )
}

type ProjectFile = {
  id: string
  name?: string
  path?: string
  type?: string
  size?: number
  chunk_count: number
  mtime?: number | null
}

type FileRowProps = {
  file: ProjectFile
  onDelete: (id: string) => void
  /** Source on disk vs the indexed copy; only changed/missing show a badge. */
  freshness?: ProjectFileFreshness
  onReindex?: (id: string) => void
  reindexing?: boolean
  t: ReturnType<typeof useTranslation>['t']
  /** Folder depth, for the indent when files are shown as a tree. */
  depth?: number
  /** Set when the file was added from a web page (a URL row). */
  source?: UrlSource
  onRefresh?: () => void
  refreshing?: boolean
}

function FileRow({
  file,
  onDelete,
  freshness,
  onReindex,
  reindexing = false,
  t,
  depth = 0,
  source,
  onRefresh,
  refreshing,
}: FileRowProps) {
  const [menuOpen, setMenuOpen] = useState(false)

  const openContextMenu = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setMenuOpen(true)
  }

  const onRowKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      openContextMenu(e)
    }
  }

  return (
    <div
      className={cn(
        'flex items-center gap-2 p-2 rounded-md',
        'bg-card border border-border',
        'group hover:bg-muted transition-colors'
      )}
      style={depth > 0 ? { marginLeft: depth * 16 } : undefined}
      onContextMenu={openContextMenu}
      onKeyDown={onRowKeyDown}
    >
      <div className="shrink-0">
        {source ? (
          <Globe className="size-4 text-muted-foreground" />
        ) : (
          <Paperclip className="size-4 text-muted-foreground" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <p className="text-sm font-medium truncate">{file.name}</p>
          </TooltipTrigger>
          <TooltipContent>
            <p className="text-xs">{file.name}</p>
          </TooltipContent>
        </Tooltip>
        <p className="text-xs text-muted-foreground">
          {file.size
            ? formatBytes(file.size, {
                decimals: (_, unit) => (unit === 'B' ? 0 : 1),
              })
            : ''}
          {file.chunk_count > 0 &&
            ` · ${t('common:files.chunksCount', { count: file.chunk_count })}`}
        </p>
        {source && (
          <p
            className="text-xs text-muted-foreground truncate"
            title={source.url}
            data-testid="project-file-url"
          >
            {source.url}
          </p>
        )}
      </div>
      {freshness === 'changed' && (
        <span
          data-testid="project-file-changed"
          className="shrink-0 rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-xs text-warning"
        >
          {t('common:projects.fileChangedOnDisk')}
        </span>
      )}
      {freshness === 'missing' && (
        <span
          data-testid="project-file-missing"
          className="shrink-0 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-xs text-destructive"
        >
          {t('common:projects.fileMissing')}
        </span>
      )}
      {freshness === 'changed' && onReindex && (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => onReindex(file.id)}
          disabled={reindexing}
          aria-label={`${t('common:projects.reindexFile')} ${file.name}`}
          title={t('common:projects.reindexFile')}
        >
          <RefreshCw
            className={cn(
              'size-3.5 text-muted-foreground',
              reindexing && 'animate-spin motion-reduce:animate-none'
            )}
            aria-hidden
          />
        </Button>
      )}
      {source && onRefresh && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 pointer-coarse:size-11 transition-opacity"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label={`${t('common:projects.webPage.refresh')} ${file.name}`}
          title={t('common:projects.webPage.refresh')}
        >
          <RefreshCw
            className={cn(
              'size-3.5 text-muted-foreground',
              refreshing && 'animate-spin motion-reduce:animate-none'
            )}
            aria-hidden
          />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 pointer-coarse:size-11 transition-opacity"
        onClick={() => onDelete(file.id)}
        aria-label={`${t('common:delete')} ${file.name}`}
        title={t('common:delete')}
      >
        <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" aria-hidden />
      </Button>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger className="sr-only" tabIndex={-1} />
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => navigator.clipboard.writeText(file.name ?? '')}
          >
            <Copy className="size-4 mr-2" />
            {t('common:copyFileName')}
          </DropdownMenuItem>
          {source && onRefresh && (
            <DropdownMenuItem onClick={onRefresh} disabled={refreshing}>
              <RefreshCw className="size-4 mr-2" />
              {t('common:projects.webPage.refresh')}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => onDelete(file.id)}
          >
            <Trash2 className="size-4 mr-2" />
            {t('common:delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export default function ProjectFiles({ projectId, lng }: ProjectFilesProps) {
  const { t } = useTranslation(lng)
  const serviceHub = useServiceHub()
  const attachmentsEnabled = useAttachments((s) => s.enabled)
  const maxFileSizeMB = useAttachments((s) => s.maxFileSizeMB)

  const [files, setFiles] = useState<ProjectFile[]>([])
  const [freshness, setFreshness] = useState<
    Record<string, ProjectFileFreshness>
  >({})
  const [reindexingIds, setReindexingIds] = useState<Set<string>>(
    () => new Set()
  )
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    () => new Set()
  )
  const fileTree = useMemo(() => buildProjectFileTree(files), [files])

  const toggleFolder = (id: string) =>
    setCollapsedFolders((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })

  const renderNodes = (nodes: TreeNode<ProjectFile>[], depth: number) =>
    nodes.map((node) => {
      if (node.kind === 'file') {
        return (
          <FileRow
            key={node.file.id}
            file={node.file}
            onDelete={requestDeleteFile}
            freshness={freshness[node.file.id]}
            onReindex={(id) => void handleReindex([id])}
            reindexing={reindexingIds.has(node.file.id)}
            t={t}
            depth={depth}
            source={node.file.path ? urlSources?.[node.file.path] : undefined}
            onRefresh={() => {
              const src = node.file.path ? urlSources?.[node.file.path] : undefined
              if (src) void refreshWebPage(node.file.id, src)
            }}
            refreshing={refreshingId === node.file.id}
          />
        )
      }
      const collapsed = collapsedFolders.has(node.id)
      const Chevron = collapsed ? ChevronRight : ChevronDown
      return (
        <div key={`folder:${node.id}`} className="space-y-2">
          <button
            type="button"
            onClick={() => toggleFolder(node.id)}
            aria-expanded={!collapsed}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm font-medium hover:bg-muted"
            style={depth > 0 ? { marginLeft: depth * 16 } : undefined}
          >
            <Chevron className="size-4 text-muted-foreground" aria-hidden />
            <Folder className="size-4 text-muted-foreground" aria-hidden />
            <span className="truncate">{node.name}</span>
          </button>
          {!collapsed && renderNodes(node.children, depth + 1)}
        </div>
      )
    })

  const uploadProgress = useProjectUploads((s) => s.progress[projectId])
  const completedTick = useProjectUploads(
    (s) => s.completedTick[projectId] ?? 0,
  )
  const ingestFiles = useProjectUploads((s) => s.ingest)
  const failures = useProjectUploads((s) => s.failures?.[projectId])
  const dismissFailure = useProjectUploads((s) => s.dismissFailure)
  const navigate = useNavigate()
  const openEmbeddingSetup = useCallback(() => {
    void navigate({
      to: route.settings.providers,
      params: { providerName: 'llamacpp' },
    } as never)
  }, [navigate])
  const uploading = !!uploadProgress

  // Only the newest request may write: two overlapping loads (a quick project
  // switch, an upload finishing during one) can resolve out of order.
  const loadRequest = useRef(0)
  const loadedProject = useRef(projectId)

  const loadProjectFiles = useCallback(async () => {
    const id = ++loadRequest.current
    setLoading(true)
    setLoadFailed(false)
    try {
      const ext = ExtensionManager.getInstance().get<VectorDBExtension>(
        ExtensionTypeEnum.VectorDB
      )
      if (ext?.listAttachmentsForProject) {
        const projectFiles = await ext.listAttachmentsForProject(projectId)
        if (id !== loadRequest.current) return
        setFiles(projectFiles)
        // One cheap stat per file; the badges fill in after the list shows.
        const { fs } = await import('@janhq/core')
        const status = await checkProjectFiles(projectFiles, fs.fileStat)
        if (id !== loadRequest.current) return
        setFreshness(status)
      } else {
        if (id !== loadRequest.current) return
        setFiles([])
      }
    } catch {
      if (id !== loadRequest.current) return
      setFiles([])
      setLoadFailed(true)
    } finally {
      if (id === loadRequest.current) setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    // Another project's files must not show under this one while it loads.
    if (loadedProject.current !== projectId) {
      loadedProject.current = projectId
      setFiles([])
    }
    loadProjectFiles()
  }, [loadProjectFiles, completedTick, projectId])

  // Files added from a web page: their source URL, and the refresh action.
  const urlSources = useProjectUrlSources((s) => s.sources[projectId])
  const [addWebPageOpen, setAddWebPageOpen] = useState(false)
  const { refresh: refreshWebPage, refreshing: refreshingId } =
    useRefreshWebPage(projectId, loadProjectFiles)

  const processFilePaths = useCallback(
    async (paths: string[]) => {
      if (!paths.length) return

      // Get files from paths (recursively for directories)
      const filePaths = await getFilesFromPaths(paths)

      const { attachments: preparedAttachments } =
        await prepareDocumentAttachments(filePaths, {
          maxBytes: maxBytesOf(maxFileSizeMB),
          statSize: async (p) => {
            const stat = await import('@janhq/core').then((m) => m.fs.fileStat(p))
            return stat?.size ? Number(stat.size) : undefined
          },
          // Reported as each file is reached, as before the split.
          onSkip: (skip) => {
            if (skip.reason === 'unsupported') {
              toast.warning(t('common:toast.unsupportedFileType.title'), {
                description: t('common:toast.unsupportedFileType.description', {
                  extension: skip.extension,
                }),
              })
            } else {
              toast.error(t('common:errors.fileTooLarge') ?? 'File too large', {
                description: t('common:errors.fileTooLargeDescription', {
                  fileName: skip.name,
                  maxFileSizeMB,
                }),
              })
            }
          },
        })

      // Filter duplicates
      const existingPaths = new Set(
        files.filter((f) => f.path).map((f) => f.path)
      )
      const { fresh: newAttachments, duplicates } = splitDuplicates(
        preparedAttachments,
        existingPaths
      )

      if (duplicates.length > 0) {
        toast.warning(
          t('common:toast.fileAlreadyExists.title') ?? 'File already attached',
          {
            description: duplicates.join(', '),
          }
        )
      }

      if (newAttachments.length === 0) return

      await ingestFiles(
        projectId,
        newAttachments,
        (pid, att) =>
          serviceHub.uploads().ingestFileAttachmentForProject(pid, att),
        {
          onSuccess: () => {
            toast.success(
              t('common:toast.fileUploaded.title') ??
                'File processed successfully',
            )
          },
          onError: (error, fileName) => {
            console.error('Failed to process file:', error)
            toast.error(
              t('common:toast.uploadFailed.title') ?? 'Failed to process file',
              {
                description: humanizeUploadError(t, error, fileName),
                ...(isMissingEmbeddingModel(error)
                  ? {
                      action: {
                        label: t('common:projects.setUpEmbeddingModel'),
                        onClick: openEmbeddingSetup,
                      },
                    }
                  : {}),
              },
            )
          },
        },
      )
    },
    [files, ingestFiles, maxFileSizeMB, projectId, serviceHub, t, openEmbeddingSetup]
  )

  const handleUpload = async () => {
    if (!attachmentsEnabled) {
      toast.info(
        t('common:toast.attachmentsDisabledInfo.title') ??
          'Attachments are disabled in Settings'
      )
      return
    }

    try {
      const selection = await serviceHub.dialog().open({
        multiple: true,
        directory: false,
        filters: [
          {
            name: t('chat:composer.filterDocuments'),
            extensions: SUPPORTED_EXTENSIONS,
          },
          {
            name: t('chat:composer.filterAll'),
            extensions: ['*'],
          },
        ],
      })
      if (!selection) return
      const paths = Array.isArray(selection) ? selection : [selection]
      await processFilePaths(paths)
    } catch (error) {
      console.error('Failed to open file dialog:', error)
      toast.error(
        t('common:toast.uploadFailed.title') ?? 'Failed to process file',
        {
          description: humanizeUploadError(t, error),
        }
      )
    }
  }

  const { isDragging, handleDragOver, handleDragLeave, handleDrop } =
    useProjectFileDrop({
      enabled: attachmentsEnabled,
      onPaths: processFilePaths,
      t,
    })

  // Deleting drops the file's embeddings with no undo, so both row entry
  // points (trash icon, context menu) only ask; the dialog does the delete.
  const [pendingDelete, setPendingDelete] = useState<ProjectFile | null>(null)

  const requestDeleteFile = (fileId: string) => {
    setPendingDelete(files.find((f) => f.id === fileId) ?? null)
  }

  const confirmDeleteFile = () => {
    const file = pendingDelete
    setPendingDelete(null)
    if (file) void handleDeleteFile(file.id)
    if (file?.path) useProjectUrlSources.getState().remove(projectId, file.path)
  }

  const handleDeleteFile = async (fileId: string) => {
    try {
      const ext = ExtensionManager.getInstance().get<VectorDBExtension>(
        ExtensionTypeEnum.VectorDB
      )
      if (ext?.deleteFileForProject) {
        await ext.deleteFileForProject(projectId, fileId)
        toast.success(
          t('common:toast.fileDeleted.title') ?? 'File deleted successfully'
        )
        await loadProjectFiles()
      }
    } catch (error) {
      console.error('Failed to delete file:', error)
      toast.error(
        t('common:toast.deleteFailed.title') ?? 'Failed to delete file',
        {
          description:
            error instanceof Error ? error.message : JSON.stringify(error),
        }
      )
    }
  }

  const handleReindex = async (fileIds: string[]) => {
    const ext = ExtensionManager.getInstance().get<VectorDBExtension>(
      ExtensionTypeEnum.VectorDB
    )
    if (!ext?.deleteFileForProject) return
    const targets = files.filter((f) => fileIds.includes(f.id))
    setReindexingIds((prev) => new Set([...prev, ...fileIds]))
    const { fs } = await import('@janhq/core')
    let done = 0
    for (const file of targets) {
      try {
        await reindexProjectFile(projectId, file, {
          deleteFile: (pid, fid) => ext.deleteFileForProject(pid, fid),
          ingest: (pid, input) =>
            serviceHub.uploads().ingestFileAttachmentForProject(
              pid,
              createDocumentAttachment({
                name: input.name ?? input.path.split(/[\\/]/).pop() ?? input.path,
                path: input.path,
                fileType: input.type,
                size: input.size,
              })
            ),
          fileStat: fs.fileStat,
        })
        done++
      } catch (error) {
        console.error('Failed to re-index file:', error)
        toast.error(t('common:projects.reindexFailed'), {
          description: humanizeUploadError(t, error, file.name),
        })
      }
    }
    setReindexingIds((prev) => {
      const next = new Set(prev)
      fileIds.forEach((id) => next.delete(id))
      return next
    })
    if (done > 0) {
      toast.success(t('common:projects.reindexed', { count: done }))
    }
    await loadProjectFiles()
  }

  const changedIds = files
    .filter((f) => freshness[f.id] === 'changed')
    .map((f) => f.id)

  const isEmpty = !loading && files.length === 0
  // A reload keeps the list on screen; the spinner is for an empty first load.
  const showSpinner = loading && files.length === 0

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium">{t('common:projects.files')}</h3>
        <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (!attachmentsEnabled) {
              toast.info(t('common:toast.attachmentsDisabledInfo.title'))
              return
            }
            setAddWebPageOpen(true)
          }}
        >
          <Globe className="size-4" />
          <span>{t('common:projects.webPage.open')}</span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleUpload}
          disabled={uploading}
        >
          {uploading ? (
            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <UploadIcon className="size-4" />
          )}
          <span>{t('common:projects.processButton')}</span>
        </Button>
        </div>
      </div>
      <AddWebPageDialog
        projectId={projectId}
        open={addWebPageOpen}
        onOpenChange={setAddWebPageOpen}
        onAdded={loadProjectFiles}
      />

      {uploadProgress && uploadProgress.total > 0 && (
        <div className="mb-3 space-y-1.5">
          <div className="flex justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {t('common:projects.uploadingFiles')}
            </span>
            <span className="tabular-nums shrink-0">
              {uploadProgress.current} / {uploadProgress.total}
            </span>
          </div>
          <Progress
            value={(uploadProgress.current / uploadProgress.total) * 100}
          />
        </div>
      )}

      {failures && failures.length > 0 && (
        <ul className="mb-3 space-y-2">
          {failures.map((f) => (
            <li
              key={f.fileName}
              data-testid="project-file-failure"
              className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2 text-xs"
            >
              <AlertCircle className="size-4 shrink-0 text-destructive mt-0.5" />
              <div className="min-w-0 flex-1 space-y-1">
                <p className="font-medium truncate" title={f.fileName}>
                  {f.fileName}
                </p>
                <p className="text-muted-foreground">
                  {humanizeUploadError(t, f.error, f.fileName)}
                </p>
                {isMissingEmbeddingModel(f.error) && (
                  <Button variant="outline" size="sm" onClick={openEmbeddingSetup}>
                    {t('common:projects.setUpEmbeddingModel')}
                  </Button>
                )}
              </div>
              <button
                type="button"
                aria-label={t('common:dismiss')}
                className="text-muted-foreground hover:text-foreground"
                onClick={() => dismissFailure(projectId, f.fileName)}
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {showSpinner ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-6 animate-spin motion-reduce:animate-none text-muted-foreground" />
        </div>
      ) : isEmpty && loadFailed ? (
        <div
          role="alert"
          className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-destructive/40 px-4 py-6 text-center"
        >
          <p className="text-sm text-destructive">
            {t('common:projects.filesLoadFailed')}
          </p>
          <Button variant="outline" size="sm" onClick={() => void loadProjectFiles()}>
            {t('common:projects.retryLoad')}
          </Button>
        </div>
      ) : isEmpty ? (
        <div
          className={cn(
            'flex flex-col items-center justify-center py-8 px-4 rounded-lg border border-dashed cursor-pointer transition-colors',
            isDragging
              ? 'bg-acc-tint border-acc'
              : 'bg-muted/60 border-border-strong hover:bg-muted'
          )}
          role="button"
          tabIndex={0}
          aria-label={t('common:projects.processButton')}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              handleUpload()
            }
          }}
          onClick={handleUpload}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <FileText className="size-8 text-muted-foreground mb-3" />
          <p className="text-sm text-muted-foreground text-center">
            {t('common:projects.filesDescription')}
          </p>
        </div>
      ) : (
        <div
          className={cn(
            'space-y-2 rounded-lg p-1 -m-1 transition-colors',
            isDragging && 'bg-acc-tint outline-2 outline-dashed outline-acc'
          )}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {changedIds.length > 0 && (
            <div className="flex items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning/5 p-2 text-xs">
              <span>
                {t('common:projects.filesChangedOnDisk', {
                  count: changedIds.length,
                })}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleReindex(changedIds)}
                disabled={reindexingIds.size > 0}
              >
                <RefreshCw className="size-3.5" aria-hidden />
                {t('common:projects.reindexAllChanged')}
              </Button>
            </div>
          )}
          {renderNodes(fileTree.nodes, 0)}

          <div
          className={cn(
            'flex mt-2 flex-col items-center justify-center py-8 px-4 rounded-lg border border-dashed cursor-pointer transition-colors',
            isDragging
              ? 'bg-acc-tint border-acc'
              : 'bg-muted/60 border-border-strong hover:bg-muted'
          )}
          role="button"
          tabIndex={0}
          aria-label={t('common:projects.processButton')}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              handleUpload()
            }
          }}
          onClick={handleUpload}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <FileText className="size-8 text-muted-foreground mb-3" />
          <p className="text-sm text-muted-foreground text-center">
            {t('common:projects.filesDescription')}
          </p>
        </div>
        </div>
      )}

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('common:projects.deleteFileDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('common:projects.deleteFileDialog.description', {
                fileName: pendingDelete?.name ?? '',
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost" size="sm" className="w-full sm:w-auto">
                {t('common:cancel')}
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              size="sm"
              className="w-full sm:w-auto"
              onClick={confirmDeleteFile}
            >
              {t('common:delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
