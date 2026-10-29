import { describe, it, expect } from 'vitest'
import {
  boundedReadState,
  dirErrorState,
  projectReadErrorState,
} from '../coworkCodeRead'

describe('dirErrorState', () => {
  it('maps a permission refusal to denied', () => {
    expect(dirErrorState('DENIED: /x')).toEqual({ status: 'denied' })
  })
  it('keeps any other message as an error', () => {
    expect(dirErrorState('boom')).toEqual({ status: 'error', message: 'boom' })
  })
})

describe('projectReadErrorState', () => {
  it('sensitive wins over every other marker', () => {
    expect(projectReadErrorState('SENSITIVE: .env')).toEqual({
      status: 'sensitive',
    })
  })
  it('maps a permission refusal to denied', () => {
    expect(projectReadErrorState('DENIED: a.ts')).toEqual({ status: 'denied' })
  })
  it('maps not-found messages to missing with the detail', () => {
    expect(projectReadErrorState('No such file (os error 2)')).toEqual({
      status: 'missing',
      detail: 'No such file (os error 2)',
    })
  })
  it('keeps anything else as an error', () => {
    expect(projectReadErrorState('disk on fire')).toEqual({
      status: 'error',
      message: 'disk on fire',
    })
  })
})

describe('boundedReadState', () => {
  it('passes ready content through', () => {
    expect(boundedReadState({ status: 'ready', content: 'x' })).toEqual({
      status: 'ready',
      content: 'x',
    })
  })
  it('keeps the oversized size and preview', () => {
    expect(
      boundedReadState({ status: 'oversized', size: 9, preview: 'ab' })
    ).toEqual({ status: 'oversized', size: 9, preview: 'ab' })
  })
  it('maps binary', () => {
    expect(boundedReadState({ status: 'binary' })).toEqual({ status: 'binary' })
  })
  it('maps an HTTP miss to missing with detail 404', () => {
    expect(boundedReadState({ status: 'missing' })).toEqual({
      status: 'missing',
      detail: '404',
    })
  })
  it('records nothing for an aborted read', () => {
    expect(boundedReadState({ status: 'error', message: 'aborted' })).toBeNull()
  })
  it('maps a not-found error message to missing', () => {
    expect(boundedReadState({ status: 'error', message: 'ENOENT' })).toEqual({
      status: 'missing',
      detail: 'ENOENT',
    })
  })
  it('keeps other errors', () => {
    expect(boundedReadState({ status: 'error', message: '500' })).toEqual({
      status: 'error',
      message: '500',
    })
  })
})
