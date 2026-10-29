import type { FileStat } from '@janhq/core'
import { collectFilesFromDirectory } from '@/lib/directoryWalk'
import { createDocumentAttachment, type Attachment } from '@/types/attachment'

/** Extensions a project's document index can parse. */
export const SUPPORTED_EXTENSIONS = [
  // Documents
  'pdf',
  'docx',
  'txt',
  'md',
  'csv',
  'xlsx',
  'xls',
  'ods',
  'pptx',
  'html',
  'htm',
  'xhtml',
  // JavaScript / TypeScript
  'js',
  'mjs',
  'cjs',
  'ts',
  'mts',
  'cts',
  'jsx',
  'tsx',
  // Python
  'py',
  'pyw',
  'pyi',
  // C / C++
  'c',
  'h',
  'cpp',
  'cc',
  'cxx',
  'hpp',
  'hh',
  // Systems languages
  'rs',
  'go',
  'swift',
  'zig',
  // JVM languages
  'java',
  'kt',
  'kts',
  'scala',
  'groovy',
  // Scripting languages
  'rb',
  'php',
  'lua',
  'pl',
  'r',
  'jl',
  // .NET
  'cs',
  'fs',
  'vb',
  'xaml',
  'csproj',
  'sln',
  // CUDA
  'cu',
  'cuh',
  // Shaders
  'hlsl',
  'glsl',
  'cg',
  'shader',
  // Shell / Scripting
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'bat',
  'cmd',
  'vbs',
  // More languages
  'asm',
  's',
  'm',
  'mm',
  'pas',
  'pp',
  'erl',
  'hrl',
  'ex',
  'exs',
  'clj',
  'cljs',
  'hs',
  'lhs',
  'ml',
  'mli',
  'f',
  'f90',
  // Web
  'css',
  'scss',
  'sass',
  'less',
  'vue',
  'svelte',
  'astro',
  'asp',
  'aspx',
  'jsp',
  // Data / config formats
  'json',
  'jsonc',
  'yaml',
  'yml',
  'toml',
  'xml',
  'ini',
  'cfg',
  'conf',
  'env',
  'properties',
  'dockerfile',
  'makefile',
  'cmake',
  'lock',
  // Query / markup
  'sql',
  'graphql',
  'gql',
  'tex',
  'rst',
  'adoc',
  'textile',
  // Misc text
  'log',
  'diff',
  'patch',
  'gitignore',
]

/** Lower-cased extension of a file name, if it has one. */
const extensionOf = (name: string): string | undefined =>
  name.split('.').pop()?.toLowerCase()

type CoreFs = typeof import('@janhq/core').fs

/**
 * Expand dropped or picked paths into files: a folder contributes every
 * supported file under it (recursively), a file itself. A path that cannot be
 * stat'ed is kept as a file and left to the later checks.
 */
export async function getFilesFromPaths(paths: string[]): Promise<string[]> {
  const files: string[] = []
  const { fs } = await import('@janhq/core')

  for (const path of paths) {
    try {
      const stat: FileStat | undefined = await fs.fileStat(path)
      if (stat?.isDirectory) {
        files.push(...(await getFilesFromDirectory(path, fs)))
      } else {
        files.push(path)
      }
    } catch (e) {
      console.warn(`Failed to get stat for ${path}:`, e)
      files.push(path)
    }
  }
  return files
}

function getFilesFromDirectory(dirPath: string, fs: CoreFs): Promise<string[]> {
  return collectFilesFromDirectory(dirPath, fs, (entry) => {
    const ext = extensionOf(entry)
    return !!ext && SUPPORTED_EXTENSIONS.includes(ext)
  })
}

export type PreparedDocuments = {
  attachments: Attachment[]
  /** Skipped for type: the extension seen, or 'unknown'. In input order. */
  unsupported: string[]
  /** Skipped for size: file names. In input order. */
  tooLarge: string[]
}

/**
 * Turn file paths into document attachments, dropping unsupported types and
 * files over `maxBytes`. `statSize` reads a file's size; a failed read leaves
 * the size unknown, which never counts as too large.
 */
export async function prepareDocumentAttachments(
  filePaths: string[],
  {
    maxBytes,
    statSize,
    onSkip,
  }: {
    maxBytes: number | undefined
    statSize: (path: string) => Promise<number | undefined>
    /** Called per skipped file, in order, so callers can report as they go. */
    onSkip?: (skip: { reason: 'unsupported'; extension: string } | { reason: 'too-large'; name: string }) => void
  }
): Promise<PreparedDocuments> {
  const result: PreparedDocuments = { attachments: [], unsupported: [], tooLarge: [] }
  for (const p of filePaths) {
    const name = p.split(/[\\/]/).pop() || p
    const fileType = extensionOf(name)

    if (!fileType || !SUPPORTED_EXTENSIONS.includes(fileType)) {
      const extension = fileType || 'unknown'
      result.unsupported.push(extension)
      onSkip?.({ reason: 'unsupported', extension })
      continue
    }

    let size: number | undefined = undefined
    try {
      size = await statSize(p)
    } catch (e) {
      console.warn('Failed to read file size for', p, e)
    }

    if (maxBytes !== undefined && size && size > maxBytes) {
      result.tooLarge.push(name)
      onSkip?.({ reason: 'too-large', name })
      continue
    }

    result.attachments.push(createDocumentAttachment({ name, path: p, fileType, size }))
  }
  return result
}

/** Split attachments into new ones and the names of ones already in the project. */
export function splitDuplicates(
  attachments: Attachment[],
  existingPaths: ReadonlySet<string | undefined>
): { fresh: Attachment[]; duplicates: string[] } {
  const duplicates: string[] = []
  const fresh = attachments.filter((att) => {
    if (existingPaths.has(att.path)) {
      duplicates.push(att.name)
      return false
    }
    return true
  })
  return { fresh, duplicates }
}

type PathTransfer = Pick<DataTransfer, 'items' | 'files'>

/**
 * The paths a drop carries on its File objects (Tauri puts a `path` on
 * them): from `items` first, then `files` as the web fallback.
 */
export function droppedFilePaths(transfer: PathTransfer): string[] {
  const paths: string[] = []
  const items = transfer.items
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file && 'path' in file && typeof file.path === 'string') {
          paths.push(file.path)
        }
      }
    }
  }
  if (paths.length === 0) {
    const dtFiles = transfer.files
    for (let i = 0; i < dtFiles.length; i++) {
      const file = dtFiles[i]
      if ('path' in file && typeof file.path === 'string') {
        paths.push(file.path)
      }
    }
  }
  return paths
}

/** The configured per-file cap in bytes; undefined when there is none. */
export function maxBytesOf(maxFileSizeMB: unknown): number | undefined {
  return typeof maxFileSizeMB === 'number' && maxFileSizeMB > 0
    ? maxFileSizeMB * 1024 * 1024
    : undefined
}
