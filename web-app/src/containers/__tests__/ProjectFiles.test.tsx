import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom'

// ---------- Module mocks (must come before importing the component) ----------

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: any) => (opts?.defaultValue ?? key),
  }),
}))

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  dismiss: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: toastMock }))

// useAttachments selector mock
const hoisted = vi.hoisted(() => ({
  attachmentsState: { enabled: true, maxFileSizeMB: 10 },
  listAttachmentsForProjectMock: vi.fn(),
  deleteFileForProjectMock: vi.fn(),
  ingestFileAttachmentForProjectMock: vi.fn(),
  dialogOpenMock: vi.fn(),
  extMock: {} as any,
}))
hoisted.extMock.listAttachmentsForProject = hoisted.listAttachmentsForProjectMock
hoisted.extMock.deleteFileForProject = hoisted.deleteFileForProjectMock

const {
  listAttachmentsForProjectMock,
  deleteFileForProjectMock,
  ingestFileAttachmentForProjectMock,
  dialogOpenMock,
  extMock,
} = hoisted
const attachmentsStateRef = hoisted // alias for later mutation

vi.mock('@/hooks/useAttachments', () => ({
  useAttachments: (selector: any) => selector(hoisted.attachmentsState),
}))

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    uploads: () => ({
      ingestFileAttachmentForProject: hoisted.ingestFileAttachmentForProjectMock,
    }),
    dialog: () => ({ open: hoisted.dialogOpenMock }),
  }),
}))

const uploadsHoisted = vi.hoisted(() => ({
  ingestMock: vi.fn(),
  progress: {} as Record<string, { current: number; total: number }>,
  failures: {} as Record<string, { fileName: string; error: unknown }[]>,
  dismissFailure: vi.fn(),
  navigate: vi.fn(),
}))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => uploadsHoisted.navigate,
}))
const { ingestMock } = uploadsHoisted
vi.mock('@/stores/project-uploads-store', () => ({
  useProjectUploads: (selector: (s: unknown) => unknown) =>
    selector({
      progress: uploadsHoisted.progress,
      completedTick: {},
      ingest: uploadsHoisted.ingestMock,
      failures: uploadsHoisted.failures,
      dismissFailure: uploadsHoisted.dismissFailure,
    }),
}))

vi.mock('@/lib/extension', () => ({
  ExtensionManager: {
    getInstance: () => ({
      get: () => hoisted.extMock,
    }),
  },
}))

const coreHoisted = vi.hoisted(() => ({
  fileStatMock: vi.fn(),
  readdirSyncMock: vi.fn(),
}))
const { fileStatMock, readdirSyncMock } = coreHoisted
vi.mock('@janhq/core', () => ({
  ExtensionTypeEnum: { VectorDB: 'vectordb' },
  VectorDBExtension: class {},
  fs: {
    fileStat: coreHoisted.fileStatMock,
    readdirSync: coreHoisted.readdirSyncMock,
  },
}))

// Stub heavy UI
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, ...rest }: any) => (
    <button onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
}))
vi.mock('@/components/ui/progress', () => ({
  Progress: ({ value }: any) => <div data-testid="progress" data-value={value} />,
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: any) => <>{children}</>,
  TooltipContent: ({ children }: any) => <>{children}</>,
  TooltipTrigger: ({ children }: any) => <>{children}</>,
}))

// Now import the component
import ProjectFiles from '../ProjectFiles'

describe('ProjectFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    attachmentsStateRef.attachmentsState = { enabled: true, maxFileSizeMB: 10 }
    extMock.listAttachmentsForProject = listAttachmentsForProjectMock
    extMock.deleteFileForProject = deleteFileForProjectMock
    listAttachmentsForProjectMock.mockResolvedValue([])
    fileStatMock.mockReset().mockResolvedValue({ isDirectory: false, size: 100 })
    readdirSyncMock.mockReset().mockResolvedValue([])
    ingestMock.mockReset()
    uploadsHoisted.progress = {}
    uploadsHoisted.failures = {}
  })

  it('keeps a row for a file that failed for want of an embedding model (T7-054)', async () => {
    uploadsHoisted.failures = {
      p1: [
        {
          fileName: 'zorblax.txt',
          error: new Error(
            'Failed to determine embedding context size: No embedding model is installed.'
          ),
        },
      ],
    }
    render(<ProjectFiles projectId="p1" lng="en" />)
    const row = await screen.findByTestId('project-file-failure')
    expect(within(row).getByText('zorblax.txt')).toBeInTheDocument()
    expect(within(row).getByText('common:toast.uploadFailed.noEmbeddingModel')).toBeInTheDocument()
    fireEvent.click(within(row).getByText('common:projects.setUpEmbeddingModel'))
    expect(uploadsHoisted.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { providerName: 'llamacpp' } })
    )
    fireEvent.click(within(row).getByLabelText('common:dismiss'))
    expect(uploadsHoisted.dismissFailure).toHaveBeenCalledWith('p1', 'zorblax.txt')
  })

  it('toasts the missing embedding model with a setup action', async () => {
    dialogOpenMock.mockResolvedValue(['C:/f/zorblax.txt'])
    ingestMock.mockImplementation(async (_p, _a, _fn, handlers) =>
      handlers.onError(new Error('No embedding model is installed.'), 'zorblax.txt')
    )
    render(<ProjectFiles projectId="p1" lng="en" />)
    await waitFor(() => expect(screen.getByText('common:projects.processButton')).toBeInTheDocument())
    fireEvent.click(screen.getByText('common:projects.processButton'))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
    const opts = toastMock.error.mock.calls[0][1]
    expect(opts.description).toBe('common:toast.uploadFailed.noEmbeddingModel')
    expect(opts.action.label).toBe('common:projects.setUpEmbeddingModel')
  })

  it('shows loader while files are loading', () => {
    listAttachmentsForProjectMock.mockImplementation(
      () => new Promise(() => {})
    )
    const { container } = render(<ProjectFiles projectId="p1" lng="en" />)
    expect(container.querySelector('.animate-spin')).toBeTruthy()
  })

  it('renders empty state when no files are returned', async () => {
    listAttachmentsForProjectMock.mockResolvedValue([])
    render(<ProjectFiles projectId="p1" lng="en" />)
    await waitFor(() =>
      expect(screen.getByText('common:projects.filesDescription')).toBeInTheDocument()
    )
  })

  it('renders a file list when files exist', async () => {
    listAttachmentsForProjectMock.mockResolvedValue([
      { id: '1', name: 'report.pdf', path: '/x/report.pdf', size: 2048, chunk_count: 3 },
      { id: '2', name: 'notes.txt', path: '/x/notes.txt', size: 100, chunk_count: 0 },
    ])
    render(<ProjectFiles projectId="p1" lng="en" />)
    await waitFor(() =>
      expect(screen.getAllByText('report.pdf').length).toBeGreaterThan(0)
    )
    expect(screen.getAllByText('notes.txt').length).toBeGreaterThan(0)
  })

  it('keeps the later request\'s list when two loads resolve out of order', async () => {
    let first!: (v: unknown) => void
    listAttachmentsForProjectMock.mockImplementationOnce(
      () => new Promise((r) => (first = r))
    )
    const { rerender } = render(<ProjectFiles projectId="p1" lng="en" />)
    listAttachmentsForProjectMock.mockResolvedValueOnce([
      { id: '2', name: 'second.txt', path: '/x/second.txt', size: 1, chunk_count: 0 },
    ])
    rerender(<ProjectFiles projectId="p2" lng="en" />)
    await waitFor(() =>
      expect(screen.getAllByText('second.txt').length).toBeGreaterThan(0)
    )
    first([
      { id: '1', name: 'first.txt', path: '/x/first.txt', size: 1, chunk_count: 0 },
    ])
    await Promise.resolve()
    expect(screen.queryByText('first.txt')).toBeNull()
    expect(screen.getAllByText('second.txt').length).toBeGreaterThan(0)
  })

  it('falls back to empty list when extension is missing', async () => {
    extMock.listAttachmentsForProject = undefined
    render(<ProjectFiles projectId="p1" lng="en" />)
    await waitFor(() =>
      expect(screen.getByText('common:projects.filesDescription')).toBeInTheDocument()
    )
  })

  it('shows a load error with retry when the extension throws', async () => {
    listAttachmentsForProjectMock.mockRejectedValueOnce(new Error('boom'))
    render(<ProjectFiles projectId="p1" lng="en" />)
    await waitFor(() =>
      expect(screen.getByText('common:projects.filesLoadFailed')).toBeInTheDocument()
    )
    listAttachmentsForProjectMock.mockResolvedValue([])
    fireEvent.click(screen.getByText('common:projects.retryLoad'))
    await waitFor(() =>
      expect(screen.getByText('common:projects.filesDescription')).toBeInTheDocument()
    )
  })

  it('lets the keyboard open the empty drop zone', async () => {
    dialogOpenMock.mockResolvedValue(null)
    extMock.listAttachmentsForProject = listAttachmentsForProjectMock
    listAttachmentsForProjectMock.mockResolvedValue([])
    render(<ProjectFiles projectId="p1" lng="en" />)
    await waitFor(() =>
      expect(screen.getByText('common:projects.filesDescription')).toBeInTheDocument()
    )
    const zone = screen
      .getByText('common:projects.filesDescription')
      .closest('[role="button"]') as HTMLElement
    expect(zone).toHaveAttribute('tabindex', '0')
    fireEvent.keyDown(zone, { key: 'Enter' })
    await waitFor(() => expect(dialogOpenMock).toHaveBeenCalled())
  })

  it('shows an info toast when upload is clicked while attachments are disabled', async () => {
    attachmentsStateRef.attachmentsState = { enabled: false, maxFileSizeMB: 10 }
    render(<ProjectFiles projectId="p1" lng="en" />)
    await waitFor(() => expect(screen.getByText('common:projects.processButton')).toBeInTheDocument())
    fireEvent.click(screen.getByText('common:projects.processButton'))
    await waitFor(() => expect(toastMock.info).toHaveBeenCalled())
    expect(dialogOpenMock).not.toHaveBeenCalled()
  })

  it('opens the file dialog when upload is clicked', async () => {
    dialogOpenMock.mockResolvedValue(null)
    render(<ProjectFiles projectId="p1" lng="en" />)
    await waitFor(() => expect(screen.getByText('common:projects.processButton')).toBeInTheDocument())
    fireEvent.click(screen.getByText('common:projects.processButton'))
    await waitFor(() => expect(dialogOpenMock).toHaveBeenCalled())
  })

  it('toasts error when opening the dialog throws', async () => {
    dialogOpenMock.mockRejectedValue(new Error('dialog broken'))
    render(<ProjectFiles projectId="p1" lng="en" />)
    await waitFor(() => expect(screen.getByText('common:projects.processButton')).toBeInTheDocument())
    fireEvent.click(screen.getByText('common:projects.processButton'))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
  })

  it('deletes a file and reloads the list', async () => {
    listAttachmentsForProjectMock.mockResolvedValueOnce([
      { id: 'f1', name: 'a.md', path: '/a.md', size: 10, chunk_count: 1 },
    ])
    listAttachmentsForProjectMock.mockResolvedValueOnce([])
    deleteFileForProjectMock.mockResolvedValue(undefined)

    render(<ProjectFiles projectId="p1" lng="en" />)
    await waitFor(() =>
      expect(screen.getAllByText('a.md').length).toBeGreaterThan(0)
    )

    fireEvent.click(screen.getByRole('button', { name: 'common:delete a.md' }))

    // The trash icon only asks (#255); nothing is deleted until confirmed.
    const dialog = await screen.findByRole('dialog')
    expect(deleteFileForProjectMock).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'common:delete' }))

    await waitFor(() => expect(deleteFileForProjectMock).toHaveBeenCalledWith('p1', 'f1'))
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled())
  })

  it('does not delete a file when the confirmation is cancelled', async () => {
    listAttachmentsForProjectMock.mockResolvedValue([
      { id: 'f1', name: 'a.md', path: '/a.md', size: 10, chunk_count: 1 },
    ])

    render(<ProjectFiles projectId="p1" lng="en" />)
    await waitFor(() =>
      expect(screen.getAllByText('a.md').length).toBeGreaterThan(0)
    )

    fireEvent.click(screen.getByRole('button', { name: 'common:delete a.md' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'common:cancel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(deleteFileForProjectMock).not.toHaveBeenCalled()
  })

  it('toasts error when deletion fails', async () => {
    listAttachmentsForProjectMock.mockResolvedValue([
      { id: 'f1', name: 'a.md', path: '/a.md', size: 10, chunk_count: 1 },
    ])
    deleteFileForProjectMock.mockRejectedValue(new Error('nope'))

    render(<ProjectFiles projectId="p1" lng="en" />)
    await waitFor(() =>
      expect(screen.getAllByText('a.md').length).toBeGreaterThan(0)
    )
    fireEvent.click(screen.getByRole('button', { name: 'common:delete a.md' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'common:delete' }))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
  })

  it('shows chunk count when greater than zero', async () => {
    listAttachmentsForProjectMock.mockResolvedValue([
      { id: '1', name: 'x.md', size: 1024, chunk_count: 5 },
    ])
    render(<ProjectFiles projectId="p1" lng="en" />)
    await waitFor(() =>
      expect(screen.getAllByText('x.md').length).toBeGreaterThan(0)
    )
    expect(screen.getByText(/common:files.chunksCount/)).toBeInTheDocument()
  })

  it('prevents default on drag over and leave without crashing', async () => {
    listAttachmentsForProjectMock.mockResolvedValue([])
    const { container } = render(<ProjectFiles projectId="p1" lng="en" />)
    await waitFor(() =>
      expect(screen.getByText('common:projects.filesDescription')).toBeInTheDocument()
    )
    const dropzone = container.querySelector('.border-dashed') as HTMLElement
    expect(dropzone).toBeTruthy()
    fireEvent.dragOver(dropzone)
    fireEvent.dragLeave(dropzone)
  })

  it('handles a drop event with no files gracefully', async () => {
    listAttachmentsForProjectMock.mockResolvedValue([])
    const { container } = render(<ProjectFiles projectId="p1" lng="en" />)
    await waitFor(() =>
      expect(screen.getByText('common:projects.filesDescription')).toBeInTheDocument()
    )
    const dropzone = container.querySelector('.border-dashed') as HTMLElement
    fireEvent.drop(dropzone, { dataTransfer: { items: [], files: [] } })
    // No error thrown, no ingest called
    expect(ingestFileAttachmentForProjectMock).not.toHaveBeenCalled()
  })

  it('shows info toast on drop when attachments are disabled', async () => {
    attachmentsStateRef.attachmentsState = { enabled: false, maxFileSizeMB: 10 }
    listAttachmentsForProjectMock.mockResolvedValue([])
    const { container } = render(<ProjectFiles projectId="p1" lng="en" />)
    await waitFor(() =>
      expect(screen.getByText('common:projects.filesDescription')).toBeInTheDocument()
    )
    const dropzone = container.querySelector('.border-dashed') as HTMLElement
    fireEvent.drop(dropzone, { dataTransfer: { items: [], files: [] } })
    await waitFor(() => expect(toastMock.info).toHaveBeenCalled())
  })

  // ---------- Linux drops that name files as text ----------

  const linuxDrop = async (data: Record<string, string>) => {
    const { container } = render(<ProjectFiles projectId="p1" lng="en" />)
    await waitFor(() =>
      expect(screen.getByText('common:projects.filesDescription')).toBeInTheDocument()
    )
    const dropzone = container.querySelector('.border-dashed') as HTMLElement
    fireEvent.drop(dropzone, {
      dataTransfer: {
        items: [],
        files: [],
        types: Object.keys(data),
        getData: (t: string) => data[t] ?? '',
      },
    })
  }

  it('ignores a bare path dragged as text (never walks /home/me)', async () => {
    fileStatMock.mockResolvedValue({ isDirectory: true, size: 0 })
    await linuxDrop({ 'text/plain': '/home/me/projects' })
    await new Promise((r) => setTimeout(r, 20))
    expect(fileStatMock).not.toHaveBeenCalled()
    expect(readdirSyncMock).not.toHaveBeenCalled()
    expect(ingestMock).not.toHaveBeenCalled()
  })

  it('asks before adding a dropped folder instead of walking it', async () => {
    fileStatMock.mockResolvedValue({ isDirectory: true, size: 0 })
    await linuxDrop({ 'text/uri-list': 'file:///home/me/proj/' })
    await waitFor(() => expect(toastMock.info).toHaveBeenCalled())
    expect(readdirSyncMock).not.toHaveBeenCalled()
    expect(ingestMock).not.toHaveBeenCalled()
    const opts = toastMock.info.mock.calls.at(-1)?.[1] as {
      action?: { onClick: () => void }
    }
    expect(opts?.action?.onClick).toBeTypeOf('function')
  })

  it('asks before ingesting a file a uri-list drop names (a page can forge that text)', async () => {
    fileStatMock.mockResolvedValue({ isDirectory: false, size: 3 })
    await linuxDrop({ 'text/uri-list': 'file:///home/me/a%20b.pdf' })
    await waitFor(() => expect(toastMock.info).toHaveBeenCalled())
    expect(ingestMock).not.toHaveBeenCalled()
    expect(toastMock.info.mock.calls.at(-1)?.[0]).toBe('common:pastedPath.file')
  })

  it('ingests a file named by the GNOME drag type', async () => {
    await linuxDrop({
      'x-special/gnome-copied-files': 'copy\nfile:///home/me/a%20b.pdf',
    })
    await waitFor(() => expect(ingestMock).toHaveBeenCalled())
    expect(ingestMock.mock.calls[0][1][0]).toMatchObject({ path: '/home/me/a b.pdf' })
  })

  // ---------- Upload flow: processFilePaths + ingest + humanizeUploadError ----------

  async function clickUpload() {
    render(<ProjectFiles projectId="p1" lng="en" />)
    await waitFor(() =>
      expect(screen.getByText('common:projects.processButton')).toBeInTheDocument()
    )
    fireEvent.click(screen.getByText('common:projects.processButton'))
  }

  const lastErrorDescription = () =>
    (toastMock.error.mock.calls.at(-1)?.[1] as { description?: string })
      ?.description

  it('ingests a selected file and toasts success', async () => {
    dialogOpenMock.mockResolvedValue(['/docs/report.pdf'])
    ingestMock.mockImplementation(async (_pid, atts, _fn, opts) => {
      expect(atts).toHaveLength(1)
      expect(atts[0]).toMatchObject({ path: '/docs/report.pdf', fileType: 'pdf' })
      opts.onSuccess()
    })
    await clickUpload()
    await waitFor(() => expect(ingestMock).toHaveBeenCalledWith(
      'p1', expect.any(Array), expect.any(Function), expect.any(Object)
    ))
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled())
  })

  it.each([
    [{ ParseError: 'PDF parsing failed unexpectedly: unhandled function type 4' }, 'pdfUnsupportedFeature'],
    [{ ParseError: 'PDF parse error: invalid start value in xref table' }, 'pdfMalformedXref'],
    [{ ParseError: 'PDF appears to be image-based or scanned' }, 'pdfScanned'],
    [{ ParseError: 'PDF is encrypted, password required' }, 'pdfEncrypted'],
    [{ UnsupportedFileType: 'odt' }, 'unsupportedType'],
    [{ IoError: 'disk gone' }, 'ioError'],
    [{ ParseError: 'totally weird failure' }, 'parseGeneric'],
  ])(
    'maps RagError %j to uploadFailed.%s',
    async (ragError, key) => {
      dialogOpenMock.mockResolvedValue(['/docs/report.pdf'])
      ingestMock.mockImplementation(async (_pid, _atts, _fn, opts) => {
        opts.onError(ragError, 'report.pdf')
      })
      await clickUpload()
      await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
      expect(lastErrorDescription()).toBe(`common:toast.uploadFailed.${key}`)
    }
  )

  it('warns and skips unsupported file extensions without ingesting', async () => {
    dialogOpenMock.mockResolvedValue(['/docs/archive.zzz'])
    await clickUpload()
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalled())
    expect(ingestMock).not.toHaveBeenCalled()
  })

  it('rejects files exceeding the max size without ingesting', async () => {
    fileStatMock.mockResolvedValue({ isDirectory: false, size: 50 * 1024 * 1024 })
    dialogOpenMock.mockResolvedValue(['/docs/huge.pdf'])
    await clickUpload()
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        'common:errors.fileTooLarge',
        expect.any(Object)
      )
    )
    expect(ingestMock).not.toHaveBeenCalled()
  })

  it('skips duplicates already attached to the project', async () => {
    listAttachmentsForProjectMock.mockResolvedValue([
      { id: 'd1', name: 'report.pdf', path: '/docs/report.pdf', chunk_count: 1 },
    ])
    dialogOpenMock.mockResolvedValue(['/docs/report.pdf'])
    render(<ProjectFiles projectId="p1" lng="en" />)
    await waitFor(() =>
      expect(screen.getAllByText('report.pdf').length).toBeGreaterThan(0)
    )
    fireEvent.click(screen.getByText('common:projects.processButton'))
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalled())
    expect(ingestMock).not.toHaveBeenCalled()
  })

  it('renders the upload progress bar while an ingest is in flight', async () => {
    uploadsHoisted.progress = { p1: { current: 1, total: 3 } }
    render(<ProjectFiles projectId="p1" lng="en" />)
    await waitFor(() =>
      expect(screen.getByText('common:projects.uploadingFiles')).toBeInTheDocument()
    )
    expect(screen.getByText('1 / 3')).toBeInTheDocument()
    expect(screen.getByTestId('progress')).toHaveAttribute('data-value', String((1 / 3) * 100))
  })

  it('ingests files dropped with Tauri paths via dataTransfer.items', async () => {
    ingestMock.mockImplementation(async (_pid, atts, _fn, opts) => {
      expect(atts[0]).toMatchObject({ path: '/dropped/a.pdf', fileType: 'pdf' })
      opts.onSuccess()
    })
    const { container } = render(<ProjectFiles projectId="p1" lng="en" />)
    await waitFor(() =>
      expect(screen.getByText('common:projects.filesDescription')).toBeInTheDocument()
    )
    const dropzone = container.querySelector('.border-dashed') as HTMLElement
    const file = Object.assign(new File(['x'], 'a.pdf'), { path: '/dropped/a.pdf' })
    fireEvent.drop(dropzone, {
      dataTransfer: {
        items: [{ kind: 'file', getAsFile: () => file }],
        files: [],
      },
    })
    await waitFor(() => expect(ingestMock).toHaveBeenCalled())
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled())
  })

  it('falls back to dataTransfer.files when items are unavailable', async () => {
    ingestMock.mockImplementation(async (_pid, atts, _fn, opts) => {
      expect(atts[0]).toMatchObject({ path: '/web/b.pdf' })
      opts.onSuccess()
    })
    const { container } = render(<ProjectFiles projectId="p1" lng="en" />)
    await waitFor(() =>
      expect(screen.getByText('common:projects.filesDescription')).toBeInTheDocument()
    )
    const dropzone = container.querySelector('.border-dashed') as HTMLElement
    const file = Object.assign(new File(['x'], 'b.pdf'), { path: '/web/b.pdf' })
    fireEvent.drop(dropzone, { dataTransfer: { files: [file] } })
    await waitFor(() => expect(ingestMock).toHaveBeenCalled())
  })

  it('recursively gathers supported files from a dropped directory', async () => {
    fileStatMock.mockImplementation(async (p: string) => ({
      isDirectory: p === '/dir',
      size: 100,
    }))
    readdirSyncMock.mockResolvedValue(['/dir/a.pdf', '/dir/skip.bin'])
    dialogOpenMock.mockResolvedValue(['/dir'])
    ingestMock.mockImplementation(async (_pid, atts, _fn, opts) => {
      // only the supported .pdf survives the SUPPORTED_EXTENSIONS filter
      expect(atts.map((a: { path: string }) => a.path)).toEqual(['/dir/a.pdf'])
      opts.onSuccess()
    })
    await clickUpload()
    await waitFor(() => expect(ingestMock).toHaveBeenCalled())
  })

  describe('files changed on disk', () => {
    const indexed = {
      id: 'f1',
      name: 'notes.md',
      path: '/docs/notes.md',
      type: 'md',
      size: 100,
      chunk_count: 2,
      mtime: 1_700_000_000,
    }

    it('badges a changed file and re-indexes it by delete then ingest', async () => {
      listAttachmentsForProjectMock.mockResolvedValue([indexed])
      fileStatMock.mockResolvedValue({ isDirectory: false, size: 140, modified: 1_700_000_900 })
      deleteFileForProjectMock.mockResolvedValue(undefined)
      ingestFileAttachmentForProjectMock.mockResolvedValue({ id: 'f2' })
      render(<ProjectFiles projectId="p1" />)
      expect(await screen.findByTestId('project-file-changed')).toBeInTheDocument()
      fireEvent.click(screen.getByLabelText('common:projects.reindexFile notes.md'))
      await waitFor(() =>
        expect(ingestFileAttachmentForProjectMock).toHaveBeenCalledWith(
          'p1',
          expect.objectContaining({ path: '/docs/notes.md', size: 140 })
        )
      )
      expect(deleteFileForProjectMock).toHaveBeenCalledWith('p1', 'f1')
      expect(deleteFileForProjectMock.mock.invocationCallOrder[0]).toBeLessThan(
        ingestFileAttachmentForProjectMock.mock.invocationCallOrder[0]
      )
    })

    it('re-indexes every changed file from the banner', async () => {
      listAttachmentsForProjectMock.mockResolvedValue([
        indexed,
        { ...indexed, id: 'f3', name: 'b.md', path: '/docs/b.md' },
      ])
      fileStatMock.mockResolvedValue({ isDirectory: false, size: 1, modified: 1 })
      deleteFileForProjectMock.mockResolvedValue(undefined)
      ingestFileAttachmentForProjectMock.mockResolvedValue({ id: 'x' })
      render(<ProjectFiles projectId="p1" />)
      fireEvent.click(await screen.findByText('common:projects.reindexAllChanged'))
      await waitFor(() => expect(ingestFileAttachmentForProjectMock).toHaveBeenCalledTimes(2))
      expect(deleteFileForProjectMock).toHaveBeenCalledTimes(2)
    })

    it('badges a missing file', async () => {
      listAttachmentsForProjectMock.mockResolvedValue([indexed])
      fileStatMock.mockRejectedValue(new Error('No such file'))
      render(<ProjectFiles projectId="p1" />)
      expect(await screen.findByTestId('project-file-missing')).toBeInTheDocument()
    })

    it('shows no badge for a file indexed before mtimes were stored', async () => {
      listAttachmentsForProjectMock.mockResolvedValue([{ ...indexed, mtime: null }])
      fileStatMock.mockResolvedValue({ isDirectory: false, size: 1, modified: 1 })
      render(<ProjectFiles projectId="p1" />)
      await screen.findAllByText('notes.md')
      await waitFor(() => expect(listAttachmentsForProjectMock).toHaveBeenCalled())
      expect(screen.queryByTestId('project-file-changed')).toBeNull()
      expect(screen.queryByTestId('project-file-missing')).toBeNull()
      expect(fileStatMock).not.toHaveBeenCalled()
    })
  })
})
