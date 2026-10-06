import { translate } from '@/i18n/i18n'
import type { StructuredAgentSessionLaunchLifecycle } from '@/lib/structured-agent-session-launch'
import { agentSessionRefusalCauseParts } from '../../../../shared/agent-session-refusal-notice'
import type { AgentSessionWriteRefusal } from '../../../../shared/agent-session-write-failure'
import { joinSentences } from '../../../../shared/sentence-joining'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import type { StructuredAgentSessionReadFailureNotice } from './structured-agent-session-read-failure-notice'
import type {
  NativeChatComposerNotice,
  NativeChatComposerNoticeContent
} from './native-chat-composer-notice'

/** A chat whose start failed or went unconfirmed, as a notice with Retry. */
function nativeChatLaunchNotice({
  lifecycle,
  failure = null,
  agentLabel,
  onRetry
}: {
  lifecycle: StructuredAgentSessionLaunchLifecycle | null
  /** The host's refusal behind the failed start; its message is never shown. */
  failure?: AgentSessionWriteRefusal | null
  /** Names the agent in a start failure's words. */
  agentLabel?: string
  onRetry: () => void
}): NativeChatComposerNotice | null {
  if (lifecycle !== 'failed' && lifecycle !== 'visibility-unknown') {
    return null
  }
  const message =
    lifecycle === 'failed'
      ? translate(
          'auto.components.native.chat.NativeChatLaunchRetry.failed',
          'Chat could not be started.'
        )
      : translate(
          'auto.components.native.chat.NativeChatLaunchRetry.unknown',
          'Chat connection could not be confirmed.'
        )
  const cause =
    lifecycle === 'failed' && failure
      ? agentSessionWriteNoticeText(
          agentSessionRefusalCauseParts(failure, agentLabel ? { agentName: agentLabel } : {})
        )
      : ''
  return {
    key: 'launch',
    kind: 'error',
    text: cause ? joinSentences([message, cause]) : message,
    action: {
      label: translate('auto.components.native.chat.NativeChatLaunchRetry.retry', 'Retry'),
      onClick: onRetry
    }
  }
}

/** A structured chat's own notices, for the card above its composer, and whether its pane is only
 *  reconnecting. A read failure is said once: on the pane when it took the pane, else here; one
 *  that names nothing is only the pane reconnecting. */
export function structuredSessionNotices({
  launch,
  agentLabel,
  paneFailed,
  readFailure,
  chatError,
  composerError
}: {
  launch: {
    lifecycle: StructuredAgentSessionLaunchLifecycle | null
    failure: AgentSessionWriteRefusal | null
    retry: () => void
  }
  agentLabel: string
  /** The read failure took the whole pane, which says it there. */
  paneFailed: boolean
  readFailure: StructuredAgentSessionReadFailureNotice | null
  chatError: string | null
  composerError: (NativeChatComposerNoticeContent & { onDismiss: () => void }) | null
}): { notices: NativeChatComposerNotice[]; reconnecting: boolean } {
  const sessionError = paneFailed || !readFailure?.named ? chatError : readFailure.text
  const launchNotice = nativeChatLaunchNotice({
    lifecycle: launch.lifecycle,
    failure: launch.failure,
    agentLabel,
    onRetry: launch.retry
  })
  return {
    notices: [
      ...(launchNotice ? [launchNotice] : []),
      ...(sessionError ? [{ key: 'session', kind: 'error' as const, text: sessionError }] : []),
      ...(composerError ? [{ key: 'composer', kind: 'error' as const, ...composerError }] : [])
    ],
    reconnecting: !paneFailed && readFailure !== null && !readFailure.named && !sessionError
  }
}
