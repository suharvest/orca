import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { getAppEnvironment } from '../../shared/app-environment'
import { runProcess } from '../../shared/child-process/run-process'
import { DaemonClient } from './client'
import { DaemonEndpointOwnershipError, holdDaemonAdoptionLease } from './daemon-endpoint-adoption'
import { buildDaemonScriptArgs, type DaemonChildSpawnOptions } from './daemon-launched-child-spawn'
import { materializeMacDaemonBundle } from './macos-daemon-bundle'
import { rm as removeBundle } from '../asar-transparent-fs'
import {
  retireUnusedMacDaemonBundle,
  writeMacDaemonJobRecord
} from './macos-daemon-bundle-retirement'
import { stopMacDaemonJob } from './macos-daemon-job-state'
import { remainingMacDaemonStartupMs } from './macos-daemon-startup-budget'
import type { DaemonProcessHandle } from './daemon-spawner'

const STARTUP_TIMEOUT_MS = 10_000

export function buildMacDaemonLaunchJob(
  options: DaemonChildSpawnOptions,
  execPath: string,
  entryPath: string,
  label: string
): Record<string, unknown> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    ORCA_USER_DATA_PATH: options.userDataPath
  }
  delete env.NODE_CHANNEL_FD
  delete env.NODE_CHANNEL_SERIALIZATION_MODE
  delete env.NODE_UNIQUE_ID
  return {
    Label: label,
    ProgramArguments: [execPath, entryPath, ...buildDaemonScriptArgs(options, execPath)],
    EnvironmentVariables: env,
    WorkingDirectory: options.userDataPath,
    RunAtLoad: true,
    KeepAlive: false,
    AbandonProcessGroup: true,
    ProcessType: 'Interactive',
    StandardOutPath: '/dev/null',
    StandardErrorPath: '/dev/null'
  }
}

/** A launchd child owns Orca's signed identity independently of the replaceable UI process. */
export async function launchMacDaemonFromStableBundle(
  options: DaemonChildSpawnOptions,
  startupDeadlineMs = Date.now() + 55_000
): Promise<DaemonProcessHandle | null> {
  if (process.platform !== 'darwin' || !options.macosLoginSessionWatch) {
    return null
  }
  const environment = getAppEnvironment()
  if (!environment.isPackaged() || !environment.getAppPath().includes('app.asar')) {
    return null
  }
  const uid = process.getuid?.()
  if (uid === undefined) {
    throw new Error('Could not resolve the macOS login user')
  }
  const bundle = await materializeMacDaemonBundle(
    options.userDataPath,
    options.entryPath,
    startupDeadlineMs
  )
  const label = `com.stablyai.orca.terminal.${options.launchNonce}`
  const domain = `gui/${uid}`
  const service = `${domain}/${label}`
  const jobPath = join(bundle.directory, 'launch.plist')
  let attemptedBootstrap = false
  const shutdown = async (): Promise<void> => {
    await stopMacDaemonJob(service)
    await retireUnusedMacDaemonBundle(bundle.directory, bundle.bundlePath)
  }
  try {
    await writeMacDaemonJobRecord(bundle, label, false)
    // The inherited environment can contain credentials; never leave it on disk after bootstrap.
    await writeFile(
      jobPath,
      JSON.stringify(buildMacDaemonLaunchJob(options, bundle.execPath, bundle.entryPath, label)),
      { mode: 0o600, flag: 'wx' }
    )
    const converted = await runProcess({
      program: '/usr/bin/plutil',
      args: ['-convert', 'xml1', jobPath],
      timeoutMs: remainingMacDaemonStartupMs(startupDeadlineMs, 5_000),
      maxOutputBytes: 8192
    })
    if (converted.code !== 0 || converted.timedOut) {
      throw new Error('Could not prepare the macOS terminal service')
    }
    const bootstrapTimeoutMs = remainingMacDaemonStartupMs(startupDeadlineMs, 10_000)
    attemptedBootstrap = true
    const result = await runProcess({
      program: '/bin/launchctl',
      args: ['bootstrap', domain, jobPath],
      timeoutMs: bootstrapTimeoutMs,
      maxOutputBytes: 8192
    })
    if (result.code !== 0 || result.timedOut) {
      throw new Error('Could not start the macOS terminal service')
    }
    await writeMacDaemonJobRecord(bundle, label, true).catch(() => {})
  } catch (error) {
    if (!attemptedBootstrap) {
      await removeBundle(bundle.directory, { recursive: true, force: true }).catch(() => {})
    }
    throw error
  } finally {
    await rm(jobPath, { force: true }).catch(() => {})
  }
  const client = new DaemonClient({ socketPath: options.socketPath, tokenPath: options.tokenPath })
  const deadline = Math.min(startupDeadlineMs, Date.now() + STARTUP_TIMEOUT_MS)
  try {
    while (true) {
      try {
        await client.ensureConnectedWithin(Math.max(1, deadline - Date.now()))
        break
      } catch (error) {
        client.disconnect()
        if (Date.now() >= deadline) {
          throw error
        }
        await delay(50)
      }
    }
    const identity = client.getDaemonIdentity()
    if (!identity || identity.launchNonce !== options.launchNonce) {
      await shutdown()
      throw new DaemonEndpointOwnershipError('Another daemon owns the terminal endpoint')
    }
    return await holdDaemonAdoptionLease(
      { shutdown },
      options.socketPath,
      options.tokenPath,
      client,
      identity,
      options.pidPath
    )
  } catch (error) {
    client.disconnect()
    throw error
  }
}
