import './native-chat-appearance.css'
import type { CSSProperties } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { resolveNativeChatAppearanceSettings } from '../../../../shared/native-chat-appearance-settings'
import { resolveConfiguredTerminalColors } from '../../../../shared/terminal-theme-selection'
import { buildFontFamily } from '@/lib/monospace-font-family'
import { getSystemPrefersDark, isTerminalBackgroundLight } from '@/lib/terminal-theme'
import { useSystemPrefersDark } from '../terminal-pane/use-system-prefers-dark'

export const NATIVE_CHAT_APPEARANCE_ROOT_CLASS = 'native-chat-appearance bg-chat-canvas'
export const NATIVE_CHAT_TRANSCRIPT_OUTER_CLASS = 'px-3 pt-10 pb-4 sm:px-4'
export const NATIVE_CHAT_TRANSCRIPT_COLUMN_CLASS =
  'mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-5 px-[5px]'

export type NativeChatAppearanceStyle = CSSProperties & Record<`--${string}`, string | number> & {
  '--chat-font-size': string
  '--chat-code-font-size': string
  '--chat-content-max-width': string
  '--chat-inline-code-ratio': string
  '--chat-estimated-line-height': number
  '--chat-estimated-chars-per-line': number
}

// Width buckets keep a pixel-by-pixel resize from re-deriving the entire transcript.
export function nativeChatColumnWidthBucket(width: number | null | undefined): number | null {
  return typeof width === 'number' && Number.isFinite(width) && width > 0
    ? Math.max(1, Math.floor(width / 32) * 32)
    : null
}

export function nativeChatContrastMix(contrast: number, light: boolean): number {
  const value = Number.isFinite(contrast) ? Math.min(150, Math.max(50, contrast)) : 100
  return light
    ? Math.min(100, Math.max(55, 82 + (value - 100) * 0.36))
    : Math.min(100, Math.max(50, 78 + (value - 100) * 0.44))
}

export function nativeChatAppearanceStyle(
  settings: Partial<GlobalSettings> | null | undefined,
  measuredColumnWidthPx?: number | null,
  systemPrefersDark = getSystemPrefersDark()
): NativeChatAppearanceStyle {
  const appearance = resolveNativeChatAppearanceSettings(settings?.nativeChatAppearance)
  const { fontSize, codeFontSize, width } = appearance
  const maxWidthPx = width === 'wide' ? 960 : width === 'full' ? Number.POSITIVE_INFINITY : 736
  const measuredWidth = nativeChatColumnWidthBucket(measuredColumnWidthPx)
  const columnWidthPx = Math.min(
    measuredWidth ? measuredWidth : width === 'wide' ? 960 : 736,
    maxWidthPx
  )
  const font = buildFontFamily(settings?.terminalFontFamily ?? '')
  const style: NativeChatAppearanceStyle = {
    '--chat-font-size': `${fontSize}px`,
    '--chat-code-font-size': `${codeFontSize}px`,
    '--chat-content-max-width': width === 'full' ? 'none' : width === 'wide' ? '60rem' : '46rem',
    '--chat-inline-code-ratio': `${codeFontSize / fontSize}em`,
    '--chat-estimated-line-height': (22 * fontSize) / 14,
    '--chat-estimated-chars-per-line': Math.max(
      1,
      Math.floor((((96 * columnWidthPx) / 736) * 14) / fontSize)
    ),
    '--chat-code-font-family': font
  }
  let light = settings?.theme === 'light' || (settings?.theme === 'system' && !systemPrefersDark)
  if (appearance?.matchTerminalInterface === true) {
    const colors = resolveConfiguredTerminalColors(
      {
        theme: settings?.theme ?? 'dark',
        terminalThemeDark: settings?.terminalThemeDark ?? '',
        terminalThemeLight: settings?.terminalThemeLight ?? '',
        terminalUseSeparateLightTheme: settings?.terminalUseSeparateLightTheme ?? false,
        terminalCustomThemes: settings?.terminalCustomThemes,
        terminalColorOverrides: settings?.terminalColorOverrides
      },
      systemPrefersDark
    )
    light = isTerminalBackgroundLight(colors.background)
    Object.assign(style, {
      '--chat-font-family': font,
      '--background': 'var(--chat-canvas)',
      '--foreground': 'var(--chat-foreground-strong)',
      '--muted-foreground': 'var(--chat-foreground-faint)',
      '--accent': 'var(--chat-code-surface)',
      '--accent-foreground': 'var(--chat-foreground-strong)',
      '--border': 'var(--chat-code-border)',
      '--input': 'var(--chat-composer-border)',
      '--card': 'var(--chat-user-surface)',
      '--card-foreground': 'var(--chat-foreground-strong)',
      '--primary': 'var(--chat-foreground-strong)',
      '--primary-foreground': 'var(--chat-canvas)',
      '--secondary': 'var(--chat-user-surface)',
      '--secondary-foreground': 'var(--chat-foreground-strong)',
      '--ring': 'var(--chat-foreground-faint)',
      '--chat-source-background': colors.background,
      '--chat-source-foreground': colors.foreground,
      '--chat-source-muted-foreground':
        'color-mix(in srgb, var(--chat-source-foreground) 62%, var(--chat-canvas))',
      '--chat-canvas-mix': '0%',
      '--chat-strong-mix': light ? '92%' : '90%',
      '--chat-faint-mix': light ? '100%' : '83%',
      '--chat-user-mix': light ? '4%' : '7%',
      '--chat-user-border-mix': light ? '7%' : '6%',
      '--chat-code-mix': light ? '2%' : '3.5%',
      '--chat-code-base': light ? 'var(--chat-canvas)' : 'transparent',
      '--chat-inline-code-mix': light ? '4%' : '6%',
      '--chat-inline-code-base': light ? 'var(--chat-canvas)' : 'transparent',
      '--chat-inline-code-border-mix': light ? '9%' : '8%',
      '--chat-composer-mix': light ? '0%' : '4%',
      '--chat-composer-base': light ? 'var(--chat-canvas)' : 'transparent',
      '--chat-composer-border-mix': light ? '11%' : '9%'
    })
  }
  style['--chat-foreground-mix'] = `${nativeChatContrastMix(appearance?.contrast ?? 100, light)}%`
  return style
}

export function useNativeChatAppearanceStyle(
  settings: Partial<GlobalSettings> | null | undefined
): NativeChatAppearanceStyle {
  return nativeChatAppearanceStyle(settings, undefined, useSystemPrefersDark())
}
