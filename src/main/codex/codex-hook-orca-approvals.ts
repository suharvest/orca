import { readHooksJson, type HooksConfig } from '../agent-hooks/installer-utils'
import {
  computeTrustKey,
  getCodexExplicitHomeHookSourcePath,
  readHookTrustEntries,
  type CodexEventLabel,
  type CodexHookTrustState
} from './config-toml-trust'
import {
  CODEX_EVENTS,
  CODEX_EVENT_LABEL,
  computeOrcaCodexHookHashes,
  getCodexConfigTomlPath,
  getConfigPath,
  getSystemCodexConfigTomlPath
} from './codex-hook-definition'
import { readEveryKnownCodexHookHashes } from './codex-hook-hash-lookup'
import {
  getRealHomeHookKeySourcePaths,
  getRealHomeHooksJsonPath
} from './codex-real-home-hooks-json'
import type { CodexHookHashes } from './codex-hook-trust-derivation'

/** One Codex home's hook files, and every path Codex may key its entries by. */
export type CodexHookHome = {
  hooksJsonPath: string
  tomlPath: string
  keySourcePaths: readonly [string, ...string[]]
}

export function getManagedCodexHookHome(runtimeHomePath: string): CodexHookHome {
  const hooksJsonPath = getConfigPath(runtimeHomePath)
  return {
    hooksJsonPath,
    tomlPath: getCodexConfigTomlPath(runtimeHomePath),
    keySourcePaths: [getCodexExplicitHomeHookSourcePath(hooksJsonPath)]
  }
}

/** ~/.codex, under every spelling Codex may key its entries by. */
export function getRealHomeCodexHookHome(): CodexHookHome {
  return {
    hooksJsonPath: getRealHomeHooksJsonPath(),
    tomlPath: getSystemCodexConfigTomlPath(),
    keySourcePaths: getRealHomeHookKeySourcePaths()
  }
}

type CodexEventName = (typeof CODEX_EVENTS)[number]
type OrcaEntrySlot = { groupIndex: number; handlerIndex: number }
type OrcaEntryApproval = CodexHookTrustState & { trustedHash: string }

/** Where each event holds Orca's entry first. */
export function findOrcaEntrySlots(
  hooks: HooksConfig['hooks'],
  command: string
): Map<CodexEventName, OrcaEntrySlot> {
  return new Map(
    CODEX_EVENTS.flatMap((eventName) => {
      const definitions = Array.isArray(hooks?.[eventName]) ? hooks[eventName] : []
      const slot = definitions.flatMap((definition, groupIndex) =>
        (definition.hooks ?? []).flatMap((hook, handlerIndex) =>
          hook.command === command ? [{ groupIndex, handlerIndex }] : []
        )
      )[0]
      return slot ? [[eventName, slot] as const] : []
    })
  )
}

/** Per event, the approvals holding a hash at Orca's entry, one per spelling Codex keys it by. */
export function approvalsAtOrcaEntries(
  trustStates: ReadonlyMap<string, CodexHookTrustState>,
  slots: ReadonlyMap<CodexEventName, OrcaEntrySlot>,
  keySourcePaths: readonly string[],
  command: string
): Map<CodexEventLabel, OrcaEntryApproval[]> {
  return new Map(
    [...slots].map(([eventName, slot]) => {
      const eventLabel = CODEX_EVENT_LABEL[eventName]
      const approvals = keySourcePaths.flatMap((sourcePath) => {
        const state = trustStates.get(computeTrustKey({ sourcePath, eventLabel, command, ...slot }))
        return state?.trustedHash ? [{ ...state, trustedHash: state.trustedHash }] : []
      })
      return [eventLabel, approvals]
    })
  )
}

/**
 * Until Codex answers: Orca's own hash, overlaid with each event's approval at
 * Orca's entry. Only a hash Orca's entry may carry counts: keys are positional,
 * so a removed user hook's approval can be left at Orca's key.
 */
export function readStopgapOrcaHashes(home: CodexHookHome, command: string): CodexHookHashes {
  let trustStates: ReadonlyMap<string, CodexHookTrustState>
  try {
    trustStates = readHookTrustEntries(home.tomlPath)
  } catch {
    trustStates = new Map()
  }
  return findStopgapOrcaHashes({
    trustStates,
    hooks: readHooksJson(home.hooksJsonPath)?.hooks,
    keySourcePaths: home.keySourcePaths,
    command,
    knownOrcaHashes: [computeOrcaCodexHookHashes(command), ...readEveryKnownCodexHookHashes()]
  })
}

/** `readStopgapOrcaHashes` over files already read, counting only `knownOrcaHashes`. */
export function findStopgapOrcaHashes(found: {
  trustStates: ReadonlyMap<string, CodexHookTrustState>
  hooks: HooksConfig['hooks']
  keySourcePaths: readonly string[]
  command: string
  knownOrcaHashes: readonly CodexHookHashes[]
}): CodexHookHashes {
  const slots = findOrcaEntrySlots(found.hooks, found.command)
  const approvals = approvalsAtOrcaEntries(
    found.trustStates,
    slots,
    found.keySourcePaths,
    found.command
  )
  return {
    ...computeOrcaCodexHookHashes(found.command),
    ...Object.fromEntries(
      [...approvals].flatMap(([eventLabel, held]) => {
        // Why a known hash also holds for a rewritten copy: Codex hashes content, not position.
        const approval = held.find(({ trustedHash }) =>
          found.knownOrcaHashes.some((hashes) => hashes[eventLabel] === trustedHash)
        )
        return approval ? [[eventLabel, approval.trustedHash]] : []
      })
    )
  }
}
