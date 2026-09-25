import { formatDate } from '@/utils/formatDate'

/**
 * A message's time as a conversation shows it: just the clock for today
 * ("10:12"), the full date and time for anything older.
 */
export const formatMessageTime = (
  date: string | number | Date,
  now: Date = new Date()
): string => {
  const d = new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (!sameDay) return formatDate(d)
  return d.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
}
