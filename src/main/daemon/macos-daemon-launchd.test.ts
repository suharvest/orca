import { access, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DaemonEndpointIdentity } from './daemon-hello-protocol'
import type { ProcessResult, ProcessSpec } from '../../shared/child-process/process-spec'

const { state, runProcessMock, materializeMock, ensureWithinMock, disconnectMock } = vi.hoisted(
  () => {
    const state: {
      root: string
      packaged: boolean
      identity: DaemonEndpointIdentity | null
    } = {
      root: '',
      packaged: true,
      identity: null
    }
    return {
      state,
      runProcessMock: vi.fn<(spec: ProcessSpec) => Promise<ProcessResult>>(),
      materializeMock: vi.fn(),
      ensureWithinMock: vi.fn(),
      disconnectMock: vi.fn()
    }
  }
)
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))
vi.mock('../../shared/app-environment', () => ({
  hasAppEnvironment: () => true,
  getAppEnvironment: () => ({
    getAppPath: () => '/Applications/Orca.app/Contents/Resources/app.asar',
    getPath: () => state.root,
    getVersion: () => '1.2.3',
    isPackaged: () => state.packaged
  })
}))
vi.mock('./macos-daemon-bundle', () => ({ materializeMacDaemonBundle: materializeMock }))
vi.mock('./client', () => ({
  DaemonClient: class {
    ensureConnectedWithin = ensureWithinMock
    ensureConnected = vi.fn(async () => {})
    disconnect = disconnectMock
    getDaemonIdentity(): DaemonEndpointIdentity | null {
      return state.identity
    }
  }
}))

import { launchMacDaemonFromStableBundle } from './macos-daemon-launchd'
import type { DaemonChildSpawnOptions } from './daemon-launched-child-spawn'

let options: DaemonChildSpawnOptions
let job: unknown
let jobMode: number
const nativePlatform = process.platform
const originalGetuid = Object.getOwnPropertyDescriptor(process, 'getuid')

beforeEach(async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  Object.defineProperty(process, 'getuid', { configurable: true, value: () => 501 })
  state.root = await mkdtemp(join(tmpdir(), 'orca-mac-launch-job-'))
  state.packaged = true
  state.identity = { pid: 12345, startedAtMs: 1000, launchNonce: 'owned-launch' }
  options = {
    entryPath: '/Applications/Orca.app/Contents/Resources/daemon-entry.js',
    forkEntryPath: '/Applications/Orca.app/Contents/Resources/daemon-entry.js',
    userDataPath: state.root,
    socketPath: join(state.root, 'daemon.sock'),
    tokenPath: join(state.root, 'daemon.token'),
    pidPath: join(state.root, 'daemon.pid'),
    launchNonce: 'owned-launch',
    macosLoginSessionWatch: true
  }
  await mkdir(join(state.root, 'runtime'))
  materializeMock.mockReset().mockResolvedValue({
    directory: join(state.root, 'runtime'),
    bundlePath: join(state.root, 'runtime', 'Orca.app'),
    execPath: join(state.root, 'runtime', 'Orca.app', 'Contents', 'MacOS', 'Orca'),
    entryPath: join(state.root, 'runtime', 'Orca.app', 'Contents', 'Resources', 'daemon-entry.js')
  })
  ensureWithinMock.mockReset().mockResolvedValue(undefined)
  disconnectMock.mockReset()
  runProcessMock.mockReset().mockImplementation(async (spec) => {
    if (spec.program === '/usr/bin/plutil') {
      const path = spec.args?.at(-1)
      if (!path) {
        throw new Error('No job path')
      }
      job = JSON.parse(await readFile(path, 'utf8'))
      jobMode = (await stat(path)).mode & 0o777
    }
    return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (originalGetuid) {
    Object.defineProperty(process, 'getuid', originalGetuid)
  } else {
    Reflect.deleteProperty(process, 'getuid')
  }
  vi.unstubAllEnvs()
  await rm(state.root, { recursive: true, force: true })
})

it('launches the stable main executable and leaves no inherited credentials on disk', async () => {
  vi.stubEnv('ORCA_TEST_SECRET', 'test-value')
  vi.stubEnv('NODE_CHANNEL_FD', '3')
  const handle = await launchMacDaemonFromStableBundle(options)
  if (nativePlatform !== 'win32') {
    expect(jobMode).toBe(0o600)
  }
  expect(job).toMatchObject({
    Label: 'com.stablyai.orca.terminal.owned-launch',
    ProgramArguments: expect.arrayContaining([
      join(state.root, 'runtime', 'Orca.app', 'Contents', 'MacOS', 'Orca'),
      join(state.root, 'runtime', 'Orca.app', 'Contents', 'Resources', 'daemon-entry.js')
    ]),
    KeepAlive: false,
    EnvironmentVariables: { ELECTRON_RUN_AS_NODE: '1', ORCA_TEST_SECRET: 'test-value' }
  })
  expect(JSON.stringify(job)).not.toContain('NODE_CHANNEL_FD')
  expect(job).toHaveProperty(
    'ProgramArguments.0',
    join(state.root, 'runtime', 'Orca.app', 'Contents', 'MacOS', 'Orca')
  )
  await expect(access(join(state.root, 'runtime', 'launch.plist'))).rejects.toThrow()
  expect(handle?.releaseAdoptionLease).toBeTypeOf('function')
  await handle?.shutdown()
  expect(runProcessMock).toHaveBeenCalledWith(
    expect.objectContaining({
      program: '/bin/launchctl',
      args: ['bootout', `gui/${process.getuid?.()}/com.stablyai.orca.terminal.owned-launch`]
    })
  )
})

it('rejects a foreign endpoint and stops only the job it created', async () => {
  state.identity = { pid: 55555, startedAtMs: 2000, launchNonce: 'another-launch' }
  await expect(launchMacDaemonFromStableBundle(options)).rejects.toThrow('Another daemon owns')
  await expect(access(options.pidPath)).rejects.toThrow()
  expect(disconnectMock).toHaveBeenCalled()
  expect(runProcessMock).toHaveBeenCalledWith(
    expect.objectContaining({ args: ['bootout', expect.stringContaining('owned-launch')] })
  )
})

it('preserves copied code after an uncertain bootstrap while removing the private job file', async () => {
  runProcessMock
    .mockResolvedValueOnce({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false })
    .mockResolvedValueOnce({
      code: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
      timedOut: true
    })
  await expect(launchMacDaemonFromStableBundle(options)).rejects.toThrow(
    'start the macOS terminal service'
  )
  await expect(access(join(state.root, 'runtime'))).resolves.toBeUndefined()
  await expect(access(join(state.root, 'runtime', 'launch.plist'))).rejects.toThrow()
  expect(ensureWithinMock).not.toHaveBeenCalled()
})

it('retries a connection refusal while retaining the same launch attempt', async () => {
  ensureWithinMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
  const handle = await launchMacDaemonFromStableBundle(options)
  expect(handle).not.toBeNull()
  expect(ensureWithinMock).toHaveBeenCalledTimes(2)
  expect(materializeMock).toHaveBeenCalledTimes(1)
  expect(
    runProcessMock.mock.calls.filter(([spec]) => spec.args?.includes('bootstrap'))
  ).toHaveLength(1)
})

it('does not submit a daemon after the startup gate deadline expires', async () => {
  await expect(launchMacDaemonFromStableBundle(options, Date.now() - 1)).rejects.toThrow(
    'deadline expired'
  )
  expect(runProcessMock).not.toHaveBeenCalled()
  await expect(access(join(state.root, 'runtime'))).rejects.toThrow()
})

it('removes a private runtime when plist preparation fails before bootstrap', async () => {
  runProcessMock.mockResolvedValue({
    code: 1,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false
  })
  await expect(launchMacDaemonFromStableBundle(options)).rejects.toThrow('prepare the macOS')
  await expect(access(join(state.root, 'runtime'))).rejects.toThrow()
  expect(runProcessMock.mock.calls.some(([spec]) => spec.args?.includes('bootstrap'))).toBe(false)
})

it.each(['linux', 'win32'] as const)('keeps %s on the existing launcher', async (platform) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  await expect(launchMacDaemonFromStableBundle(options)).resolves.toBeNull()
  expect(materializeMock).not.toHaveBeenCalled()
  expect(runProcessMock).not.toHaveBeenCalled()
})

it('keeps Node/SSH hosts and unpackaged Electron on the existing launcher', async () => {
  await expect(
    launchMacDaemonFromStableBundle({ ...options, macosLoginSessionWatch: false })
  ).resolves.toBeNull()
  state.packaged = false
  await expect(launchMacDaemonFromStableBundle(options)).resolves.toBeNull()
  expect(materializeMock).not.toHaveBeenCalled()
})
