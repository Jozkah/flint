/**
 * A chat title split into the part that may fade out at the row's edge and a
 * short tail that always shows. Forks and numbered copies share their head, so
 * with an end fade three rows read "Number Sequence Generation" alike and the
 * " (fork)" that tells them apart was the part cut off (T7-026).
 */
const TAIL = /^(.*\S)(\s+(?:\(fork\)|\(\d+\)|#?\d+))$/

export function splitTitleTail(title: string): [string, string] {
  const m = TAIL.exec(title)
  return m ? [m[1], m[2]] : [title, '']
}
