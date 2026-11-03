/**
 * The app's one byte-size formatter. Kept free of imports so the pure modules
 * that format sizes (archive, migration, system monitor) can use it without
 * pulling in the rest of lib/utils, which re-exports it.
 */

export type ByteUnit = 'B' | 'KB' | 'MB' | 'GB' | 'TB' | 'PB'

export type FormatBytesOptions = {
  decimals?: number | ((value: number, unit: ByteUnit) => number)
  separator?: string
  hideUnit?: boolean
  minUnit?: ByteUnit
  /** Largest unit used; bigger values stay in it. Defaults to GB. */
  maxUnit?: ByteUnit
  fallback?: string
}

const BYTE_UNITS: ByteUnit[] = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

export function formatBytes(
  bytes: number | undefined,
  options?: FormatBytesOptions
): string {
  const fallback = options?.fallback ?? ''

  if (bytes === undefined || !Number.isFinite(bytes)) {
    return fallback
  }

  const minUnitIndex =
    options?.minUnit === undefined ? 0 : BYTE_UNITS.indexOf(options.minUnit)

  let unitIndex = 0
  let scaledValue = bytes

  const maxUnitIndex =
    options?.maxUnit === undefined
      ? BYTE_UNITS.indexOf('GB')
      : BYTE_UNITS.indexOf(options.maxUnit)

  while (scaledValue >= 1024 && unitIndex < maxUnitIndex) {
    scaledValue /= 1024
    unitIndex++
  }

  while (unitIndex < minUnitIndex) {
    scaledValue /= 1024
    unitIndex++
  }

  const unit = BYTE_UNITS[unitIndex]
  const rawDecimals =
    typeof options?.decimals === 'function'
      ? options.decimals(scaledValue, unit)
      : options?.decimals ?? 1
  const decimals = Math.min(20, Math.max(0, Math.trunc(rawDecimals)))
  const formattedValue = scaledValue.toFixed(decimals)

  if (options?.hideUnit) {
    return formattedValue
  }

  return `${formattedValue}${options?.separator ?? ' '}${unit}`
}

/**
 * The one human-readable size the app's panels share: B to TB, no decimals for
 * a byte count or a value of 10 or more, else one. Zero, negative and
 * non-finite sizes read "0 B".
 */
export function formatSizeCompact(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return '0 B'
  return formatBytes(bytes, {
    maxUnit: 'TB',
    decimals: (value, unit) => (unit === 'B' || value >= 10 ? 0 : 1),
  })
}
