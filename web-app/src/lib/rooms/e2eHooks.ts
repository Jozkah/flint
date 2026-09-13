/**
 * End-to-end test hook for discussion rooms.
 *
 * The real-app harness (`src-tauri/examples/cowork_smoke.rs`, rooms lane) needs
 * to drive the rooms engine from a bundled app, where modules are not
 * reachable from `window`. When the frontend is built with
 * `VITE_JAN_E2E_HOOKS=1`, this exposes the engine as `window.__janRoomsE2E`.
 *
 * Vite replaces `import.meta.env.VITE_JAN_E2E_HOOKS` at build time, so in a
 * normal build the branch below is dead code and none of it ships.
 */

export type RoomsE2EHooks = Record<string, unknown>

type HookTarget = { __janRoomsE2E?: RoomsE2EHooks }

/** Loads the engine modules and assigns them to `target.__janRoomsE2E`. */
export async function installRoomsE2EHooks(
  flag: string | undefined,
  target: HookTarget
): Promise<boolean> {
  if (flag !== '1') return false
  const [controller, store, participantModel, availability, context, providers] = await Promise.all([
    import('./controller'),
    import('./store'),
    import('./participantModel'),
    import('./availability'),
    import('./context'),
    import('@/hooks/useModelProvider'),
  ])
  target.__janRoomsE2E = {
    roomController: controller.roomController,
    createRoom: controller.createRoom,
    updateRoomSettings: controller.updateRoomSettings,
    addParticipant: controller.addParticipant,
    removeParticipant: controller.removeParticipant,
    deleteRoom: controller.deleteRoom,
    loadSummaries: controller.loadSummaries,
    loadRoom: controller.loadRoom,
    useRoomsStore: store.useRoomsStore,
    streamParticipantReply: participantModel.streamParticipantReply,
    contextWindowFor: availability.contextWindowFor,
    modelSupportsTools: availability.modelSupportsTools,
    buildSystemPrompt: context.buildSystemPrompt,
    useModelProvider: providers.useModelProvider,
  }
  return true
}

if (import.meta.env.VITE_JAN_E2E_HOOKS === '1' && typeof window !== 'undefined') {
  void installRoomsE2EHooks(import.meta.env.VITE_JAN_E2E_HOOKS, window as HookTarget).catch((e) =>
    console.error('[rooms] e2e hooks failed to install', e)
  )
}
