// Settings > Notifications: Web Push for this phone. The switches are kept
// on the computer with this phone's pairing, so they apply even while the
// app is closed.
import { useState } from 'react'
import type { PushPrefs } from '@/lib/remote/protocol'
import { Grp, IRow } from '../ui/ios'
import { BellSwitch } from '../ui/bell-switch'
import { act, describeError, toast } from '../state/app'
import { invalidate, useRpc } from '../state/rpc'
import { DEFAULT_PUSH, disablePush, enablePush, minToTime, pushSupport, supportText, timeToMin, withOffset, type PushSupport } from '../state/push'

const TYPES: [keyof PushPrefs, string][] = [
  ['approvals', 'An approval is waiting'],
  ['runFinished', 'A run finishes'],
  ['runFailed', 'A run fails or stops'],
  ['pr', 'A PR merges or its checks fail'],
  ['roomWaiting', 'A Room is waiting for you'],
  ['synthesis', 'A Room synthesis is ready'],
  ['chatReply', 'A chat reply finishes'],
]


export default function PushSettings({ support = pushSupport() }: { support?: PushSupport }) {
  const { data } = useRpc('push.get', {}, support.ok)
  const [busy, setBusy] = useState(false)
  const prefs = data?.prefs ?? DEFAULT_PUSH
  const on = !!data?.subscribed
  const save = (p: PushPrefs) => void act('push.prefs', { prefs: withOffset(p) }).then(() => invalidate(['push.get']))
  const flip = (k: keyof PushPrefs) => () => save({ ...prefs, [k]: !prefs[k] })
  const quiet = prefs.quietHours
  const setQuiet = (q: Partial<PushPrefs['quietHours']>) => save({ ...prefs, quietHours: { ...quiet, ...q } })
  const toggle = async () => {
    setBusy(true)
    try {
      if (on) await disablePush()
      else {
        const err = await enablePush(prefs)
        if (err) toast(err)
      }
    } catch (e) {
      toast(describeError('push.subscribe', e))
    } finally {
      setBusy(false)
      invalidate(['push.get'])
    }
  }
  const why = supportText(support)
  return (
    <>
      <Grp
        cap="Push notifications"
        foot={why ?? 'Sent by your computer straight to this phone’s push service, only while Flint is not open here. Payloads are encrypted and carry no message text.'}
      >
        <BellSwitch
          label="Notify this phone"
          on={on}
          busy={busy}
          sub={
            data && !data.available ? 'Not set up on the computer' : undefined
          }
          onClick={
            why || busy || (data && !data.available)
              ? undefined
              : () => void toggle()
          }
          testId="push-toggle"
        />
        {on && <IRow label="Send a test notification" onClick={() => void act('push.test', {}, 'Test sent')} testId="push-test" />}
      </Grp>
      {on && (
        <>
          <Grp cap="Notify me when">
            {TYPES.map(([k, label]) => (
              <IRow key={k} label={label} sw={!!prefs[k]} onClick={flip(k)} testId={`push-${k}`} />
            ))}
          </Grp>
          <Grp foot="Shows “Flint needs you” instead of what happened, for lock screens.">
            <IRow label="Hide content" sw={prefs.hideContent} onClick={flip('hideContent')} testId="push-hide" />
          </Grp>
          <Grp cap="Quiet hours" foot="Nothing but approvals comes through during quiet hours.">
            <IRow label="Quiet hours" sw={quiet.enabled} onClick={() => setQuiet({ enabled: !quiet.enabled })} testId="push-quiet" />
            {quiet.enabled && (
              <div className="irow noic" style={{ gap: 8 }}>
                <label className="lab" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  From
                  <input type="time" aria-label="Quiet hours start" value={minToTime(quiet.start)} onChange={(e) => { const m = timeToMin(e.target.value); if (m !== null) setQuiet({ start: m }) }} />
                  to
                  <input type="time" aria-label="Quiet hours end" value={minToTime(quiet.end)} onChange={(e) => { const m = timeToMin(e.target.value); if (m !== null) setQuiet({ end: m }) }} />
                </label>
              </div>
            )}
          </Grp>
        </>
      )}
    </>
  )
}
