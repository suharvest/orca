// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { AppearanceChatSection } from './AppearanceChatSection'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))
afterEach(cleanup)

describe('chat contrast controls', () => {
  it('renders a switch and saves the opt-in choice', () => {
    const updateSettings = vi.fn()
    render(
      <AppearanceChatSection
        settings={createGlobalSettingsFixture()}
        updateSettings={updateSettings}
      />
    )
    fireEvent.click(screen.getByRole('switch', { name: 'Match terminal interface' }))
    expect(updateSettings).toHaveBeenCalledWith({
      nativeChatAppearance: { matchTerminalInterface: true }
    })
  })

  it('shows the clamped contrast and supports slider keyboard input', () => {
    const updateSettings = vi.fn()
    render(
      <AppearanceChatSection
        settings={createGlobalSettingsFixture({ nativeChatAppearance: { contrast: 999 } })}
        updateSettings={updateSettings}
      />
    )
    const slider = screen.getByRole('slider', { name: 'Contrast' })
    expect(slider.getAttribute('aria-valuenow')).toBe('150')
    fireEvent.keyDown(slider, { key: 'ArrowLeft' })
    expect(updateSettings).toHaveBeenCalledWith({ nativeChatAppearance: { contrast: 149 } })
    expect(screen.getByText('Softer')).toBeTruthy()
    expect(screen.getByText('Sharper')).toBeTruthy()
  })
})
