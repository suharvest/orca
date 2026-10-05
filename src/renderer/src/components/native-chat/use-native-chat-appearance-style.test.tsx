// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { resetSystemPrefersDarkSubscriptionForTests } from '../terminal-pane/use-system-prefers-dark'
import { useNativeChatAppearanceStyle } from './native-chat-appearance-style'

afterEach(() => {
  cleanup()
  resetSystemPrefersDarkSubscriptionForTests()
  vi.restoreAllMocks()
})

describe('shared chat appearance hook', () => {
  it('updates every consumer from one system-scheme subscription', () => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const matches = vi.spyOn(media, 'matches', 'get').mockReturnValue(true)
    vi.spyOn(window, 'matchMedia').mockReturnValue(media)
    const addListener = vi.spyOn(media, 'addEventListener')
    const removeListener = vi.spyOn(media, 'removeEventListener')
    const settings = createGlobalSettingsFixture({
      theme: 'system',
      terminalUseSeparateLightTheme: true,
      terminalThemeDark: 'Builtin Tango Dark',
      terminalThemeLight: 'Builtin Tango Light',
      nativeChatAppearance: { matchTerminalInterface: true }
    })
    const chat = renderHook(() => useNativeChatAppearanceStyle(settings))
    const preview = renderHook(() => useNativeChatAppearanceStyle(settings))
    expect(addListener).toHaveBeenCalledTimes(1)
    expect(chat.result.current.colorScheme).toBe('dark')
    const darkBackground = chat.result.current['--chat-source-background']
    act(() => {
      matches.mockReturnValue(false)
      media.dispatchEvent(new MediaQueryListEvent('change', { matches: false }))
    })
    expect(chat.result.current.colorScheme).toBe('light')
    expect(chat.result.current['--chat-source-background']).not.toBe(darkBackground)
    expect(chat.result.current['--chat-foreground-mix']).toBe('82%')
    expect(preview.result.current).toEqual(chat.result.current)
    chat.unmount()
    expect(removeListener).not.toHaveBeenCalled()
    preview.unmount()
    expect(removeListener).toHaveBeenCalledTimes(1)
  })
})
