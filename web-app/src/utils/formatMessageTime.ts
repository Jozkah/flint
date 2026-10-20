/**
 * A message's full date and time, in the PC's own regional format (date order,
 * separators and 12/24-hour clock), e.g. "20/10/2026, 14:30" or
 * "10/20/2026, 2:30 PM".
 */
export const formatMessageTime = (date: string | number | Date): string => {
  const d = new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  // An undefined locale follows the system setting, not the app language.
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
