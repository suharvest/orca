import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as InstallerUtils from '../agent-hooks/installer-utils'
import type * as RealHomeHooksJson from './codex-real-home-hooks-json'
import { wrapPosixHookCommand, type HookDefinition } from '../agent-hooks/installer-utils'

const mocks = vi.hoisted(() => {
  const state: { beforeHooksJsonGuard: (() => void) | null; hooksJsonWrites: number } = {
    beforeHooksJsonGuard: null,
    hooksJsonWrites: 0
  }
  return { ...state, homedir: vi.fn<() => string>() }
})

vi.mock('node:os', async () => ({
  ...(await vi.importActual<typeof NodeOs>('node:os')),
  homedir: mocks.homedir
}))
vi.mock('../agent-hooks/installer-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof InstallerUtils>()
  return {
    ...actual,
    writeHooksJson: (...args: Parameters<typeof actual.writeHooksJson>) => {
      mocks.hooksJsonWrites += 1
      return actual.writeHooksJson(...args)
    }
  }
})

vi.mock('./codex-real-home-hooks-json', async (importOriginal) => {
  const actual = await importOriginal<typeof RealHomeHooksJson>()
  return {
    ...actual,
    // Why here: the install's last step before its "changed since read" guard.
    backupRealHomeHooksJsonOnce: (
      ...args: Parameters<typeof actual.backupRealHomeHooksJsonOnce>
    ) => {
      mocks.beforeHooksJsonGuard?.()
      return actual.backupRealHomeHooksJsonOnce(...args)
    }
  }
})

import { reconcileRealHomeCodexHookEntries } from './codex-real-home-hook-install'
import {
  buildCodexManagedHook,
  CODEX_EVENT_LABEL,
  computeOrcaCodexHookHashes,
  getCodexManagedHookInstallMaterial
} from './codex-hook-definition'
import { createCodexHookTrustEntry } from './codex-hook-identity'
import type { CodexHookHashes } from './codex-hook-trust-derivation'
import {
  computeTrustKey,
  readHookTrustEntries,
  upsertHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'

// Why this file: every Orca instance and build on one HOME shares ~/.codex, and
// the user's own hooks and approvals live beside Orca's entry there.

type HooksFile = { hooks: Record<string, HookDefinition[]> }

const USER_A: HookDefinition = { hooks: [{ type: 'command', command: 'user-a.sh' }] }
const USER_B: HookDefinition = { hooks: [{ type: 'command', command: 'user-b.sh' }] }
const USER_C: HookDefinition = { hooks: [{ type: 'command', command: 'user-c.sh' }] }
const CODEX_HASHES: Record<string, string> = Object.fromEntries(
  Object.values(CODEX_EVENT_LABEL).map((label) => [label, `sha256:codex-${label}`])
)

let root: string
let home: string
let userData: string

const hooksPath = (): string => join(home, '.codex', 'hooks.json')
const configPath = (): string => join(home, '.codex', 'config.toml')
const frozen = (): string => getCodexManagedHookInstallMaterial().command
const orcaGroup = (command: string = frozen()): HookDefinition => ({
  hooks: [buildCodexManagedHook(command, 'Stop')]
})

function olderBuildCommand(): string {
  const script = join(home, '.orca', 'agent-hooks', 'codex-hook.sh')
  return process.platform === 'win32' ? script : wrapPosixHookCommand(script)
}

function writeHooks(file: unknown): string {
  mkdirSync(join(home, '.codex'), { recursive: true })
  const raw = `${JSON.stringify(file, null, 2)}\n`
  writeFileSync(hooksPath(), raw)
  return raw
}

function readHooks(): HooksFile {
  return JSON.parse(readFileSync(hooksPath(), 'utf-8'))
}

function identity(path: string): { raw: string; ino: number; mtimeMs: number } {
  const stat = statSync(path)
  return { raw: readFileSync(path, 'utf-8'), ino: stat.ino, mtimeMs: stat.mtimeMs }
}

async function reconcile(
  options: {
    hashes?: CodexHookHashes | null
    userDataPath?: string
    convertOlderForms?: boolean
    knownOrcaHashes?: CodexHookHashes[]
  } = {}
): Promise<string> {
  const hashes = options.hashes === undefined ? CODEX_HASHES : options.hashes
  return (
    await reconcileRealHomeCodexHookEntries({
      hashes,
      knownOrcaHashes: options.knownOrcaHashes ?? [computeOrcaCodexHookHashes()],
      computedHashes: computeOrcaCodexHookHashes(),
      isEnabled: () => true,
      userDataPath: options.userDataPath ?? userData,
      convertOlderForms: options.convertOlderForms ?? true
    })
  ).outcome
}

function stopEntryAt(groupIndex: number, definition: HookDefinition): CodexTrustEntry {
  return createCodexHookTrustEntry(
    hooksPath(),
    'Stop',
    groupIndex,
    0,
    definition,
    definition.hooks![0]!
  )!
}

function trustAt(entry: CodexTrustEntry): { trustedHash?: string; enabled?: boolean } | undefined {
  return readHookTrustEntries(configPath()).get(computeTrustKey(entry))
}

function expectOrcaApprovedAt(
  groupIndex: number,
  hash: string | null | undefined = CODEX_HASHES.stop
): void {
  expect(trustAt(stopEntryAt(groupIndex, orcaGroup()))).toEqual({
    trustedHash: hash,
    enabled: true
  })
}

beforeEach(() => {
  // Why realpath: a symlinked temp dir (macOS /var) would give ~/.codex a second key spelling.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'orca-real-home-entries-')))
  home = join(root, 'home')
  userData = join(root, 'user-data')
  mkdirSync(home)
  mkdirSync(userData)
  mocks.homedir.mockReturnValue(home)
  mocks.beforeHooksJsonGuard = null
  mocks.hooksJsonWrites = 0
  vi.stubEnv('CODEX_HOME', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe('reconcileRealHomeCodexHookEntries', () => {
  it("converts an older build's entry once, in its slot, with one pristine backup", async () => {
    const olderRaw = writeHooks({ hooks: { Stop: [USER_A, orcaGroup(olderBuildCommand())] } })

    expect(await reconcile()).toBe('written')
    const converted = identity(hooksPath())
    expect(readHooks().hooks.Stop).toEqual([USER_A, orcaGroup()])
    expectOrcaApprovedAt(1)
    expect(
      readFileSync(join(userData, 'codex-real-home-hooks', 'hooks.json.pre-orca'), 'utf-8')
    ).toBe(olderRaw)

    const otherInstance = join(root, 'second-user-data')
    expect(await reconcile({ userDataPath: otherInstance })).toBe('unchanged')
    expect(identity(hooksPath())).toEqual(converted)
  })

  it("writes zero bytes beside an older build's entries on a launch", async () => {
    const { events } = getCodexManagedHookInstallMaterial()
    writeHooks({
      hooks: Object.fromEntries(
        events.map((event) => [
          event,
          [{ hooks: [buildCodexManagedHook(olderBuildCommand(), event)] }]
        ])
      )
    })
    const before = identity(hooksPath())

    expect(await reconcile({ convertOlderForms: false })).toBe('unchanged')

    expect(identity(hooksPath())).toEqual(before)
    expect(existsSync(configPath())).toBe(false)
  })

  it("leaves an older build's event alone on a launch, and adds Orca's entry to the rest", async () => {
    writeHooks({ hooks: { Stop: [USER_A, orcaGroup(olderBuildCommand())] } })

    expect(await reconcile({ convertOlderForms: false })).toBe('written')

    expect(readHooks().hooks.Stop).toEqual([USER_A, orcaGroup(olderBuildCommand())])
    expect(readHooks().hooks.SessionStart).toEqual([
      { hooks: [buildCodexManagedHook(frozen(), 'SessionStart')] }
    ])
    expect(trustAt(stopEntryAt(1, orcaGroup()))).toBeUndefined()
  })

  it('never rewrites a newer build form or appends beside it', async () => {
    const newer = `: orca-agent-hook-form=2; /bin/sh "\${HOME-}/.orca/agent-hooks/codex-hook.sh"`
    writeHooks({ hooks: { Stop: [orcaGroup(newer)] } })

    await reconcile()

    expect(readHooks().hooks.Stop).toEqual([orcaGroup(newer)])
  })

  it('keeps Orca entries in events this build does not subscribe to', async () => {
    const otherEvent = [orcaGroup()]
    writeHooks({ hooks: { PreCompact: otherEvent } })

    expect(await reconcile()).toBe('written')

    expect(readHooks().hooks.PreCompact).toEqual(otherEvent)
  })

  it('adds an entry only in events Codex lists', async () => {
    writeHooks({ hooks: {} })

    await reconcile({ hashes: { stop: 'sha256:codex-stop' } })

    expect(Object.keys(readHooks().hooks)).toEqual(['Stop'])
  })

  it('keeps one copy, alone and last, moving the approvals of user hooks that shift', async () => {
    writeHooks({ hooks: { Stop: [USER_A, orcaGroup(), USER_B, orcaGroup(), USER_C, orcaGroup()] } })
    upsertHookTrustEntries(configPath(), [
      { ...stopEntryAt(2, USER_B), trustedHash: 'sha256:user-b' },
      { ...stopEntryAt(4, USER_C), trustedHash: 'sha256:user-c' },
      { ...stopEntryAt(3, orcaGroup()), trustedHash: CODEX_HASHES.stop, enabled: true }
    ])

    expect(await reconcile()).toBe('written')

    expect(readHooks().hooks.Stop).toEqual([USER_A, orcaGroup(), USER_B, USER_C])
    expectOrcaApprovedAt(1)
    expect(trustAt(stopEntryAt(2, USER_B))?.trustedHash).toBe('sha256:user-b')
    expect(trustAt(stopEntryAt(3, USER_C))?.trustedHash).toBe('sha256:user-c')
    expect(trustAt(stopEntryAt(4, USER_C))).toBeUndefined()
    expect(await reconcile()).toBe('unchanged')
  })

  it("moves Orca's handler out of a user's matcher group, with the shifted user approvals", async () => {
    const userGroup: HookDefinition = {
      matcher: 'Bash',
      hooks: [
        buildCodexManagedHook(frozen(), 'PreToolUse'),
        { type: 'command', command: 'lint.sh' }
      ]
    }
    writeHooks({ hooks: { PreToolUse: [userGroup] } })
    const lintAt = (handlerIndex: number): CodexTrustEntry =>
      createCodexHookTrustEntry(hooksPath(), 'PreToolUse', 0, handlerIndex, userGroup, {
        type: 'command',
        command: 'lint.sh'
      })!
    upsertHookTrustEntries(configPath(), [{ ...lintAt(1), trustedHash: 'sha256:lint' }])

    expect(await reconcile()).toBe('written')

    const after = readHooks().hooks.PreToolUse!
    expect(after).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'lint.sh' }] },
      { hooks: [buildCodexManagedHook(frozen(), 'PreToolUse')] }
    ])
    expect(trustAt(lintAt(0))?.trustedHash).toBe('sha256:lint')
    expect(trustAt(lintAt(1))).toBeUndefined()
    const orca = createCodexHookTrustEntry(
      hooksPath(),
      'PreToolUse',
      1,
      0,
      after[1]!,
      after[1]!.hooks![0]!
    )!
    expect(trustAt(orca)).toEqual({ trustedHash: CODEX_HASHES.pre_tool_use, enabled: true })
  })

  it('rewrites an edited entry in place and approves what it wrote', async () => {
    const edited: HookDefinition = {
      hooks: [{ ...buildCodexManagedHook(frozen(), 'Stop'), timeout: 99 }]
    }
    writeHooks({ hooks: { Stop: [edited, USER_A] } })
    upsertHookTrustEntries(configPath(), [{ ...stopEntryAt(0, edited), trustedHash: 'sha256:old' }])

    expect(await reconcile()).toBe('written')

    expect(readHooks().hooks.Stop).toEqual([orcaGroup(), USER_A])
    expectOrcaApprovedAt(0)
  })

  it("re-approves after a user hook is inserted ahead, keeping the user's approvals", async () => {
    writeHooks({ hooks: { Stop: [USER_A] } })
    await reconcile()
    writeHooks({ hooks: { ...readHooks().hooks, Stop: [USER_B, ...readHooks().hooks.Stop!] } })
    upsertHookTrustEntries(configPath(), [{ ...stopEntryAt(0, USER_B), trustedHash: 'sha256:b' }])
    mocks.hooksJsonWrites = 0

    expect(await reconcile()).toBe('written')

    expect(mocks.hooksJsonWrites).toBe(0)
    expectOrcaApprovedAt(2)
    // Why gone: Orca's approval at the slot it left now names a user hook.
    expect(trustAt(stopEntryAt(1, orcaGroup()))).toBeUndefined()
    expect(trustAt(stopEntryAt(0, USER_B))?.trustedHash).toBe('sha256:b')
    expect(await reconcile()).toBe('unchanged')
  })

  it("rewrites only the approval when Codex's hash changes", async () => {
    writeHooks({ hooks: { Stop: [USER_A] } })
    await reconcile()
    const hooksBefore = identity(hooksPath())
    const updated = { ...CODEX_HASHES, stop: 'sha256:codex-next-stop' }

    expect(await reconcile({ hashes: updated })).toBe('written')

    expect(identity(hooksPath())).toEqual(hooksBefore)
    expectOrcaApprovedAt(1, 'sha256:codex-next-stop')
    expect(await reconcile({ hashes: updated })).toBe('unchanged')
  })

  it('turns an approval a /hooks toggle disabled back on, once', async () => {
    writeHooks({ hooks: { Stop: [USER_A] } })
    await reconcile()
    upsertHookTrustEntries(configPath(), [
      { ...stopEntryAt(1, orcaGroup()), trustedHash: CODEX_HASHES.stop, enabled: false }
    ])

    expect(await reconcile()).toBe('written')

    expectOrcaApprovedAt(1)
    expect(await reconcile()).toBe('unchanged')
  })

  it("keeps user hooks' positions and approvals while appending Orca's entry", async () => {
    writeHooks({ hooks: { Stop: [USER_A, USER_B] } })
    upsertHookTrustEntries(configPath(), [
      { ...stopEntryAt(1, USER_B), trustedHash: 'sha256:user' }
    ])
    const userToml = readFileSync(configPath(), 'utf-8')

    await reconcile()

    expect(readHooks().hooks.Stop).toEqual([USER_A, USER_B, orcaGroup()])
    // Why a prefix: Orca's approval blocks are only appended after the user's bytes.
    expect(readFileSync(configPath(), 'utf-8').startsWith(userToml)).toBe(true)
    expect(trustAt(stopEntryAt(1, USER_B))?.trustedHash).toBe('sha256:user')
  })

  it('reads again and retries once when the user saves hooks.json mid-write', async () => {
    writeHooks({ hooks: { Stop: [USER_A] } })
    mocks.beforeHooksJsonGuard = () => {
      mocks.beforeHooksJsonGuard = null
      writeHooks({ hooks: { Stop: [USER_A, USER_B] } })
    }

    expect(await reconcile()).toBe('written')

    expect(readHooks().hooks.Stop).toEqual([USER_A, USER_B, orcaGroup()])
    expectOrcaApprovedAt(2)
    expect(trustAt(stopEntryAt(1, orcaGroup()))).toBeUndefined()
  })

  it.each([
    ['unknown top-level fields Codex cannot load', { hooks: {}, _managed: true }],
    ['an unparseable file', '{ not json']
  ])('leaves %s untouched and approves nothing', async (_case, content) => {
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(hooksPath(), typeof content === 'string' ? content : JSON.stringify(content))
    const before = identity(hooksPath())

    expect(await reconcile()).toBe('unavailable')

    expect(identity(hooksPath())).toEqual(before)
    expect(existsSync(configPath())).toBe(false)
  })

  it('writes nothing when config.toml keeps its approvals inline', async () => {
    const original = writeHooks({ hooks: { Stop: [USER_A] } })
    const inline = 'model = "m"\nhooks = { state = {} }\n'
    writeFileSync(configPath(), inline)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await reconcileRealHomeCodexHookEntries({
      hashes: CODEX_HASHES,
      knownOrcaHashes: [],
      computedHashes: computeOrcaCodexHookHashes(),
      isEnabled: () => true,
      userDataPath: userData,
      convertOlderForms: true
    })

    expect(result).toEqual({
      outcome: 'unavailable',
      reason: `${configPath()} keeps hook approvals inline, so Orca cannot add its own there`
    })
    expect(readFileSync(hooksPath(), 'utf-8')).toBe(original)
    expect(readFileSync(configPath(), 'utf-8')).toBe(inline)
  })

  it('keeps the original bytes, and takes the approvals back, when the pristine backup fails', async () => {
    const original = writeHooks({ hooks: { Stop: [USER_A] } })
    writeFileSync(join(userData, 'codex-real-home-hooks'), 'blocks the backup folder')
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(await reconcile()).toBe('unavailable')

    expect(readFileSync(hooksPath(), 'utf-8')).toBe(original)
    expect(readHookTrustEntries(configPath()).size).toBe(0)
  })

  it.skipIf(process.platform === 'win32')(
    'updates a symlinked hooks.json in place, keeping its permissions',
    async () => {
      const target = join(home, 'dotfiles', 'hooks.json')
      mkdirSync(join(home, 'dotfiles'), { recursive: true })
      mkdirSync(join(home, '.codex'), { recursive: true })
      writeFileSync(target, `${JSON.stringify({ hooks: { Stop: [USER_A] } }, null, 2)}\n`)
      chmodSync(target, 0o600)
      symlinkSync(target, hooksPath())

      expect(await reconcile()).toBe('written')

      expect(lstatSync(hooksPath()).isSymbolicLink()).toBe(true)
      expect(JSON.parse(readFileSync(target, 'utf-8')).hooks.Stop).toHaveLength(2)
      expect(statSync(target).mode & 0o777).toBe(0o600)
    }
  )
})

describe('until Codex answers', () => {
  it("keeps an entry's existing approval, writing nothing", async () => {
    writeHooks({ hooks: { Stop: [USER_A] } })
    await reconcile()
    const before = { hooks: identity(hooksPath()), toml: identity(configPath()) }

    expect(await reconcile({ hashes: null })).toBe('unchanged')

    expect({ hooks: identity(hooksPath()), toml: identity(configPath()) }).toEqual(before)
  })

  it("approves a new entry with Orca's own hash, which Codex's answer then replaces", async () => {
    writeHooks({ hooks: { Stop: [USER_A] } })

    expect(await reconcile({ hashes: null })).toBe('written')
    expectOrcaApprovedAt(1, computeOrcaCodexHookHashes().stop)

    expect(await reconcile()).toBe('written')
    expectOrcaApprovedAt(1)
  })

  it('writes the entry with no approval for a Codex that lists it without a hash', async () => {
    writeHooks({ hooks: { Stop: [USER_A] } })

    expect(await reconcile({ hashes: { stop: null } })).toBe('written')

    expect(readHooks().hooks.Stop).toEqual([USER_A, orcaGroup()])
    expect(readHookTrustEntries(configPath()).size).toBe(0)
  })
})
