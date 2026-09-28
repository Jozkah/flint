import { expect, it, vi } from 'vitest'
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
vi.mock('@/hooks/useConversationPane', () => ({
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

it('offers to enable tool calls when model printed a tool call as text', () => {
  const message = {
    id: 'raw-tool',
    role: 'assistant',
    parts: [
      {
        type: 'text',
        text: '<tool_call> <function=shell_run></function> </tool_call>',
      },
    ],
  } as UIMessage
  render(
    <MessageItem
      message={message}
      isFirstMessage={false}
      isLastMessage={true}
      status="ready"
    />
  )
  fireEvent.click(
    screen.getByRole('button', { name: 'common:modelCapability.enableTools' })
  )
  expect(provider.update).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('enable-model-capability'))
  expect(provider.update).toHaveBeenCalledWith(
    'llamacpp',
    expect.objectContaining({
      models: [expect.objectContaining({ capabilities: ['tools'] })],
    })
  )
})
