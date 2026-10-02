/**
 * Does a read error mean the file is not there? The Rust side forwards the OS
 * message (`os error 2`, or `os error 3` for a missing folder on Windows); the
 * asset protocol answers 404.
 */
export function isNotFoundError(message: string): boolean {
  return /os error [23]\b|ENOENT|\bnot found\b|no such file|cannot find the (file|path)|^404$/i.test(
    message
  )
}
