import { describe, it, expect } from 'vitest'
import i18next from 'i18next'
import rooms from '../en/rooms.json'
import engine from '../en/engine.json'
import roomsRu from '../ru/rooms.json'
import engineRu from '../ru/engine.json'

const make = async (lng: string, res: Record<string, object>) => {
  const i18n = i18next.createInstance()
  await i18n.init({ lng, resources: { [lng]: res }, interpolation: { escapeValue: false } })
  return i18n
}

describe('rooms and engine counts use proper plurals', () => {
  it('says "1 participant", "Across 1 room", "1 reply measured"', async () => {
    const i18n = await make('en', { rooms, engine })
    expect(i18n.t('rooms:list.participants', { count: 1 })).toBe('1 participant')
    expect(i18n.t('rooms:list.participants', { count: 2 })).toBe('2 participants')
    expect(i18n.t('rooms:list.turns', { count: 1 })).toBe('1 turn')
    expect(i18n.t('rooms:stage.draftHint', { count: 1, mode: 'Compare' })).toBe('1 participant · Compare')
    expect(i18n.t('rooms:kpi.turnsHint', { count: 1 })).toBe('Across 1 room')
    expect(i18n.t('engine:kpi.repliesSub', { count: 1 })).toBe('1 reply measured')
    expect(i18n.t('engine:kpi.repliesSub', { count: 4 })).toBe('4 replies measured')
  })

  it('follows the Russian one/few/many rules', async () => {
    const i18n = await make('ru', { rooms: roomsRu, engine: engineRu })
    expect(i18n.t('rooms:list.participants', { count: 1 })).toBe('1 участник')
    expect(i18n.t('rooms:list.participants', { count: 3 })).toBe('3 участника')
    expect(i18n.t('rooms:list.participants', { count: 5 })).toBe('5 участников')
    expect(i18n.t('engine:kpi.repliesSub', { count: 21 })).toBe('21 измеренный ответ')
  })
})
