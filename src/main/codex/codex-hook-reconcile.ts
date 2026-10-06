import { withTimeout } from '../../shared/promise-timeout-fallback'
import { computeOrcaCodexHookHashes } from './codex-hook-definition'
import {
  CODEX_HOOK_LAUNCH_WAIT_MS,
  readEveryKnownCodexHookHashes,
  resolveCodexHookAnswer,
  startCodexHookHashLookup
} from './codex-hook-hash-lookup'
import type { CodexHookAnswer } from './codex-hook-trust-derivation'
import { reconcileRealHomeCodexHookEntries } from './codex-real-home-hook-install'

// Keeps Orca's Codex hook entry in ~/.codex true to the setting and the codex in
// use; a call that finds nothing changed reads two files and spawns nothing.

type ReconcileConfig = {
  isEnabled: () => boolean
  /** Whether launches run Codex on ~/.codex: system default selected, no custom CODEX_HOME. */
  usesRealHome: () => boolean
  /** The CODEX_HOME the next native pane gets, null for ~/.codex; may throw while it is unknown. */
  resolveLaunchHome: () => string | null
}

type ReconcileRequest = {
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

// Why short: a pending lookup must leave room in a launch's 3 s wait for the stopgap write.
const ANSWER_WAIT_MS = 500

/**
 * App start, main process only: lets Orca ask Codex for its hook hashes, and
 * reconciles ~/.codex, both once the shell PATH is hydrated.
 */
export function startCodexHooks({
  pathReady: hydrating,
  ...appConfig
}: ReconcileConfig & { pathReady: Promise<unknown> }): void {
  const pathReady = hydrating.catch(() => {})
  startCodexHookHashLookup(pathReady)
  config = appConfig
  // Why ask now when hooks are on: the first managed launch then usually finds the answer ready.
  void pathReady.then(() => (appConfig.isEnabled() ? resolveCodexHookAnswer() : undefined))
  // Why held as the running reconcile: launches before PATH is hydrated wait on it, not run early.
  void reconcileAfter(pathReady, { convertOlderForms: true })
}

/** Never throws; a call while one runs makes that one run again, so no change is missed. */
export function reconcileCodexHooks(request: ReconcileRequest = {}): Promise<void> {
  return reconcileAfter(Promise.resolve(), request)
}

function reconcileAfter(ready: Promise<unknown>, request: ReconcileRequest): Promise<void> {
  convertRequested ||= request.convertOlderForms === true
  realHomeLaunchRequested ||= request.realHomeLaunch === true
  if (running) {
    rerun = true
    return running
  }
  running = ready.then(runUntilSettled)
  return running
}

/** A native pane spawned: reconciles after the spawn, in the app only. */
export function scheduleCodexHookReconcile(): void {
  // Why not join a running one: it reads the files after this spawn anyway (so a spawn's several env builders run one).
  if (config && !running) {
    void reconcileCodexHooks()
  }
}

/** A Codex launch on ~/.codex: a reconcile, waited for briefly, so the launch goes ahead rather than wait longer. */
export function reconcileCodexHooksForLaunch(): Promise<void> {
  return withTimeout(
    reconcileCodexHooks({ realHomeLaunch: true }),
    CODEX_HOOK_LAUNCH_WAIT_MS,
    undefined
  )
}

/**
 * The home status reports on: the CODEX_HOME the next native pane gets in the
 * app, or ~/.codex in a process that does not know the selection (the CLI's).
 */
export function resolveCodexHookStatusHome():
  | { kind: 'real' }
  | { kind: 'managed'; path: string }
  | { kind: 'unknown' } {
  if (!config) {
    return { kind: 'real' }
  }
  try {
    const path = config.resolveLaunchHome()
    return path === null ? { kind: 'real' } : { kind: 'managed', path }
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

async function reconcileOnce(request: Required<ReconcileRequest>): Promise<void> {
  const current = config
  if (!current?.isEnabled() || !(request.realHomeLaunch || current.usesRealHome())) {
    return
  }
  const lookup = resolveCodexHookAnswer()
  const answer = await withTimeout<CodexHookAnswer | null>(lookup, ANSWER_WAIT_MS, null)
  if (!answer) {
    // Why: the stopgap below goes in now, as main's did; Codex's hash replaces it once it answers.
    void lookup.then(() => reconcileCodexHooks({ realHomeLaunch: request.realHomeLaunch }))
  }
  if (answer?.kind === 'refused') {
    // Why nothing: this Codex cannot approve Orca's entry (no hooks/list); status says to update it.
    return
  }
  await reconcileRealHomeCodexHookEntries({
    hashes: answer?.kind === 'hashes' ? answer.hashes : null,
    knownOrcaHashes: [computeOrcaCodexHookHashes(), ...readEveryKnownCodexHookHashes()],
    isEnabled: () => config?.isEnabled() === true,
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
  },
  /** Settles once no reconcile runs. */
  async settledForTesting(): Promise<void> {
    while (running) {
      await running
    }
  }
}
