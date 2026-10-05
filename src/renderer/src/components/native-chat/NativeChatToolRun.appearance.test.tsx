// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'
import { NativeChatToolRun } from './NativeChatToolRun'
import { nativeChatAppearanceStyle } from './native-chat-appearance-style'

afterEach(cleanup)

const blocks: NativeChatBlock[] = [
  { type: 'tool-call', name: 'Bash', input: { command: 'test' }, state: 'failed' },
  { type: 'tool-result', output: 'exit 1', isError: true },
  { type: 'tool-call', name: 'Read', input: { file_path: 'a.ts' }, state: 'completed' },
  { type: 'tool-call', name: 'Write', input: { file_path: 'a.ts' }, state: 'completed' },
  { type: 'tool-call', name: 'Grep', input: { pattern: 'todo' }, state: 'completed' },
  { type: 'tool-call', name: 'Task', input: { description: 'Review' }, state: 'completed' }
]

describe('tool-run summary in a matching chat', () => {
  it.each([false, true])('allows the full summary to wrap, live=%s', (live) => {
    const style = nativeChatAppearanceStyle({
      terminalFontFamily: 'Menlo',
      nativeChatAppearance: { matchTerminalInterface: true }
    })
    const { container } = render(
      <div className="native-chat-appearance" style={style}>
        <div className="max-w-(--chat-content-max-width)">
          <NativeChatToolRun blocks={blocks} expandSignal={false} activeTurnIsWorking={live} />
        </div>
      </div>
    )
    expect(style['--chat-content-max-width']).toBe('46rem')
    expect(style['--chat-font-family']).toContain('Menlo')
    const summary = container.querySelector('span.native-chat-message-text')
    expect(summary).toHaveTextContent(live ? 'running 1 agent' : 'ran 1 agent')
    expect(summary).toHaveClass('min-w-0', 'whitespace-normal', 'break-words')
    expect(summary).not.toHaveClass('truncate', 'whitespace-nowrap', 'overflow-hidden', 'font-mono')
    const failure = container.querySelector('[aria-label="Failed tool calls: 1"]')
    expect(failure).toHaveTextContent('1 failed')
    expect(failure).toHaveClass('shrink-0')
  })
})
