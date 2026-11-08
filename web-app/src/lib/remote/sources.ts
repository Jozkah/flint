// The app's stores and services, as the remote handlers read them. Kept apart
// from the handlers so those stay testable with plain data.

import type { RemoteSources } from './handlers'
import { sessionSources } from './sourcesSessions'
import { attentionSources, modelSources, appSourcesMisc } from './sourcesApp'

export const appSources: RemoteSources = Object.assign(
  {},
  sessionSources,
  attentionSources,
  modelSources,
  appSourcesMisc
)
