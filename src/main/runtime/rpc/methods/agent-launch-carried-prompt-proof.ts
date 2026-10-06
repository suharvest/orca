/**
 * What became of a prompt an agent's launch command carried, on a host that can see the agent.
 *
 * The prompt is on the agent's command line, so the agent has it the moment it runs: the launched
 * agent itself in front (named on its command line, never any other process: a slow shell startup
 * runs its own), or the agent's own hook turn, is the answer. The pane's shell reporting the launch
 * line finished before either is an exit at startup, before the agent read it. With neither within
 * the budget, the prompt stays handed to the terminal, as on a host that cannot see: a slow read
 * never costs the caller its follow-up.
 */

import type { AgentLaunchPromptDisposal } from '../../../../shared/agent-launch-intent'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { OrcaRuntimeService } from '../../orca-runtime'

type CarriedPromptProofRuntime = Pick<
  OrcaRuntimeService,
  | 'observeTerminalLaunchTurnStart'
  | 'getTerminalPromptRequestBinding'
  | 'readTerminalForegroundVerdict'
  | 'terminalCommandFinishedSince'
>

const RECEIVED: AgentLaunchPromptDisposal = { outcome: 'handed-to-terminal' }
const EXITED: AgentLaunchPromptDisposal = { outcome: 'not-delivered', reason: 'agent-exited' }

/** Long enough for a slow shell to start and run the line; a follow-up waits on it at most this. */
const PROOF_BUDGET_MS = 10_000
/** Each foreground read is one process scan of the pane, so they start often and back off. */
const FIRST_READ_MS = 100
const MAX_READ_MS = 1_000

export async function proveCarriedTerminalAgentLaunchPrompt(args: {
  runtime: CarriedPromptProofRuntime
  handle: string
  agent: TuiAgent
  /** Taken before the spawn: only a hook turn or a finished command after it is this launch's. */
  launchStartedAt: number
  timeoutMs?: number
}): Promise<AgentLaunchPromptDisposal> {
  const timeoutMs = args.timeoutMs ?? PROOF_BUDGET_MS
  const stop = new AbortController()
  try {
    const hookTurn = (async () => {
      const verdict = await args.runtime.observeTerminalLaunchTurnStart(
        args.handle,
        { launchStartedAt: args.launchStartedAt, agent: args.agent },
        timeoutMs,
        stop.signal
      )
      return verdict === 'observed' || verdict === 'permission'
        ? RECEIVED
        : verdict === 'exited'
          ? EXITED
          : null
    })().catch(() => null)
    const launchedAgent = watchLaunch(args, timeoutMs, stop.signal).catch(() => null)
    // Bookkeeping never gates the caller: a read that cannot answer leaves the prompt handed over.
    return (await firstAnswer([hookTurn, launchedAgent])) ?? RECEIVED
  } finally {
    stop.abort()
  }
}

async function watchLaunch(
  args: {
    runtime: CarriedPromptProofRuntime
    handle: string
    agent: TuiAgent
    launchStartedAt: number
  },
  timeoutMs: number,
  signal: AbortSignal
): Promise<AgentLaunchPromptDisposal | null> {
  const deadline = Date.now() + timeoutMs
  const { ptyId } = args.runtime.getTerminalPromptRequestBinding(args.handle)
  let interval = FIRST_READ_MS
  while (!signal.aborted && Date.now() < deadline) {
    const verdict = await args.runtime
      .readTerminalForegroundVerdict(ptyId, args.agent)
      .catch(() => 'unknown' as const)
    if (verdict === 'launched-agent') {
      return RECEIVED
    }
    // The shell's own report, so an agent that lived too briefly to be seen still counts as exited.
    if (args.runtime.terminalCommandFinishedSince(args.handle, args.launchStartedAt)) {
      return EXITED
    }
    await abortableDelay(interval, signal)
    interval = Math.min(interval * 2, MAX_READ_MS)
  }
  return null
}

/** The first answer that is not null, or null once every one has settled without one. */
function firstAnswer<T>(answers: Promise<T | null>[]): Promise<T | null> {
  return new Promise((resolve) => {
    let pending = answers.length
    for (const answer of answers) {
      void answer.then((value) => {
        pending -= 1
        if (value !== null) {
          resolve(value)
        } else if (pending === 0) {
          resolve(null)
        }
      })
    }
  })
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}
