# Session messaging: proposed hunks for files under restyle

`web-app/src/containers/MessageItem.tsx`, `web-app/src/routes/cowork.tsx` and
`web-app/src/routes/threads/$threadId.tsx` are being restyled in another
session, so the frontend lane of cross-session messaging did not edit them.
Everything else is in place; applying the hunks below is the only remaining
integration step. Each is minimal and independent. Line numbers are from
commit `378e16900`.

What already works without these hunks:

- Presence (register / rename / folder / delete / running / heartbeat / idle)
  and delivery (event listener + startup sweep) are mounted from
  `providers/GlobalEventHandler.tsx`.
- Held mail renders as "Message from <name>" cards with Reply, Let the agent
  respond, Dismiss and the Automatic wake-ups switch, through
  `CoworkHeldInput`, which the route already mounts (cowork.tsx:3366).
- Mail that arrives during a run is enqueued ready and drained by the route's
  existing `takeSteering` at the runner's safe boundaries. The model gets the
  wrapped text.
- `pendingInput` persistence carries `from` (`useCoworkSessions.setPendingInput`).

What is missing until the hunks land: the transcript row for delivered mail
is shown as an ordinary user message (no "Message from" label, no Reply), and
an automatic wake-up for a session that is *already* idle and in view waits
until the user switches sessions or a run ends.

---

## 1. cowork.tsx: carry `from` into the transcript at the steering boundary

Why: `takeSteering` builds the live user turn from `m.text` only, so the
sender is dropped. `CoworkTurn.from` already exists and `coworkTurnsToUIMessages`
maps it to `metadata.agentMessage`.

```diff
@@ -2824,9 +2824,19 @@
           takeSteering: () => {
             const taken = useMessageQueue.getState().takeReady(sid)
             if (taken.length === 0) return []
             pushLive(
-              taken.map((m) => ({ role: 'user' as const, content: m.text, steered: true }))
+              taken.map((m) => ({
+                role: 'user' as const,
+                content: m.text,
+                steered: true,
+                ...(m.from ? { from: agentAttribution(m.from) } : {}),
+              }))
             )
             return taken.map(
```

plus the import (the helper is a one-liner; inline it if preferred):

```diff
@@ -61,1 +61,2 @@
 import { useMessageQueue } from '@/stores/message-queue-store'
+import { agentAttribution } from '@/lib/mailboxDelivery'
```

`agentAttribution` does not exist yet; if you would rather not add an export,
inline `{ sessionId: m.from.sessionId, displayName: m.from.displayName, messageId: m.from.messageId, replyTo: m.from.replyTo ?? null }`.

## 2. cowork.tsx: idle send keeps the sender, and wakes on newly ready mail

Why, (a): the idle effect calls `runRequest(next.text)`, which creates a plain
user turn and, for a new session, titles it with the wrapped text. (b): the
effect only re-runs when `running` or the session in view changes, so mail
released by Automatic wake-ups while the session is already idle and in view
is not sent until one of those changes. Adding the ready count to the
dependencies fixes that without changing typed input (typed input while idle
is sent directly, not queued).

```diff
@@ -1562,3 +1562,6 @@
-  const runRequest = async (text: string | null) => {
+  const runRequest = async (
+    text: string | null,
+    from?: QueuedMessage['from']
+  ) => {
     const sid = ensureCurrentSession()
@@ -1631,2 +1634,2 @@
-    if (text && current?.title === 'New session')
+    if (text && !from && current?.title === 'New session')
       store.setTitle(sid, text.slice(0, 40))
@@ -1669,1 +1672,5 @@
-    let runTurns: CoworkTurn[] = text ? [{ role: 'user', content: text }] : []
+    let runTurns: CoworkTurn[] = text
+      ? [{ role: 'user', content: text, ...(from ? { from } : {}) }]
+      : []
@@ -3002,6 +3009,12 @@
+  const readyCount = useMessageQueue((s) =>
+    session?.id ? s.getQueue(session.id).filter((m) => !m.held).length : 0
+  )
   useEffect(() => {
     if (running || !session?.id) return
     // Held input waits for the user; only what is ready goes.
     const next = useMessageQueue.getState().dequeueReady(session.id)
-    if (next) void runRequestRef.current(next.text)
-  }, [running, session?.id])
+    if (next) void runRequestRef.current(next.text, next.from)
+  }, [running, session?.id, readyCount])
```

and the type import:

```diff
-import { useMessageQueue } from '@/stores/message-queue-store'
+import { useMessageQueue, type QueuedMessage } from '@/stores/message-queue-store'
```

(`QueuedMessage['from']` is structurally a superset of `CoworkTurn['from']`;
the extra `depth` field is harmless on the turn. Use the helper from hunk 1 if
the stricter shape is wanted.)

## 3. MessageItem.tsx: one-line mount of the attribution header

Why: renders "Message from <name>" with a Reply button for rows carrying
`metadata.agentMessage`; renders nothing for every other message.
`AgentMessageHeader` is fully tested (`containers/__tests__/AgentMessageCard.test.tsx`).

```diff
@@ -380,8 +380,9 @@
                 {metadata?.steered === true && partIndex === 0 && (
                   <div
                     data-testid="steered-label"
                     className="mb-1 text-[11px] opacity-70"
                   >
                     {t('common:steering.delivered')}
                   </div>
                 )}
+                {partIndex === 0 && <AgentMessageHeader metadata={metadata} />}
                 {/* Show attached files if any */}
```

```diff
@@ -40,1 +40,2 @@
 import { EditMessageDialog } from '@/containers/dialogs/EditMessageDialog'
+import { AgentMessageHeader } from '@/containers/AgentMessageHeader'
```

Optional, same file: when `metadata?.agentMessage` is set, pass the part text
through `unwrapForDisplay` (from `@/lib/sessionMailbox`) before rendering, so
the transcript shows the sender's words under the label rather than the
wrapper line the model saw. Also consider rendering such rows as plain text
rather than markdown: the text is another agent's, not the user's.

## 4. threads/$threadId.tsx: no hunk

Chat threads do not participate. The four messaging tools are dropped from the
chat transport's tool list (`lib/custom-chat-transport.ts`) and nothing in
delivery touches thread queues.

## Better placement for the Automatic wake-ups switch

The switch is currently mounted inside the held-mail area so that no route
edit is needed, which means it is only visible while mail is waiting. The
natural home is the Cowork session header or its session settings menu in
`cowork.tsx`, next to the mode/access controls:

```tsx
<SessionMessagingToggle sessionId={session.id} />
```

Once it is mounted there, it can be removed from `CoworkHeldInput`.
