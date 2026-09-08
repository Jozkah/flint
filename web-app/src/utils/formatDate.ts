type FormatDateOptions = {
  includeTime?: boolean
}

export const formatDate = (
  date: string | number | Date,
  options?: FormatDateOptions
): string => {
  const includeTime = options?.includeTime ?? true

  // Base options shared across both modes
  const base: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    day: 'numeric',
    // Dates in persisted activity and session records are UTC instants. Keep
    // their calendar day stable across machines instead of letting the local
    // timezone move midnight into the previous or next day.
    timeZone: 'UTC',
  }

  if (includeTime) {
    // Time mode: short month + time, using local timezone
    return new Date(date).toLocaleString('en-US', {
      ...base,
      month: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hour12: true,
    })
  }

  // Date-only mode: long month, using local timezone
  return new Date(date).toLocaleDateString('en-US', {
    ...base,
    month: 'long',
  })
}
