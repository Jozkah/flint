/**
 * File extensions Flint attaches as documents (parsed for the prompt or
 * ingested for retrieval). Shared by the file picker and drag-and-drop so both
 * accept the same files.
 */
export const DOCUMENT_ATTACHMENT_EXTENSIONS = [
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
  // Shell
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
] as const

/** Whether a file name has one of the document attachment extensions. */
export const isDocumentAttachmentName = (name: string): boolean => {
  // `Dockerfile` and `Makefile` are whole names, with no extension.
  const base = name.toLowerCase().split(/[\\/]/).pop() ?? ''
  if (base === 'dockerfile' || base === 'makefile') return true
  if (!name.includes('.')) return false
  const ext = name.toLowerCase().split('.').pop() ?? ''
  return (DOCUMENT_ATTACHMENT_EXTENSIONS as readonly string[]).includes(ext)
}
