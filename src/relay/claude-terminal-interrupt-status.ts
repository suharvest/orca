import { ClaudeTerminalInterruptTracker } from '../shared/claude-terminal-interrupt'
import type { HookListenerState } from '../shared/agent-hook-listener/listener-state'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import {
  applyRelayClaudeInterrupt,
  type RelayInterruptHost
} from './agent-hook-interrupt-reconciliation'

export function createRelayClaudeTerminalInterrupts(
  state: HookListenerState,
  readHost: () => RelayInterruptHost
): ClaudeTerminalInterruptTracker<AgentHookEventPayload> {
  return new ClaudeTerminalInterruptTracker(
    (paneKey) => state.lastStatusByPaneKey.get(paneKey),
    (row) => {
      const host = readHost()
      const meta = host.getMetadata(row.paneKey)
      if (!host.isListening || !meta || host.isPaneBlocked(row.paneKey)) {
        return
      }
      applyRelayClaudeInterrupt(host, row, meta)
    }
  )
}
