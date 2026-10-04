/* eslint-disable react-refresh/only-export-components */
import type { ReactNode } from 'react'
import {
  FileDiffIcon,
  FileTextIcon,
  GlobeIcon,
  ListTodoIcon,
  Loader2Icon,
  SearchIcon,
  ShieldAlertIcon,
  TerminalIcon,
  WrenchIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { toolKind, type ToolKind } from '@/lib/toolKind'

/**
 * The one place a tool call's icon and icon tile are decided, so the chat's tool
 * cards, a subagent's transcript steps and the Tasks rows read as the same kind
 * of thing. The hue itself is `--tk`, set by `[data-tool-kind]` on an ancestor
 * (styles/toolKind.css); nothing here carries a colour value.
 */

/** The card's icon: its kind, or a shield while it waits for the user. */
export const ToolKindIcon = ({
  name,
  awaitingApproval = false,
  running = false,
}: {
  name: string
  awaitingApproval?: boolean
  running?: boolean
}) => {
  if (awaitingApproval) return <ShieldAlertIcon />
  if (running) return <Loader2Icon className="motion-safe:animate-spin" />
  switch (toolKind({ name })) {
    case 'web':
      return name === 'web_fetch' ? <GlobeIcon /> : <SearchIcon />
    case 'search':
      return <SearchIcon />
    case 'bash':
      return <TerminalIcon />
    case 'edit':
      return <FileDiffIcon />
    case 'read':
      return <FileTextIcon />
    case 'todo':
      return <ListTodoIcon />
    default:
      return <WrenchIcon />
  }
}

/** The classes of the tinted icon square, shared with the chat's tool header. */
export const TOOL_TILE_CLASS =
  'grid size-[22px] shrink-0 place-items-center rounded-md bg-[color-mix(in_oklab,var(--tk)_14%,transparent)] text-(--tk) [&_svg]:size-[13px]'

/** A card outline: the chat's border token, no coloured edge. Kind colour lives in the icon tile and the verb only. */
export const TOOL_CARD_CLASS = 'border-border'

/** The tool kind for a tool name and whether the call failed. */
export function kindOfStep(name: string, failed = false): ToolKind {
  return toolKind({ name, state: failed ? 'output-error' : undefined })
}

/** The icon square: `--tk` must be set by an ancestor `data-tool-kind`. */
export function ToolKindTile({
  name,
  running,
  icon,
  className,
}: {
  name: string
  running?: boolean
  /** An icon of the caller's choosing, for what is not a tool (an agent). */
  icon?: ReactNode
  className?: string
}) {
  return (
    <span aria-hidden data-slot="tool-icon" className={cn(TOOL_TILE_CLASS, className)}>
      {icon ?? <ToolKindIcon name={name} running={running} />}
    </span>
  )
}
