import { getOrcaUserDataPath } from './codex-home-paths'
import { computeOrcaCodexHookHashes } from './codex-hook-definition'
import { readEveryKnownCodexHookHashes, resolveCodexHookHashes } from './codex-hook-hash-lookup'
import { reconcileRealHomeCodexHookEntries } from './codex-real-home-hook-install'

/**
 * Keeps Orca's Codex hook entry in ~/.codex true to the setting and to the
 * codex binary in use, writing only on a change. One never-throwing function,
 * called at app start, on the setting turning on, on each native pane spawn,
 * and on Orca-launched Codex launches and resumes. A call that finds the entry,
 * its approval and the binary unchanged reads two files and spawns nothing.
 */

type ReconcileConfig = {
  isEnabled: () => boolean
  /** Whether launches run Codex on ~/.codex: system default selected, no custom CODEX_HOME. */
  usesRealHome: () => boolean
  /** The CODEX_HOME the next native pane gets, null for ~/.codex; may throw while it is unknown. */
  resolveLaunchHome: () => string | null
}

type ReconcileRequest = {
  after?: Promise<unknown>
  /** App start and the setting turning on: only they replace an older build's entry. */
  convertOlderForms?: boolean
  /** A launch that runs on ~/.codex whatever the selection, such as a resume of a session there. */
  realHomeLaunch?: boolean
}

// Why null outside the app: the CLI's process leaves ~/.codex to the app's next reconcile.
let config: ReconcileConfig | null = null
let running: Promise<void> | null = null
let rerun = false
// Why flags, not counters: a request the next run cannot serve (hooks off, ~/.codex not used) is dropped.
let convertRequested = false
let realHomeLaunchRequested = false
let spawnReconcileScheduled = false

/** App start, main process only: the settings readers, and the first reconcile once PATH is hydrated. */
export function startCodexHookReconcile(
  options: ReconcileConfig & { pathReady: Promise<unknown> }
): () => void {
  config = {
    isEnabled: options.isEnabled,
    usesRealHome: options.usesRealHome,
    resolveLaunchHome: options.resolveLaunchHome
  }
  void reconcileCodexHooks({ after: options.pathReady, convertOlderForms: true })
  return () => {
    config = null
  }
}

/** Never throws; a call while one runs makes that one run again, so no change is missed. */
export function reconcileCodexHooks(request: ReconcileRequest = {}): Promise<void> {
  convertRequested ||= request.convertOlderForms === true
  realHomeLaunchRequested ||= request.realHomeLaunch === true
  if (running) {
    rerun = true
    return running
  }
  const after = request.after ?? Promise.resolve()
  running = after.catch(() => {}).then(runUntilSettled)
  return running
}

/** A native pane spawned: reconciles on the next tick, off the spawn's path, in the app only. */
export function scheduleCodexHookReconcile(): void {
  // Why once: one spawn builds its env through several builders.
  if (config && !spawnReconcileScheduled) {
    spawnReconcileScheduled = true
    setImmediate(() => {
      spawnReconcileScheduled = false
      // Why not join a running one: it reads the files after this spawn anyway, and a rerun would repeat it.
      if (!running) {
        void reconcileCodexHooks()
      }
    })
  }
}

/** A reconcile, waited for at most `timeoutMs`: a Codex launch goes ahead rather than wait longer. */
export async function reconcileCodexHooksWithin(
  timeoutMs: number,
  request: Omit<ReconcileRequest, 'after'> = {}
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    reconcileCodexHooks(request),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })
  ])
  clearTimeout(timer)
}

/**
 * The home status reports on: the CODEX_HOME the next native pane gets in the
 * app, or ~/.codex in a process that does not know the selection (the CLI's).
 */
export function resolveCodexHookStatusHome():
  | { kind: 'real' }
  | { kind: 'managed'; path: string; realHomeSelected: boolean }
  | { kind: 'unknown' } {
  if (!config) {
    return { kind: 'real' }
  }
  try {
    const path = config.resolveLaunchHome()
    return path === null
      ? { kind: 'real' }
      : { kind: 'managed', path, realHomeSelected: config.usesRealHome() }
  } catch {
    return { kind: 'unknown' }
  }
}

async function runUntilSettled(): Promise<void> {
  for (;;) {
    rerun = false
    const request = { convertOlderForms: convertRequested, realHomeLaunch: realHomeLaunchRequested }
    convertRequested = false
    realHomeLaunchRequested = false
    try {
      await reconcileOnce(request)
    } catch (error) {
      console.warn('[codex-hook-reconcile] Codex hook reconcile failed:', error)
    }
    // Why decided and cleared in one step: a call in between would mark a finished run.
    if (!rerun) {
      running = null
      return
    }
  }
}

async function reconcileOnce(request: {
  convertOlderForms: boolean
  realHomeLaunch: boolean
}): Promise<void> {
  const current = config
  if (!current?.isEnabled() || !(request.realHomeLaunch || current.usesRealHome())) {
    return
  }
  const answer = await resolveCodexHookHashes()
  if (answer.kind === 'refused') {
    // Why nothing: this Codex cannot approve Orca's entry (no hooks/list); status says to update it.
    return
  }
  const computedHashes = computeOrcaCodexHookHashes()
  await reconcileRealHomeCodexHookEntries({
    hashes: answer.kind === 'hashes' ? answer.hashes : null,
    knownOrcaHashes: [computedHashes, ...readEveryKnownCodexHookHashes()],
    computedHashes,
    isEnabled: () => config?.isEnabled() === true,
    userDataPath: getOrcaUserDataPath(),
    convertOlderForms: request.convertOlderForms
  })
}

export const _internals = {
  resetForTesting(): void {
    config = null
    running = null
    rerun = false
    convertRequested = false
    realHomeLaunchRequested = false
    spawnReconcileScheduled = false
  },
  /** Settles once no reconcile runs. */
  async settledForTesting(): Promise<void> {
    while (running) {
      await running
    }
  }
}
