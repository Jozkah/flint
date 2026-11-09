// `RemoteActions` over the app's own stores and controllers: each action is
// the call the desktop's control makes, so a phone's action is recorded,
// permitted and shown exactly as the user's own would be.

import type { RemoteActions } from './actions'
import { appActionContext, type Navigate } from './appActionsShared'
import { writeNotificationPrefs } from './notificationPrefs'
import { chatActions } from './appActionsChat'
import { coworkActions } from './appActionsCowork'
import { sendActions } from './appActionsSend'
import { stopActions } from './appActionsStop'
import { answerActions } from './appActionsAnswers'
import { roomActions } from './appActionsRooms'

export type { Navigate } from './appActionsShared'

export function appActions(navigate: Navigate): RemoteActions {
  const ctx = appActionContext(navigate)
  // Spread in this order: the merged keys keep the order the registry had.
  return {
    ...chatActions(ctx),
    ...coworkActions(),
    ...sendActions(ctx),
    ...stopActions(ctx),
    ...answerActions(),
    ...roomActions(),
    setNotificationPrefs: (device, prefs) => writeNotificationPrefs(device, prefs),
  }
}
