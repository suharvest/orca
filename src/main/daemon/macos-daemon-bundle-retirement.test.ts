import { access, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '../../shared/child-process/process-spec'
import type { ProcessLivenessVerdict } from './daemon-incarnation-evidence-types'

const { run, liveness } = vi.hoisted(() => ({
  run: vi.fn<(spec: ProcessSpec) => Promise<ProcessResult>>(),
  liveness: vi.fn<() => ProcessLivenessVerdict>()
}))
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: run }))
vi.mock('./daemon-process-inspection', () => ({ inspectProcessLiveness: liveness }))
import {
  retireAbandonedMacDaemonBundles,
  retireUnusedMacDaemonBundle,
  writeMacDaemonJobRecord
} from './macos-daemon-bundle-retirement'

const result: ProcessResult = { code: 1, signal: null, stdout: '', stderr: '', timedOut: false }
let root: string
const nativePlatform = process.platform
const originalGetuid = Object.getOwnPropertyDescriptor(process, 'getuid')
beforeEach(async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  Object.defineProperty(process, 'getuid', { configurable: true, value: () => 501 })
  root = await mkdtemp(join(tmpdir(), 'orca-runtime-retire-'))
  run.mockReset().mockResolvedValue(result)
  liveness.mockReset().mockReturnValue({ status: 'exited' })
})
afterEach(async () => {
  vi.restoreAllMocks()
  if (originalGetuid) {
    Object.defineProperty(process, 'getuid', originalGetuid)
  } else {
    Reflect.deleteProperty(process, 'getuid')
  }
  await rm(root, { recursive: true, force: true })
})

async function runtime(submitted = true): Promise<string> {
  const directory = await mkdtemp(join(root, 'runtime-'))
  const bundlePath = join(directory, 'Orca.app')
  await mkdir(bundlePath)
  const bundle = { directory, bundlePath, execPath: '', entryPath: '' }
  await writeMacDaemonJobRecord(bundle, 'com.stablyai.orca.terminal.owned', false)
  if (submitted) {
    await writeMacDaemonJobRecord(bundle, 'com.stablyai.orca.terminal.owned', true)
  }
  return directory
}

it('writes private non-secret metadata and prunes only a stopped, unused runtime', async () => {
  const directory = await runtime()
  if (nativePlatform !== 'win32') {
    expect((await stat(join(directory, 'job.json'))).mode & 0o777).toBe(0o600)
  }
  expect(JSON.parse(await readFile(join(directory, 'job.json'), 'utf8'))).toEqual({
    label: 'com.stablyai.orca.terminal.owned',
    producerPid: process.pid,
    submitted: true,
    bundleName: 'Orca.app'
  })
  run.mockImplementation(async (spec) =>
    spec.args?.[0] === 'print'
      ? { ...result, code: 0, stdout: '\tstate = not running' }
      : spec.args?.[0] === 'bootout'
        ? { ...result, code: 0 }
        : result
  )
  liveness.mockReturnValue({ status: 'live' })
  await retireAbandonedMacDaemonBundles(root)
  await expect(access(directory)).rejects.toThrow()
  expect(run.mock.calls.map(([spec]) => spec.program)).toEqual([
    '/bin/launchctl',
    '/bin/launchctl',
    '/usr/sbin/lsof'
  ])
})

it('keeps a stopped runtime when its job could not be unregistered', async () => {
  const directory = await runtime()
  run.mockImplementation(async (spec) =>
    spec.args?.[0] === 'print'
      ? { ...result, code: 0, stdout: '\tstate = not running' }
      : { ...result, code: 1 }
  )
  await retireAbandonedMacDaemonBundles(root)
  await expect(access(directory)).resolves.toBeUndefined()
  expect(run.mock.calls.some(([spec]) => spec.program === '/usr/sbin/lsof')).toBe(false)
})

it.each([{ status: 'live' }, { status: 'unverifiable', reason: 'denied' }] as const)(
  'retains a $status producer without querying launchd',
  async (verdict) => {
    const directory = await runtime(false)
    liveness.mockReturnValue(verdict)
    await retireAbandonedMacDaemonBundles(root)
    await expect(access(directory)).resolves.toBeUndefined()
    expect(run).not.toHaveBeenCalled()
  }
)

it('retains a possibly in-flight submission when its job is absent', async () => {
  const directory = await runtime(false)
  run.mockResolvedValue({ ...result, code: 113, stderr: 'Could not find service "owned"' })
  await retireAbandonedMacDaemonBundles(root)
  await expect(access(directory)).resolves.toBeUndefined()
  expect(run).toHaveBeenCalledTimes(1)
})

it('prunes an absent submitted job and coalesces overlapping collections', async () => {
  const directory = await runtime()
  run.mockImplementation(async (spec) =>
    spec.args?.[0] === 'print'
      ? { ...result, code: 113, stderr: 'Could not find service "owned"' }
      : result
  )
  const first = retireAbandonedMacDaemonBundles(root)
  expect(retireAbandonedMacDaemonBundles(root)).toBe(first)
  await first
  await expect(access(directory)).rejects.toThrow()
})

it.each([
  { code: 0, stdout: 'p123' },
  { stderr: 'permission denied' },
  { timedOut: true },
  { outputTruncated: true },
  { code: null }
])('retains code when open-file absence is unverified: %j', async (override) => {
  const directory = await runtime()
  run.mockResolvedValue({ ...result, ...override })
  expect(await retireUnusedMacDaemonBundle(directory, join(directory, 'Orca.app'))).toBe(false)
  await expect(access(directory)).resolves.toBeUndefined()
})

it('bounds expensive inspection to twenty copies per collection', async () => {
  await Promise.all(Array.from({ length: 30 }, () => runtime()))
  run.mockResolvedValue({ ...result, code: 0, stdout: '\tstate = running' })
  await retireAbandonedMacDaemonBundles(root)
  expect(run).toHaveBeenCalledTimes(20)
  run.mockClear()
  await retireAbandonedMacDaemonBundles(root)
  expect(run).toHaveBeenCalledTimes(10)
})
