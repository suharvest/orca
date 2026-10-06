import {
  createManagedCommandMatcher,
  readHooksJsonWithRaw,
  type HookDefinition,
  writeHooksJson,
  writeManagedScript
} from '../agent-hooks/installer-utils'
import { resolveHooksJsonWritePath } from '../agent-hooks/hook-config-write-path'
import {
  assertHooksJsonGeneration,
  backupRealHomeHooksJsonOnce,
  getRealHomeHookKeySourcePaths,
  getRealHomeHooksJsonPath,
  HooksJsonChangedError,
  isAddableHooksFile
} from './codex-real-home-hooks-json'
import { getCodexManagedScriptFileName } from './codex-hook-identity'
import { removeSystemManagedHookTrustEntries } from './codex-hook-trust-cleanup'
import {
  CODEX_EVENT_LABEL,
  getCodexManagedHookInstallMaterial,
  getSystemCodexConfigTomlPath
} from './codex-hook-definition'
import { findApprovedOrcaHashes } from './codex-hook-orca-approvals'
import { getSystemCodexHomePath } from './codex-home-paths'
import { mutateRealHomeHooksPreservingUserTrust } from './codex-user-hook-trust-moves'
import { sweepRealHomeCodexHook } from './codex-real-home-hook-sweep'
import { runExclusivelyForCodexTrustConfig } from './codex-trust-config-mutation-queue'
import {
  planRealHomeCodexHookEntries,
  type RealHomeCodexHookEntryPlan
} from './codex-real-home-hook-entry-plan'
import type { CodexHookHashes } from './codex-hook-trust-derivation'
import {
  findMissingCodexHookApprovals,
  writeCodexHookApprovalsBeforeEntries
} from './codex-hook-approval-first-write'
import {
  codexHookSourcePathsEqual,
  computeTrustKey,
  normalizeHookTrustKeyForLookup,
  parseTrustKey,
  readHookTrustEntries,
  removeHookTrustEntries,
  type CodexHookTrustState,
  type CodexTrustEntry
} from './config-toml-trust'

/**
 * - 'unchanged': Orca's entries and their approvals were already as wanted; nothing written.
 * - 'written': this call wrote approvals, entries, or both.
 * - 'unavailable': ~/.codex could not take Orca's approved entry.
 * - 'disabled': hooks were off when the lane came free; nothing written.
 */
export type RealHomeCodexHookOutcome = 'unchanged' | 'written' | 'unavailable' | 'disabled'

type ReconcileArgs = {
  /** Codex's hashes; null while Codex has not answered, when Orca keeps or computes its own. */
  hashes: CodexHookHashes | null
  /** Hashes Orca may have approved its entry with before: an approval left behind with one is Orca's. */
  knownOrcaHashes: readonly CodexHookHashes[]
  /** Orca's own hash of its entry, the stopgap until Codex answers. */
  computedHashes: CodexHookHashes
  isEnabled: () => boolean
  userDataPath: string
  /** App start and the setting turning on; a launch never fights a running older build. */
  convertOlderForms: boolean
}

type SettlePlan = Extract<RealHomeCodexHookEntryPlan, { kind: 'settle' }>

// Why a bound: each pass either prunes Orca's extra copies or settles; a concurrent save costs one more.
const MAX_PASSES = 4

/**
 * Makes ~/.codex hold Orca's entry alone, last unless already in place, in each
 * event Codex lists, with Codex's hash for it approved and enabled. Writes only
 * what differs; an approval goes in before its entry and is taken back if the
 * entry write fails. Never throws.
 */
export async function reconcileRealHomeCodexHookEntries(
  args: ReconcileArgs
): Promise<RealHomeCodexHookOutcome> {
  try {
    return await runExclusivelyForCodexTrustConfig(getSystemCodexConfigTomlPath(), async () => {
      for (let pass = 0; pass < MAX_PASSES; pass += 1) {
        if (!args.isEnabled()) {
          return 'disabled'
        }
        try {
          const outcome = reconcilePass(args)
          if (outcome !== 'pruned') {
            return outcome
          }
        } catch (error) {
          // Why: a user's save landed between Orca's read and write; the next pass reads it.
          if (!(error instanceof HooksJsonChangedError)) {
            throw error
          }
        }
      }
      throw new Error('Orca entries in ~/.codex did not settle')
    })
  } catch (error) {
    console.warn('[codex-real-home-hooks] could not reconcile Orca entries in ~/.codex:', error)
    return 'unavailable'
  }
}

function reconcilePass(args: ReconcileArgs): RealHomeCodexHookOutcome | 'pruned' {
  const hooksJsonPath = getRealHomeHooksJsonPath()
  const tomlPath = getSystemCodexConfigTomlPath()
  const hooksWritePath = resolveHooksJsonWritePath(hooksJsonPath)
  // Why: the pre-write guard compares against these bytes; a separate later
  // read would let a concurrent save land between parse and write.
  const { raw: previousRaw, config } = readHooksJsonWithRaw(hooksJsonPath)
  if (!isAddableHooksFile(config)) {
    return 'unavailable'
  }
  const hooks = config.hooks ?? {}
  const material = getCodexManagedHookInstallMaterial()
  const sourcePaths = getRealHomeHookKeySourcePaths()
  // Why only listed events: an entry Codex has no hash for would wait for review.
  const listed = args.hashes
  const events = listed
    ? material.events.filter((eventName) => listed[CODEX_EVENT_LABEL[eventName]] !== undefined)
    : material.events
  const plan = planRealHomeCodexHookEntries({
    hooks,
    sourcePath: sourcePaths[0],
    material: { events, command: material.command },
    isOrcaCommand: createManagedCommandMatcher(getCodexManagedScriptFileName()),
    convertOlderForms: args.convertOlderForms
  })
  const writeHooks = (nextHooks: Record<string, HookDefinition[]>): void => {
    backupRealHomeHooksJsonOnce(args.userDataPath, previousRaw)
    assertHooksJsonGeneration(hooksJsonPath, hooksWritePath, previousRaw)
    // Why: unknown fields inside the file belong to the user; preserve them verbatim.
    writeHooksJson(hooksWritePath, { ...config, hooks: nextHooks }, { preserveMode: true })
  }
  if (plan.kind === 'prune') {
    // Why its own write: dropping a copy shifts user hooks, whose approvals must move
    // before Orca writes an approval at a slot one of them still holds.
    mutateRealHomeHooksPreservingUserTrust({
      sourcePaths,
      tomlPath,
      beforeHooks: hooks,
      afterHooks: plan.hooks,
      writeHooks: () => writeHooks(plan.hooks)
    })
    return 'pruned'
  }

  const trustStates = readHookTrustEntries(tomlPath)
  const hashes = args.hashes ?? {
    ...args.computedHashes,
    ...keptApprovedHashes(
      plan,
      hooks,
      trustStates,
      sourcePaths,
      material.command,
      args.knownOrcaHashes
    )
  }
  const approvals = sourcePaths.flatMap((keySource) =>
    plan.managedEntries.flatMap((entry) => {
      const trustedHash = hashes[entry.eventLabel]
      // Why none for null: that Codex lists the entry with no hash, so it runs unapproved.
      return typeof trustedHash === 'string'
        ? [{ ...entry, sourcePath: keySource, trustedHash, enabled: true }]
        : []
    })
  )
  const missing = findMissingCodexHookApprovals(approvals, trustStates)
  const findStale = (states: ReadonlyMap<string, CodexHookTrustState>): string[] =>
    findStaleOrcaApprovals(states, approvals, sourcePaths, [hashes, ...args.knownOrcaHashes], plan)
  const changed = plan.changedLabels.size > 0
  if (!changed && missing.length === 0 && findStale(trustStates).length === 0) {
    return 'unchanged'
  }

  writeManagedScript(material.scriptPath, material.script)
  writeCodexHookApprovalsBeforeEntries(
    tomlPath,
    missing,
    () => {
      if (changed) {
        writeHooks(plan.hooks)
      }
    },
    hooksJsonPath
  )
  try {
    // Why read again: approvals Orca just wrote, or a user's moved one, may sit at a key read stale before.
    removeHookTrustEntries(tomlPath, findStale(readHookTrustEntries(tomlPath)))
  } catch (error) {
    // Why still written: the entry and its approval are in place; a leftover approval matches no hook.
    console.warn('[codex-real-home-hooks] could not drop stale Orca approvals:', error)
  }
  return 'written'
}

/**
 * Codex has not answered: an entry already in place keeps the approval it has,
 * so nothing changes; any other entry gets Orca's own hash until Codex answers.
 */
function keptApprovedHashes(
  plan: SettlePlan,
  hooks: Record<string, HookDefinition[]>,
  trustStates: ReadonlyMap<string, CodexHookTrustState>,
  sourcePaths: readonly string[],
  command: string,
  knownOrcaHashes: readonly CodexHookHashes[]
): CodexHookHashes {
  const approved = findApprovedOrcaHashes(trustStates, hooks, sourcePaths, command, knownOrcaHashes)
  for (const label of plan.changedLabels) {
    delete approved[label]
  }
  return approved
}

/**
 * Approvals Orca left at a slot its entry no longer holds, such as a copy it
 * removed from a user's group. Owned only while they hold a hash Orca writes.
 * Never in an event this run left alone: its entries keep theirs.
 */
function findStaleOrcaApprovals(
  trustStates: ReadonlyMap<string, CodexHookTrustState>,
  approvals: readonly CodexTrustEntry[],
  sourcePaths: readonly string[],
  orcaHashes: readonly CodexHookHashes[],
  plan: SettlePlan
): string[] {
  const wanted = new Set(
    approvals.map((entry) => normalizeHookTrustKeyForLookup(computeTrustKey(entry)))
  )
  return [...trustStates].flatMap(([key, state]) => {
    const parts = parseTrustKey(key)
    return parts &&
      !plan.untouchedLabels.has(parts.eventLabel) &&
      !wanted.has(normalizeHookTrustKeyForLookup(key)) &&
      sourcePaths.some((sourcePath) => codexHookSourcePathsEqual(parts.sourcePath, sourcePath)) &&
      state.trustedHash !== undefined &&
      orcaHashes.some((hashes) => hashes[parts.eventLabel] === state.trustedHash)
      ? [key]
      : []
  })
}

/**
 * The user's explicit opt-out: strips Orca's entry and its approvals from the
 * real ~/.codex, moving the approvals of user hooks whose positions shift.
 * Never throws.
 */
export async function removeRealHomeCodexHookForOptOut(
  codexHashes: readonly CodexHookHashes[] = []
): Promise<'removed' | 'unavailable'> {
  try {
    return await runExclusivelyForCodexTrustConfig(getSystemCodexConfigTomlPath(), async () => {
      const lane = sweepRealHomeCodexHook()
      // Why 'removed' only: an unread or malformed file may still hold the entry,
      // so its approvals and the ledger that proves ownership wait for a later pass.
      if (lane === 'removed') {
        // Why: Codex's own hashes prove Orca's approvals, including ones a sweep with no entry left to remove skips.
        removeSystemManagedHookTrustEntries(
          getSystemCodexHomePath(),
          getRealHomeHookKeySourcePaths(),
          codexHashes
        )
      }
      return lane
    })
  } catch (error) {
    console.warn('[codex-real-home-hooks] opt-out cleanup failed:', error)
    return 'unavailable'
  }
}
