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

  // Date-only mode: long month. Date-only values in persisted activity and
  // session records are UTC instants for a calendar day; format them in UTC so
  // the day stays stable across machines instead of the local timezone moving
  // midnight into the previous or next day. Only this branch uses UTC: a time
  // of day must be shown in the user's local timezone.
  return new Date(date).toLocaleDateString('en-US', {
    ...base,
    month: 'long',
    timeZone: 'UTC',
  })
}
