// Own module so commandEditable can read it without pulling agentTools in (import cycle).
/**
 * What the approval prompt says when a `bash` command failed only because
 * Windows' null device refuses sandboxed programs.
 */
export const NULL_DEVICE_RETRY_REASON =
  "This command needs to run outside the sandbox because Windows' null " +
  'device (NUL) refuses sandboxed programs. Allowing it runs this exact ' +
  'command once more, outside the sandbox, with your own permissions.'
