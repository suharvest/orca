// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)

vi.mock('@/runtime/structured-agent-session-client', () =>
  moduleFactories.structuredAgentSessionClient()
)
vi.mock('./use-structured-agent-session', () => moduleFactories.useStructuredAgentSession())
vi.mock('./use-native-chat-font-size', () => moduleFactories.useNativeChatFontSize())
vi.mock('./use-native-chat-file-link-context', () => moduleFactories.useNativeChatFileLinkContext())
vi.mock('./use-native-chat-file-link-click', () => moduleFactories.useNativeChatFileLinkClick())
vi.mock('./NativeChatMessageList', () => moduleFactories.nativeChatMessageList())
vi.mock('./NativeChatComposer', () => moduleFactories.nativeChatComposer())
vi.mock('./NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('./NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())

import { NativeChatStructuredSession } from './NativeChatStructuredSession'
import {
  resetStructuredAgentSessionChatLinesForTests,
  setStructuredAgentSessionChatLine
} from './structured-agent-session-returned-send'

const SESSION_ID = 'notice-card-session'

afterEach(() => {
  cleanup()
  resetStructuredSessionMocks()
  resetStructuredAgentSessionChatLinesForTests()
})

function renderPane(): void {
  render(
    <NativeChatStructuredSession
      isVisible
      isFocusedGroup
      tabId="structured-notice-card-tab"
      sessionId={SESSION_ID}
      target={{ kind: 'local' }}
      agent="codex"
    />
  )
}

function composerOnError(): (text: string | null, errorText?: string) => void {
  const onError = mocks.composerProps?.structuredTransport?.onError
  if (typeof onError !== 'function') {
    throw new Error('composer transport has no onError')
  }
  return (text, errorText) => Reflect.apply(onError, undefined, [text, errorText])
}

it('shows the chat line and a composer error together, where one used to hide the other', () => {
  renderPane()
  act(() => {
    setStructuredAgentSessionChatLine(SESSION_ID, ['messageNotSaved'])
    composerOnError()('sonnet-9 is not an available model for this chat session.')
  })
  expect(screen.getByText("Couldn't save your message.")).toBeTruthy()
  expect(screen.getByText('sonnet-9 is not an available model for this chat session.')).toBeTruthy()
  expect(screen.getAllByRole('alert')).toHaveLength(2)
})

it('keeps a send failure’s raw error apart and lets the user dismiss it', () => {
  renderPane()
  act(() => {
    composerOnError()('Your message was not sent.', 'connect ECONNREFUSED /tmp/agent-host.sock')
  })
  expect(screen.getByText('connect ECONNREFUSED /tmp/agent-host.sock').tagName).toBe('PRE')
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  expect(screen.queryByText('Your message was not sent.')).toBeNull()
})
