// `RemoteExtras` over the app's stores: every value is what the desktop's own
// control reads (ComposerEffort, ContextWindowCard, WhatJanIsUsing,
// CoworkCodePanel, CoworkPreviewPanel, the Hugging Face hub), and every action
// is the call that control makes.

import { roomController } from '@/lib/rooms/controller'
import type { RemoteExtras } from './extras'
import { chatExtras } from './appExtrasChat'
import { coworkExtras } from './appExtrasCowork'
import { hubExtras } from './appExtrasHub'

/** Rooms. */
const roomExtras: Pick<RemoteExtras, 'clearRoom'> = {
  clearRoom: async (id, scope) => {
    await roomController.clearRoom(id, scope)
  },
}

export const appExtras: RemoteExtras = Object.assign(
  {},
  chatExtras,
  roomExtras,
  coworkExtras,
  hubExtras
)
