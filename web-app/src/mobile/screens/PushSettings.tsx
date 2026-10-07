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
import { t } from '../i18n'

const TYPES: [keyof PushPrefs, string][] = [
  ['approvals', t('push.types.approvals')],
  ['runFinished', t('push.types.runFinished')],
  ['runFailed', t('push.types.runFailed')],
  ['pr', t('push.types.pr')],
  ['roomWaiting', t('push.types.roomWaiting')],
  ['synthesis', t('push.types.synthesis')],
  ['chatReply', t('push.types.chatReply')],
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
        cap={t('push.title')}
        foot={why ?? t('push.foot')}
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
        {on && <IRow label={t('push.sendTest')} onClick={() => void act('push.test', {}, t('push.testSent'))} testId="push-test" />}
      </Grp>
      {on && (
        <>
          <Grp cap={t('push.notifyWhen')}>
            {TYPES.map(([k, label]) => (
              <IRow key={k} label={label} sw={!!prefs[k]} onClick={flip(k)} testId={`push-${k}`} />
            ))}
          </Grp>
          <Grp foot={t('push.hideFoot')}>
            <IRow label={t('push.hideContent')} sw={prefs.hideContent} onClick={flip('hideContent')} testId="push-hide" />
          </Grp>
          <Grp cap={t('push.quiet')} foot={t('push.quietFoot')}>
            <IRow label={t('push.quiet')} sw={quiet.enabled} onClick={() => setQuiet({ enabled: !quiet.enabled })} testId="push-quiet" />
            {quiet.enabled && (
              <div className="irow noic" style={{ gap: 8 }}>
                <label className="lab" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {t('push.from')}
                  <input type="time" aria-label={t('push.quietStart')} value={minToTime(quiet.start)} onChange={(e) => { const m = timeToMin(e.target.value); if (m !== null) setQuiet({ start: m }) }} />
                  {t('push.to')}
                  <input type="time" aria-label={t('push.quietEnd')} value={minToTime(quiet.end)} onChange={(e) => { const m = timeToMin(e.target.value); if (m !== null) setQuiet({ end: m }) }} />
                </label>
              </div>
            )}
          </Grp>
        </>
      )}
    </>
  )
}
