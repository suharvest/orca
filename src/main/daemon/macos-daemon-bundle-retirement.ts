import { opendir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import { rm } from '../asar-transparent-fs'
import { inspectProcessLiveness } from './daemon-process-inspection'
import { readMacDaemonJobState, stopMacDaemonJob } from './macos-daemon-job-state'
import type { MacDaemonBundle } from './macos-daemon-bundle'

const JOB_RECORD_NAME = 'job.json'
const MAX_RETIREMENT_CANDIDATES = 20
const collectionsInFlight = new Map<string, Promise<void>>()
const collectionCursors = new Map<string, string>()

type MacDaemonJobRecord = {
  label: string
  producerPid: number
  submitted: boolean
  bundleName: string
}

export async function writeMacDaemonJobRecord(
  bundle: MacDaemonBundle,
  label: string,
  submitted: boolean
): Promise<void> {
  const record: MacDaemonJobRecord = {
    label,
    producerPid: process.pid,
    submitted,
    bundleName: bundle.bundlePath.slice(bundle.directory.length + 1)
  }
  await writeFile(join(bundle.directory, JOB_RECORD_NAME), JSON.stringify(record), {
    mode: 0o600,
    flag: submitted ? 'w' : 'wx'
  })
}

async function readJobRecord(directory: string): Promise<MacDaemonJobRecord | null> {
  try {
    const value: unknown = JSON.parse(await readFile(join(directory, JOB_RECORD_NAME), 'utf8'))
    if (
      !value ||
      typeof value !== 'object' ||
      !('label' in value) ||
      typeof value.label !== 'string' ||
      !/^com\.stablyai\.orca\.terminal\.[a-zA-Z0-9-]{1,80}$/.test(value.label) ||
      !('producerPid' in value) ||
      typeof value.producerPid !== 'number' ||
      !Number.isSafeInteger(value.producerPid) ||
      value.producerPid <= 0 ||
      !('submitted' in value) ||
      typeof value.submitted !== 'boolean' ||
      !('bundleName' in value) ||
      typeof value.bundleName !== 'string' ||
      !/^[^/\\]+\.app$/.test(value.bundleName)
    ) {
      return null
    }
    return {
      label: value.label,
      producerPid: value.producerPid,
      submitted: value.submitted,
      bundleName: value.bundleName
    }
  } catch {
    return null
  }
}

/** All executables and mapped libraries count, including children that survived their daemon. */
export async function retireUnusedMacDaemonBundle(
  directory: string,
  bundlePath: string
): Promise<boolean> {
  if (process.platform !== 'darwin') {
    return false
  }
  try {
    const result = await runProcess({
      program: '/usr/sbin/lsof',
      args: ['-F', 'p', '+D', bundlePath],
      timeoutMs: 5_000,
      maxOutputBytes: 8192
    })
    if (
      result.timedOut ||
      result.outputTruncated ||
      result.code !== 1 ||
      result.stdout.trim() ||
      result.stderr.trim()
    ) {
      return false
    }
    await rm(directory, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

async function collectAbandonedBundles(root: string): Promise<void> {
  const uid = process.getuid?.()
  if (process.platform !== 'darwin' || uid === undefined) {
    return
  }
  try {
    const scan = async (after?: string): Promise<boolean> => {
      const entries = await opendir(root)
      let found = after === undefined
      let examined = 0
      for await (const entry of entries) {
        if (!found) {
          found = entry.name === after
          continue
        }
        if (!entry.isDirectory() || !entry.name.startsWith('runtime-')) {
          continue
        }
        if (++examined > MAX_RETIREMENT_CANDIDATES) {
          return true
        }
        collectionCursors.set(root, entry.name)
        const directory = join(root, entry.name)
        const record = await readJobRecord(directory)
        if (
          !record ||
          (!record.submitted && inspectProcessLiveness(record.producerPid).status !== 'exited')
        ) {
          continue
        }
        const service = `gui/${uid}/${record.label}`
        const state = await readMacDaemonJobState(service)
        if (state === 'stopped') {
          await stopMacDaemonJob(service)
        } else if (state !== 'missing' || !record.submitted) {
          continue
        }
        await retireUnusedMacDaemonBundle(directory, join(directory, record.bundleName))
      }
      collectionCursors.delete(root)
      return found
    }
    // Rotate the expensive probes; retained live copies must not starve later retired ones.
    if (!(await scan(collectionCursors.get(root)))) {
      await scan()
    }
  } catch {
    // Unverifiable ownership or process state retains code; collection is never a launch prerequisite.
  }
}

/** One bounded background collection per host, never one scan per terminal. */
export function retireAbandonedMacDaemonBundles(root: string): Promise<void> {
  const existing = collectionsInFlight.get(root)
  if (existing) {
    return existing
  }
  const pending = collectAbandonedBundles(root).finally(() => collectionsInFlight.delete(root))
  collectionsInFlight.set(root, pending)
  return pending
}
