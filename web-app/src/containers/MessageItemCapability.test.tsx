import { beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { UIMessage } from 'ai'

const provider = vi.hoisted(() => ({
  update: vi.fn(),
  current: {
    provider: 'llamacpp',
    models: [{ id: 'plain', capabilities: [] }],
  },
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
const pane = vi.hoisted(() => ({ threadId: 'thread-1' as string | undefined }))
vi.mock('@/hooks/useConversationPane', () => ({
  useConversationPane: () => (pane.threadId ? { threadId: pane.threadId } : null),
  useConversationModel: () => ({
    selectedProvider: 'llamacpp',
    selectedModel: provider.current.models[0],
  }),
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (select: (state: unknown) => unknown) =>
    select({
      getProviderByName: () => provider.current,
      updateProvider: provider.update,
    }),
}))
vi.mock('@tanstack/react-router', () => ({ useParams: () => ({}) }))

import { MessageItem } from './MessageItem'

import { useThreadToolGrants } from '@/hooks/useThreadToolGrants'

const unavailableTool = {
  id: 'unavailable-tool',
  role: 'assistant',
  parts: [
    {
      type: 'tool-web_fetch',
      toolCallId: 'c1',
      state: 'output-error',
      input: {},
      errorText:
        "Model tried to call unavailable tool 'web_fetch'. No tools are available.",
    },
  ],
} as unknown as UIMessage

const show = (message: UIMessage, onRegenerate = vi.fn()) => {
  render(
    <MessageItem
      message={message}
      isFirstMessage={false}
      isLastMessage={true}
      status="ready"
      onRegenerate={onRegenerate}
    />
  )
  return onRegenerate
}

beforeEach(() => {
  provider.update.mockClear()
  pane.threadId = 'thread-1'
  useThreadToolGrants.setState({ byThread: {} })
})

it('enables tool calls in this conversation and reruns the reply', () => {
  const onRegenerate = show(unavailableTool)
  fireEvent.click(
    screen.getByRole('button', { name: 'common:modelCapability.enableThread' })
  )
  expect(useThreadToolGrants.getState().byThread).toEqual({ 'thread-1': true })
  expect(provider.update).not.toHaveBeenCalled()
  expect(onRegenerate).toHaveBeenCalledWith('unavailable-tool')
  expect(screen.queryByTestId('enable-tools-card')).toBeNull()
})

it('always enables tool calls on the model from the broader options', () => {
  const onRegenerate = show(unavailableTool)
  expect(
    screen.queryByText('common:modelCapability.enableAlways')
  ).toBeNull()
  fireEvent.click(screen.getByTestId('enable-tools-more-options'))
  fireEvent.click(screen.getByText('common:modelCapability.enableAlways'))
  expect(provider.update).toHaveBeenCalledWith(
    'llamacpp',
    expect.objectContaining({
      models: [expect.objectContaining({ capabilities: ['tools'] })],
    })
  )
  expect(useThreadToolGrants.getState().byThread).toEqual({})
  expect(onRegenerate).toHaveBeenCalledWith('unavailable-tool')
})

it('goes away on "Not now" without enabling anything', () => {
  const onRegenerate = show(unavailableTool)
  fireEvent.click(
    screen.getByRole('button', { name: 'common:modelCapability.notNow' })
  )
  expect(screen.queryByTestId('enable-tools-card')).toBeNull()
  expect(provider.update).not.toHaveBeenCalled()
  expect(onRegenerate).not.toHaveBeenCalled()
})

it('offers only "Always enable" outside a conversation', () => {
  pane.threadId = undefined
  show(unavailableTool)
  expect(
    screen.queryByRole('button', { name: 'common:modelCapability.enableThread' })
  ).toBeNull()
  expect(
    screen.getByText('common:modelCapability.enableAlways')
  ).toBeInTheDocument()
})

it('asks when the model printed a tool call as text', () => {
  show({
    id: 'raw-tool',
    role: 'assistant',
    parts: [
      {
        type: 'text',
        text: '<tool_call> <function=shell_run></function> </tool_call>',
      },
    ],
  } as UIMessage)
  expect(screen.getByTestId('enable-tools-card')).toBeInTheDocument()
})

it('does not ask for an ordinary tool failure', () => {
  show({
    id: 'plain-failure',
    role: 'assistant',
    parts: [
      {
        type: 'tool-bash',
        toolCallId: 'c1',
        state: 'output-error',
        input: {},
        errorText: 'sandbox failed',
      },
    ],
  } as unknown as UIMessage)
  expect(screen.queryByTestId('enable-tools-card')).toBeNull()
})
