import { AvatarEmoji } from '@/containers/AvatarEmoji'
import { FlintMark } from '@/components/shell/FlintMark'
import { formatMessageTime } from '@/utils/formatMessageTime'

/** A small, quiet line naming who answered and when. */
export function AssistantMessageHeader({
  avatar,
  name,
  answeredBy,
  createdAt,
}: {
  avatar?: string
  name?: string
  /** The model that answered, when the request recorded it. */
  answeredBy?: string
  /** Omitted while streaming, or when the message has no stored time. */
  createdAt?: number
}) {
  return (
    <div
      data-testid="assistant-message-header"
      className="mb-2 flex min-w-0 items-center gap-2 text-[length:calc(var(--ui-font-base)*0.78125)] leading-5 text-subtle-foreground"
    >
      {/* The model's avatar: the Flint mark on a quiet tile. */}
      <span
        aria-hidden
        className="grid size-[22px] shrink-0 place-items-center rounded-md bg-accent p-[3px] shadow-[inset_0_0_0_0.8px_var(--border)]"
      >
        {avatar ? (
          <AvatarEmoji
            avatar={avatar}
            imageClassName="size-full object-contain"
            textClassName="text-xs leading-none"
          />
        ) : (
          <FlintMark className="size-full" />
        )}
      </span>
      <span className="shrink-0 font-semibold text-foreground">
        {name || 'Flint'}
      </span>
      {answeredBy && (
        <>
          <span aria-hidden>·</span>
          <span className="min-w-0 truncate" title={answeredBy}>
            {answeredBy}
          </span>
        </>
      )}
      {createdAt !== undefined && (
        <>
          <span aria-hidden>·</span>
          <span
            className="shrink-0 tabular-nums"
            title={new Date(createdAt).toLocaleString()}
          >
            {formatMessageTime(createdAt)}
          </span>
        </>
      )}
    </div>
  )
}
