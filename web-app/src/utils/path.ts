/**
 * Determines if the given path is a root directory.
 *
 * On Windows, this checks for drive roots such as `C:\` or `D:\`.
 * On Mac/Linux, this checks if the path is `/`.
 *
 * @param selectedNewPath - The path to check.
 * @returns `true` if the path is a root directory, otherwise `false`.
 */
export const isRootDir = (selectedNewPath: string) => {
  // Windows root: C:\, D:\, etc.
  if (IS_WINDOWS) {
    return /^[a-zA-Z]:\\?$/.test(selectedNewPath)
  }
  // Linux/Mac root: /, /mnt, /media, etc.
  const linuxRoots = [
    '/',
    '/mnt',
    '/media',
    '/boot',
    '/home',
    '/opt',
    '/var',
    '/usr',
  ]
  const normalized =
    selectedNewPath.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  return linuxRoots.some((root) => normalized === root)
}

const normalizeForCompare = (p: string) =>
  p
    .replace(/^\\\\\?\\/, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()

/**
 * Whether a `flint` CLI found on PATH is the bundled one of a different copy of
 * Flint (another install, or another profile's app) rather than this app's own.
 * Only a bundled path (`.../resources/bin/flint`) can be told apart; a CLI put
 * somewhere else on purpose is never reported as foreign.
 */
export const isForeignBundledCli = (
  cliPath: string,
  ownResourceDir: string | null | undefined
): boolean => {
  if (!ownResourceDir) return false
  const cli = normalizeForCompare(cliPath)
  if (!/\/resources\/bin\/flint(\.exe)?$/.test(cli)) return false
  return !cli.startsWith(`${normalizeForCompare(ownResourceDir)}/`)
}
