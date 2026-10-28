/* eslint-disable react-refresh/only-export-components */
/** Small pieces the room editor and its add-participant form both use. */

export const norm = (s: string) => s.trim().toLowerCase()

export type Errors = Record<string, string>

export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null
  return (
    <p id={id} className="text-xs text-destructive">
      {message}
    </p>
  )
}
