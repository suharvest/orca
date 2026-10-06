import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wrapPosixHookCommand } from '../agent-hooks/installer-utils'
import type * as CodexCommand from '../codex-cli/command'
import type * as TrustDerivation from './codex-hook-trust-derivation'
import type * as RealHomeInstall from './codex-real-home-hook-install'

const mocks = vi.hoisted(() => {
  const held: { holdRealHome: Promise<void> | null } = { holdRealHome: null }
  return {
    ...held,
    homedir: vi.fn<() => string>(),
    codexPath: '',
    probeCodexVersion: vi.fn(),
    deriveCodexHookHashes: vi.fn(),
    realHomeRuns: 0
  }
})

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: mocks.homedir
}))
vi.mock('../codex-cli/command', async (importOriginal) => ({
  ...(await importOriginal<typeof CodexCommand>()),
  resolveCodexCommand: () => mocks.codexPath
}))
vi.mock('./codex-hook-trust-derivation', async (importOriginal) => ({
  ...(await importOriginal<typeof TrustDerivation>()),
  probeCodexVersion: mocks.probeCodexVersion,
  deriveCodexHookHashes: mocks.deriveCodexHookHashes
}))
vi.mock('./codex-real-home-hook-install', async (importOriginal) => {
  const actual = await importOriginal<typeof RealHomeInstall>()
  return {
    ...actual,
    reconcileRealHomeCodexHookEntries: (
      ...args: Parameters<typeof actual.reconcileRealHomeCodexHookEntries>
    ) => {
      mocks.realHomeRuns += 1
      return (mocks.holdRealHome ?? Promise.resolve()).then(() =>
        actual.reconcileRealHomeCodexHookEntries(...args)
      )
    }
  }
})

import {
  _internals,
  reconcileCodexHooks,
  reconcileCodexHooksWithin,
  scheduleCodexHookReconcile,
  startCodexHookReconcile
} from './codex-hook-reconcile'
import { _internals as lookupInternals, startCodexHookHashLookup } from './codex-hook-hash-lookup'
import { readRealHomeHooksFileShapeProblem } from './codex-real-home-hooks-json'
import {
  buildCodexManagedHook,
  CODEX_EVENT_LABEL,
  computeOrcaCodexHookHashes,
  getCodexManagedHookInstallMaterial
} from './codex-hook-definition'
import type { CodexHookHashes } from './codex-hook-trust-derivation'
import { computeTrustKey, readHookTrustEntries } from './config-toml-trust'

// Why this file: the reconcile is the only writer of Orca's entry in ~/.codex,
// and the common call, on every pane spawn and Codex launch, must change nothing.

let root: string
let home: string
let userData: string
let enabled: boolean
let usesRealHome: boolean
let stop: (() => void) | null = null

const CODEX_HASHES: CodexHookHashes = Object.fromEntries(
  Object.values(CODEX_EVENT_LABEL).map((label) => [label, `sha256:codex-${label}`])
)
const codexHome = (): string => join(home, '.codex')
const hooksPath = (): string => join(codexHome(), 'hooks.json')
const tomlPath = (): string => join(codexHome(), 'config.toml')
const command = (): string => getCodexManagedHookInstallMaterial().command

type Hooks = Record<string, { hooks: { type: string; command: string; timeout?: number }[] }[]>

function readHooks(): Hooks {
  return JSON.parse(readFileSync(hooksPath(), 'utf-8')).hooks
}

function writeHooks(hooks: Hooks): void {
  mkdirSync(codexHome(), { recursive: true })
  writeFileSync(hooksPath(), `${JSON.stringify({ hooks }, null, 2)}\n`)
}

function olderBuildStop(): Hooks[string][number] {
  const script = join(home, '.orca', 'agent-hooks', 'codex-hook.sh')
  return {
    hooks: [
      buildCodexManagedHook(
        process.platform === 'win32' ? script : wrapPosixHookCommand(script),
        'Stop'
      )
    ]
  }
}

function snapshot(dir: string): Map<string, { bytes: string; mtimeMs: number }> {
  return new Map(
    existsSync(dir)
      ? readdirSync(dir).map((name) => {
          const path = join(dir, name)
          return [name, { bytes: readFileSync(path, 'utf-8'), mtimeMs: statSync(path).mtimeMs }]
        })
      : []
  )
}

async function start(): Promise<void> {
  startCodexHookHashLookup({ pathReady: Promise.resolve(), isEnabled: () => false })
  stop = startCodexHookReconcile({
    isEnabled: () => enabled,
    usesRealHome: () => usesRealHome,
    resolveLaunchHome: () => (usesRealHome ? null : join(userData, 'codex-runtime-home')),
    pathReady: Promise.resolve()
  })
  await _internals.settledForTesting()
}

async function settleSpawn(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  await _internals.settledForTesting()
}

beforeEach(() => {
  // Why realpath: a symlinked temp dir (macOS /var) would give ~/.codex a second key spelling.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'orca-codex-reconcile-')))
  home = join(root, 'home')
  userData = join(root, 'user-data')
  mkdirSync(home)
  mkdirSync(userData)
  vi.stubEnv('ORCA_USER_DATA_PATH', userData)
  vi.stubEnv('CODEX_HOME', '')
  mocks.homedir.mockReturnValue(home)
  mocks.codexPath = join(userData, 'codex')
  writeFileSync(mocks.codexPath, 'codex 0.160.1')
  mocks.probeCodexVersion.mockResolvedValue('codex-cli 0.160.1')
  mocks.deriveCodexHookHashes.mockResolvedValue({
    kind: 'hashes',
    codexVersion: 'codex-cli 0.160.1',
    hashes: CODEX_HASHES
  })
  mocks.realHomeRuns = 0
  mocks.holdRealHome = null
  enabled = true
  usesRealHome = true
  _internals.resetForTesting()
  lookupInternals.resetForTesting()
})

afterEach(() => {
  stop?.()
  stop = null
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('reconcileCodexHooks', () => {
  it('writes the entry last in every listed event, approved, at app start', async () => {
    writeHooks({ Stop: [{ hooks: [{ type: 'command', command: 'user-stop.sh' }] }] })

    await start()

    expect(readHooks().Stop!.map((group) => group.hooks[0]!.command)).toEqual([
      'user-stop.sh',
      command()
    ])
    const key = computeTrustKey({
      sourcePath: hooksPath(),
      eventLabel: 'stop',
      groupIndex: 1,
      handlerIndex: 0,
      command: command()
    })
    expect(readHookTrustEntries(tomlPath()).get(key)).toEqual({
      trustedHash: CODEX_HASHES.stop,
      enabled: true
    })
  })

  it('writes nothing and spawns nothing across many concurrent launches when nothing changed', async () => {
    await start()
    const before = snapshot(codexHome())
    const memoBefore = snapshot(userData)
    vi.clearAllMocks()

    await Promise.all(
      Array.from({ length: 20 }, (_, index) => {
        scheduleCodexHookReconcile()
        return index % 2 === 0
          ? reconcileCodexHooksWithin(3_000, { realHomeLaunch: true })
          : reconcileCodexHooks()
      })
    )
    await settleSpawn()

    expect(snapshot(codexHome())).toEqual(before)
    expect(snapshot(userData)).toEqual(memoBefore)
    expect(mocks.probeCodexVersion).not.toHaveBeenCalled()
    expect(mocks.deriveCodexHookHashes).not.toHaveBeenCalled()
  })

  it('runs again once for every call made while one runs', async () => {
    await start()
    mocks.realHomeRuns = 0
    let release!: () => void
    mocks.holdRealHome = new Promise((resolve) => {
      release = resolve
    })
    const first = reconcileCodexHooks()
    await vi.waitFor(() => expect(mocks.realHomeRuns).toBe(1))

    const later = [2, 3, 4, 5].map(() => reconcileCodexHooks())
    mocks.holdRealHome = null
    release()
    await Promise.all([first, ...later])

    expect(mocks.realHomeRuns).toBe(2)
  })

  it('runs once for one spawn, however many env builders it goes through', async () => {
    await start()
    mocks.realHomeRuns = 0

    scheduleCodexHookReconcile()
    scheduleCodexHookReconcile()
    scheduleCodexHookReconcile()
    await settleSpawn()

    expect(mocks.realHomeRuns).toBe(1)
  })

  it('lets a spawn ride a reconcile already running, which reads the files after it', async () => {
    await start()
    mocks.realHomeRuns = 0
    let release!: () => void
    mocks.holdRealHome = new Promise((resolve) => {
      release = resolve
    })
    const running = reconcileCodexHooks()
    await vi.waitFor(() => expect(mocks.realHomeRuns).toBe(1))

    scheduleCodexHookReconcile()
    await new Promise((resolve) => setImmediate(resolve))
    mocks.holdRealHome = null
    release()
    await running
    await settleSpawn()

    expect(mocks.realHomeRuns).toBe(1)
  })

  it("leaves an older build's entry alone on a pane spawn, and converts it at app start", async () => {
    enabled = false
    await start()
    enabled = true
    writeHooks({ Stop: [olderBuildStop()] })

    scheduleCodexHookReconcile()
    await settleSpawn()
    expect(readHooks().Stop).toEqual([olderBuildStop()])

    await reconcileCodexHooks({ convertOlderForms: true })
    expect(readHooks().Stop).toEqual([{ hooks: [buildCodexManagedHook(command(), 'Stop')] }])
  })

  it('drops an app-start conversion it could not run, rather than carry it to a spawn', async () => {
    writeHooks({ Stop: [olderBuildStop()] })
    enabled = false
    await start()

    enabled = true
    scheduleCodexHookReconcile()
    await settleSpawn()

    expect(readHooks().Stop).toEqual([olderBuildStop()])
    expect(readHooks().SessionStart).toEqual([
      { hooks: [buildCodexManagedHook(command(), 'SessionStart')] }
    ])
  })

  it('leaves ~/.codex untouched while a managed account or custom CODEX_HOME is selected', async () => {
    usesRealHome = false

    await start()
    scheduleCodexHookReconcile()
    await settleSpawn()

    expect(existsSync(codexHome())).toBe(false)
  })

  it('still writes for a launch that runs on ~/.codex whatever the selection', async () => {
    usesRealHome = false
    await start()

    await reconcileCodexHooksWithin(3_000, { realHomeLaunch: true })

    expect(Object.keys(readHooks())).toContain('Stop')
  })

  it('writes nothing for a Codex without hooks/list', async () => {
    mocks.deriveCodexHookHashes.mockResolvedValue({
      kind: 'refused',
      codexVersion: 'codex-cli 0.120.0',
      failure: 'Codex 0.120.0 is too old for Orca status; update Codex'
    })

    await start()

    expect(existsSync(codexHome())).toBe(false)
  })

  it("approves with Orca's own hash while Codex cannot be found", async () => {
    mocks.codexPath = join(userData, 'missing-codex')

    await start()

    const key = computeTrustKey({
      sourcePath: hooksPath(),
      eventLabel: 'stop',
      groupIndex: 0,
      handlerIndex: 0,
      command: command()
    })
    expect(readHookTrustEntries(tomlPath()).get(key)?.trustedHash).toBe(
      computeOrcaCodexHookHashes().stop
    )
  })

  it('never throws, and does nothing outside the app', async () => {
    writeHooks({ Stop: [] })
    await expect(reconcileCodexHooks({ convertOlderForms: true })).resolves.toBeUndefined()
    expect(readHooks()).toEqual({ Stop: [] })
  })
})

describe('the routing gate', () => {
  it.each([
    ['an unparseable file', '{ not json'],
    ['unknown top-level fields', JSON.stringify({ hooks: {}, _managed: true })],
    ['a hooks value that is not an object', JSON.stringify({ hooks: [] })]
  ])('closes for %s, and reopens once it is fixed', (_case, content) => {
    mkdirSync(codexHome(), { recursive: true })
    writeFileSync(hooksPath(), content)

    expect(readRealHomeHooksFileShapeProblem()).toBe(
      `${hooksPath()} is not a hooks file Orca can add to`
    )

    writeHooks({})
    expect(readRealHomeHooksFileShapeProblem()).toBeNull()
  })

  it('stays open with no hooks.json at all', () => {
    expect(readRealHomeHooksFileShapeProblem()).toBeNull()
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'stays open for an unreadable hooks.json',
    () => {
      writeHooks({})
      chmodSync(hooksPath(), 0o000)

      expect(readRealHomeHooksFileShapeProblem()).toBeNull()
    }
  )

  it('stays open after a write Orca could not make', async () => {
    writeHooks({})
    writeFileSync(tomlPath(), 'model = "m"\nhooks = { state = {} }\n')
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await start()

    expect(readHooks()).toEqual({})
    expect(readRealHomeHooksFileShapeProblem()).toBeNull()
  })
})
