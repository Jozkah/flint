/**
 * The last segment of a Windows or POSIX path. Trailing separators are
 * ignored; an empty result falls back to the input.
 */
export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}
