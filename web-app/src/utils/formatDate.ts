type FormatDateOptions = {
  includeTime?: boolean
  /**
   * BCP 47 tag. Defaults to 'en-US' because the one caller today feeds the
   * date to the model's system prompt, which must stay stable; UI callers
   * pass the app language (F6m-033).
   */
  locale?: string
}

export const formatDate = (
  date: string | number | Date,
  options?: FormatDateOptions
): string => {
  const includeTime = options?.includeTime ?? true
  const locale = options?.locale ?? 'en-US'

  // Base options shared across both modes
  const base: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    day: 'numeric',
  }

  if (includeTime) {
    // Time mode: short month + time, using local timezone
    return new Date(date).toLocaleString(locale, {
      ...base,
      month: 'short',
      hour: 'numeric',
      minute: 'numeric',
      // en-US keeps the 12-hour clock; other locales decide for themselves.
      ...(locale === 'en-US' ? { hour12: true } : {}),
    })
  }

  // Date-only mode: long month. Date-only values in persisted activity and
  // session records are UTC instants for a calendar day; format them in UTC so
  // the day stays stable across machines instead of the local timezone moving
  // midnight into the previous or next day. Only this branch uses UTC: a time
  // of day must be shown in the user's local timezone.
  return new Date(date).toLocaleDateString(locale, {
    ...base,
    month: 'long',
    timeZone: 'UTC',
  })
}
