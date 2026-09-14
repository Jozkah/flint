import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { ToolApprovalDialog } from '../ToolApprovalDialog'
import { describePermissionRequest } from '@/lib/permissionRequest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const named = options?.tool ?? options?.server
      return named ? `${key}:${named}` : key
    },
  }),
}))

const mcpRequest = describePermissionRequest({
  toolName: 'create_issue',
  serverName: 'github',
  input: { title: 'Bug', token: 'secret-value' },
})

const renderDialog = (
  request = mcpRequest,
  onDecision = vi.fn()
) => {
  render(
    <ToolApprovalDialog
      open
      toolName={request.technicalDetails.toolName}
      request={request}
      onDecision={onDecision}
    />
  )
  return onDecision
}

describe('ToolApprovalDialog', () => {
  it('offers exactly the scopes the request supports, least broad first', () => {
    renderDialog()
    const offered = Array.from(
      document.querySelectorAll<HTMLElement>('[data-scope]')
    ).map((el) => el.dataset.scope)
    expect(offered).toEqual(['allow-once', 'allow-thread', 'allow-always'])
    expect(screen.getByText('permissions:scope.broader')).toBeInTheDocument()
  })

  it('leaves out a scope the request does not support', () => {
    renderDialog(
      describePermissionRequest({
        toolName: 'fetch',
        serverName: 's',
        threadIsEphemeral: true,
      })
    )
    const offered = Array.from(
      document.querySelectorAll<HTMLElement>('[data-scope]')
    ).map((el) => el.dataset.scope)
    expect(offered).toEqual(['allow-once', 'allow-always'])
    expect(
      screen.queryByText('permissions:scope.allowThread')
    ).not.toBeInTheDocument()
  })

  it('ties each scope button to its explanation', () => {
    renderDialog()
    const always = screen.getByRole('button', {
      name: 'permissions:scope.allowAlwaysServer:github',
    })
    expect(always).toHaveAccessibleDescription(
      'permissions:scope.alwaysServerExplanation:github'
    )
  })

  it('puts initial focus on Deny, not on Always', async () => {
    renderDialog()
    await waitFor(() =>
      expect(document.activeElement).toHaveTextContent('permissions:scope.deny')
    )
    expect(document.activeElement).not.toHaveAttribute('data-scope', 'allow-always')
  })

  it('tabs from Deny through the scopes, narrowest first', async () => {
    const user = userEvent.setup()
    renderDialog()
    await waitFor(() =>
      expect(document.activeElement).toHaveTextContent('permissions:scope.deny')
    )
    const order: (string | undefined)[] = []
    for (let i = 0; i < 3; i++) {
      await user.tab()
      order.push((document.activeElement as HTMLElement).dataset.scope)
    }
    expect(order).toEqual(['allow-once', 'allow-thread', 'allow-always'])
  })

  it('opens the technical details from the keyboard, with secrets redacted', async () => {
    const user = userEvent.setup()
    renderDialog()
    const trigger = screen.getByRole('button', {
      name: 'permissions:request.technicalDetails',
    })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/"title": "Bug"/)).not.toBeInTheDocument()

    trigger.focus()
    await user.keyboard('{Enter}')

    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const args = screen.getByText(/"title": "Bug"/)
    expect(args).toHaveTextContent('[redacted]')
    expect(args).not.toHaveTextContent('secret-value')
  })

  it('reports each decision', async () => {
    const user = userEvent.setup()
    const onDecision = renderDialog()
    await user.click(screen.getByText('permissions:scope.allowOnce'))
    await user.click(screen.getByText('permissions:scope.allowThread'))
    await user.click(screen.getByText('permissions:scope.allowAlwaysServer:github'))
    await user.click(screen.getByText('permissions:scope.deny'))
    expect(onDecision.mock.calls.map((c) => c[0])).toEqual([
      'allow-once',
      'allow-thread',
      'allow-always',
      'deny',
    ])
  })

  it('treats Escape as deny', async () => {
    const user = userEvent.setup()
    const onDecision = renderDialog()
    await user.keyboard('{Escape}')
    expect(onDecision).toHaveBeenCalledWith('deny')
  })

  it('shows what is affected and what allowing it means', () => {
    renderDialog(
      describePermissionRequest({
        toolName: 'bash',
        input: { command: 'rm -rf build' },
        taskContext: 'Clean the build output',
      })
    )
    expect(screen.getByText('permissions:action.runCommand')).toBeInTheDocument()
    expect(screen.getByText('rm -rf build')).toBeInTheDocument()
    expect(screen.getByText('Clean the build output')).toBeInTheDocument()
    expect(screen.getByText('permissions:consequence.command')).toBeInTheDocument()
    expect(screen.getByText('permissions:category.command')).toBeInTheDocument()
  })

  it('keeps the legacy shell working without a described request', async () => {
    const user = userEvent.setup()
    const onDecision = vi.fn()
    render(
      <ToolApprovalDialog open toolName="x" offersAlways={false} onDecision={onDecision} />
    )
    expect(screen.queryByText('tools:toolApproval.alwaysAllow')).not.toBeInTheDocument()
    await user.click(screen.getByText('tools:toolApproval.allowOnce'))
    expect(onDecision).toHaveBeenCalledWith('allow-once')
  })
})
