// The remote-access wire protocol: the RPC method table and request envelope. Re-exported by protocol.ts.
// Kept free of app imports so the phone bundle can use it as is.

import type {
  SessionsListParams,
  SessionsListResult,
  ThreadBranchSelectParams,
  ThreadMessagesParams,
  ThreadMessagesResult,
  ModelsListResult,
  StatusResult,
  IdParams,
  RoomDetail,
  CoworkDetail,
  ApprovalsListResult,
  SystemInfo,
  ToolsListResult,
  SettingsSnapshot,
  AppearanceResult,
  RoomCreateParams,
  RoomUpdateParams,
  RoomMutationResult,
  ChatSendParams,
  CoworkSendParams,
  RoomSendParams,
  SendResult,
  RunStopParams,
  RunStopResult,
  RoomControlParams,
  ApprovalRespondParams,
  ApprovalRespondResult,
  AsksListResult,
  AskRespondParams,
  AskRespondResult,
  PromptsListResult,
  PromptRespondParams,
  PromptRespondResult,
  SettingsSetParams,
  StreamGetParams,
  StreamSnapshot,
  QueueResult,
  CoworkChanges,
  CoworkActivity,
  LibraryResult,
  ChatDetails,
  ChatEffortParams,
  ChatAssistantParams,
  ChatForkParams,
  ChatRegenerateParams,
  ChatEditParams,
  TitleRegenerateParams,
  TitleRegenerateResult,
  AssistantsResult,
  RoomClearParams,
  CoworkFilesParams,
  CoworkFilesResult,
  CoworkFileParams,
  CoworkFileResult,
  CoworkPreviewResult,
  HfSearchParams,
  HfSearchResult,
  HfDownloadParams,
  DownloadTaskWire,
  CampaignWire,
  CampaignDetailResult,
  CampaignActParams,
  StudioKindWire,
  StudioStatusResult,
  StudioItemWire,
  StudioGenerateParams,
  StudioItemParams,
  VoiceStatusResult,
  VoiceTranscribeParams,
  ArchiveKindWire,
  ArchiveListResult,
  ArchiveKeyParams,
  ArchiveEmptyResult,
  PushPrefs,
  PushSubscriptionJson,
} from './protocolTypes'

export type RemoteMethods = {
  'push.vapidKey': { params: Record<string, never>; result: { key: string } }
  'push.get': { params: Record<string, never>; result: { subscribed: boolean; available: boolean; prefs: PushPrefs } }
  'push.subscribe': { params: { subscription: PushSubscriptionJson; prefs?: PushPrefs }; result: { ok: true } }
  'push.unsubscribe': { params: Record<string, never>; result: { ok: true } }
  'push.prefs': { params: { prefs: PushPrefs }; result: { prefs: PushPrefs } }
  'push.test': { params: Record<string, never>; result: { sent: number } }
  /** Answered by the server: a path to load the session's live preview. */
  'preview.ticket': { params: { id: string }; result: { path: string } }
  'sessions.list': { params: SessionsListParams; result: SessionsListResult }
  'thread.messages': { params: ThreadMessagesParams; result: ThreadMessagesResult }
  /** `ok: false` when there is no version that way or the chat is mid-reply. */
  'thread.branch.select': { params: ThreadBranchSelectParams; result: { ok: boolean } }
  'models.list': { params: Record<string, never>; result: ModelsListResult }
  status: { params: Record<string, never>; result: StatusResult }
  'rooms.get': { params: IdParams; result: RoomDetail }
  'cowork.get': { params: IdParams; result: CoworkDetail }
  'approvals.list': { params: Record<string, never>; result: ApprovalsListResult }
  'system.info': { params: Record<string, never>; result: SystemInfo }
  'tools.list': { params: Record<string, never>; result: ToolsListResult }
  'settings.get': { params: Record<string, never>; result: SettingsSnapshot }
  'appearance.get': { params: Record<string, never>; result: AppearanceResult }
  'stream.get': { params: StreamGetParams; result: StreamSnapshot | null }
  'thread.queue': { params: IdParams; result: QueueResult }
  'cowork.changes': { params: IdParams; result: CoworkChanges }
  'cowork.activity': { params: IdParams; result: CoworkActivity }
  'library.list': { params: Record<string, never>; result: LibraryResult }
  'chat.send': { params: ChatSendParams; result: SendResult }
  'cowork.send': { params: CoworkSendParams; result: SendResult }
  'run.stop': { params: RunStopParams; result: RunStopResult }
  'room.send': { params: RoomSendParams; result: SendResult }
  'room.control': { params: RoomControlParams; result: { ok: true } }
  'room.create': { params: RoomCreateParams; result: RoomMutationResult }
  'room.update': { params: RoomUpdateParams; result: RoomMutationResult }
  'room.delete': { params: IdParams; result: { ok: true } }
  'settings.set': { params: SettingsSetParams; result: { ok: true } }
  /** `scope: 'always'` needs "Allow 'Always allow' from phones" (checked by the server too). */
  'approvals.respond': { params: ApprovalRespondParams; result: ApprovalRespondResult }
  'asks.list': { params: Record<string, never>; result: AsksListResult }
  'asks.respond': { params: AskRespondParams; result: AskRespondResult }
  'prompts.list': { params: Record<string, never>; result: PromptsListResult }
  /** An approval like any other: off when "Approvals from phones" is off
   * (the server checks the `approvals.` name too). */
  'approvals.prompt': { params: PromptRespondParams; result: PromptRespondResult }
  'chat.details': { params: IdParams; result: ChatDetails }
  'chat.effort': { params: ChatEffortParams; result: { ok: true } }
  'chat.assistant': { params: ChatAssistantParams; result: { ok: true } }
  'chat.fork': { params: ChatForkParams; result: { id: string } }
  'chat.regenerate': { params: ChatRegenerateParams; result: { ok: true } }
  'chat.edit': { params: ChatEditParams; result: { ok: true } }
  'chat.compact': { params: IdParams; result: { started: boolean } }
  'title.regenerate': { params: TitleRegenerateParams; result: TitleRegenerateResult }
  'assistants.list': { params: Record<string, never>; result: AssistantsResult }
  'room.clear': { params: RoomClearParams; result: { ok: true } }
  'cowork.files': { params: CoworkFilesParams; result: CoworkFilesResult }
  'cowork.file': { params: CoworkFileParams; result: CoworkFileResult }
  'cowork.preview': { params: { id: string; path?: string }; result: CoworkPreviewResult }
  'hf.search': { params: HfSearchParams; result: HfSearchResult }
  'hf.download': { params: HfDownloadParams; result: { ok: true; id: string } }
  'models.downloads': { params: Record<string, never>; result: { tasks: DownloadTaskWire[] } }
  'studio.status': { params: Record<string, never>; result: StudioStatusResult }
  'studio.load': { params: { modelId: string }; result: { ok: true } }
  'studio.unload': { params: Record<string, never>; result: { ok: true } }
  'studio.download': { params: { modelId: string }; result: { ok: true } }
  'studio.generate': { params: StudioGenerateParams; result: { started: true } }
  'studio.stop': { params: Record<string, never>; result: { ok: true } }
  'studio.gallery': { params: { kind: StudioKindWire }; result: { items: StudioItemWire[] } }
  'studio.media': { params: StudioItemParams; result: { dataUrl: string } }
  'studio.remix': { params: StudioItemParams; result: { started: true } }
  'studio.delete': { params: StudioItemParams; result: { ok: true } }
  /** The archive of deleted items; a phone can list, restore and delete them for good. */
  'archive.list': { params: Record<string, never>; result: ArchiveListResult }
  'archive.restore': { params: ArchiveKeyParams; result: { ok: true } }
  'archive.purge': { params: ArchiveKeyParams; result: { ok: true } }
  'archive.empty': { params: { kind?: ArchiveKindWire }; result: ArchiveEmptyResult }
  'campaigns.list': { params: Record<string, never>; result: { campaigns: CampaignWire[] } }
  'campaigns.get': { params: IdParams; result: CampaignDetailResult }
  /** Pause, resume, cancel, review and apply, and task retry, skip and stop.
   * An approval like any other: off when "Approvals from phones" is off. */
  'approvals.campaign.act': { params: CampaignActParams; result: { ok: true; note?: string } }
  'voice.status': { params: Record<string, never>; result: VoiceStatusResult }
  'voice.transcribe': { params: VoiceTranscribeParams; result: { text: string } }
}

export type RemoteMethod = keyof RemoteMethods

/** `remote://rpc` payload: a phone's call, as the server hands it over. */
export type RemoteRpcRequest = {
  id: string
  method: string
  params: unknown
  device: { id: string; name: string }
}
