import { useCallback, useMemo, useState, type RefObject } from 'react'
import { useMeasuredWidth } from '../right-sidebar/right-sidebar-measured-width'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import {
  nativeChatColumnWidthBucket,
  selectNativeChatAppearanceSettings,
  useNativeChatAppearanceStyle
} from './native-chat-appearance-style'

export function useNativeChatRowTypography(contentRef: RefObject<HTMLDivElement | null>) {
  const appearanceSettings = useAppStore(
    useShallow((state) => selectNativeChatAppearanceSettings(state.settings))
  )
  const [columnWidthPx, setColumnWidthPx] = useState<number | null>(null)
  const commitWidth = useCallback((width: number | null) => {
    setColumnWidthPx(nativeChatColumnWidthBucket(width))
  }, [])
  const measureWidth = useMeasuredWidth(commitWidth)
  const measureContent = useCallback(
    (node: HTMLDivElement | null) => {
      contentRef.current = node
      measureWidth(node)
    },
    [contentRef, measureWidth]
  )
  const style = useNativeChatAppearanceStyle(appearanceSettings, columnWidthPx)
  const lineHeightPx = style['--chat-estimated-line-height']
  const charsPerLine = style['--chat-estimated-chars-per-line']
  const typography = useMemo(() => ({ lineHeightPx, charsPerLine }), [lineHeightPx, charsPerLine])
  return { measureContent, typography }
}
