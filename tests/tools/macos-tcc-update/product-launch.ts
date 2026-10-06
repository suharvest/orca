import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { rm } from '../../../src/main/asar-transparent-fs'
import { setAppEnvironment } from '../../../src/shared/app-environment'
import { launchMacDaemonFromStableBundle } from '../../../src/main/daemon/macos-daemon-launchd'
import { DaemonClient } from '../../../src/main/daemon/client'
import type { GetSnapshotResult } from '../../../src/main/daemon/types'
import { runProcess } from '../../../src/shared/child-process/run-process'
import { getMacosFullDiskAccessStatus } from '../../../src/main/macos-full-disk-access-status'

async function main(): Promise<void> {
  const suppliedProfile = process.argv[2]
  if (!suppliedProfile) {
    throw new Error('No isolated profile')
  }
  const userDataPath = await realpath(suppliedProfile)
  const source = resolve(dirname(process.execPath), '..', '..')
  if (
    dirname(source) !== dirname(userDataPath) ||
    !(await readFile(join(dirname(source), 'test-owned'), 'utf8'))
  ) {
    throw new Error('The source app must be an owned test copy beside its isolated profile')
  }
  if ((await getMacosFullDiskAccessStatus()) !== 'granted') {
    throw new Error('Baseline FDA is unavailable; this test never changes privacy grants')
  }
  setAppEnvironment({
    getPath: (name) => (name === 'home' ? homedir() : userDataPath),
    getAppPath: () => join(source, 'Contents', 'Resources', 'app.asar'),
    getVersion: () => '13921-test',
    isPackaged: () => true,
    onWillQuit: () => {},
    exit: (code) => process.exit(code),
    getAppMetrics: () => []
  })
  const entryPath = join(
    source,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'out',
    'main',
    'daemon-entry.js'
  )
  const socketPath = join(userDataPath, 'daemon.sock')
  const tokenPath = join(userDataPath, 'daemon.token')
  const pidPath = join(userDataPath, 'daemon.pid')
  const started = performance.now()
  const handle = await launchMacDaemonFromStableBundle({
    entryPath,
    forkEntryPath: entryPath,
    userDataPath,
    socketPath,
    tokenPath,
    pidPath,
    launchNonce: randomUUID(),
    macosLoginSessionWatch: true
  })
  if (!handle) {
    throw new Error('Did not use launchd')
  }
  const client = new DaemonClient({ socketPath, tokenPath })
  const witnesses: string[] = []
  const observations: { phase: string; folder: string; sessionId: string }[] = []
  try {
    await client.ensureConnectedWithin(5000)
    const identity = client.getDaemonIdentity()
    const launchMs = performance.now() - started
    const record: unknown = JSON.parse(await readFile(pidPath, 'utf8'))
    if (
      !record ||
      typeof record !== 'object' ||
      !('pid' in record) ||
      record.pid !== identity?.pid
    ) {
      throw new Error('The PID record and authenticated handshake disagree')
    }
    const create = async (sessionId: string, cwd: string): Promise<void> => {
      await client.request('createOrAttach', {
        sessionId,
        cwd,
        cols: 120,
        rows: 30,
        shellOverride: '/bin/bash',
        terminalShellArgs: ['--noprofile', '--norc'],
        env: { HOME: homedir(), TERM: 'xterm-256color', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
        shellReadySupported: false
      })
    }
    const probe = async (sessionId: string, phase: string, folder: string): Promise<void> => {
      const marker = `ORCA_TCC_${randomUUID()}`
      const command = `failed=0; /bin/pwd -P >/dev/null || failed=1; /bin/cat witness.txt >/dev/null || failed=1; /usr/bin/git -C . status --porcelain >/dev/null || failed=1; /usr/bin/head -c 1 "$HOME/Library/Application Support/com.apple.TCC/TCC.db" >/dev/null || failed=1; printf '${marker}=%s\\n' "$failed"\r`
      await client.request('write', { sessionId, data: command })
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        const { snapshot } = await client.request<GetSnapshotResult>('getSnapshot', { sessionId })
        if (snapshot?.snapshotAnsi.includes(`${marker}=0`)) {
          observations.push({ phase, folder, sessionId })
          console.log(JSON.stringify({ phase, folder, passed: true, daemonPid: identity?.pid }))
          return
        }
        if (snapshot?.snapshotAnsi.includes(`${marker}=1`)) {
          throw new Error(`Protected cwd/read/Git/FDA failed in ${folder} during ${phase}`)
        }
        await delay(50)
      }
      throw new Error(`No terminal result in ${folder} during ${phase}`)
    }
    for (const folder of ['Desktop', 'Documents', 'Downloads']) {
      const witness = join(homedir(), folder, `.orca-tcc-${randomUUID()}`)
      await mkdir(witness, { mode: 0o700 })
      witnesses.push(witness)
      await writeFile(join(witness, 'witness.txt'), 'orca-owned witness\n')
      const initialized = await runProcess({
        program: '/usr/bin/git',
        args: ['init', '--quiet', witness],
        timeoutMs: 10000
      })
      if (initialized.code !== 0 || initialized.timedOut) {
        throw new Error(`Could not initialize the owned ${folder} witness`)
      }
      await create(`persistent-${folder}`, witness)
      await probe(`persistent-${folder}`, 'before', folder)
    }
    for (let update = 1; update <= 2; update++) {
      const parking = join(dirname(source), `com.stablyai.orca.ShipIt.${update}`)
      await mkdir(parking)
      await rename(source, join(parking, basename(source)))
      try {
        for (const folder of ['Desktop', 'Documents', 'Downloads']) {
          await probe(`persistent-${folder}`, `gap${update}`, folder)
        }
      } finally {
        await rename(join(dirname(source), `incoming-${update}.app`), source)
      }
      await rm(parking, { recursive: true })
      for (const [index, folder] of ['Desktop', 'Documents', 'Downloads'].entries()) {
        await probe(`persistent-${folder}`, `replaced${update}`, folder)
        await create(`fresh-${update}-${folder}`, witnesses[index])
        await probe(`fresh-${update}-${folder}`, `fresh${update}`, folder)
      }
    }
    const permission = await client.request('fullDiskAccessStatus', undefined)
    if (
      !permission ||
      typeof permission !== 'object' ||
      !('status' in permission) ||
      permission.status !== 'granted'
    ) {
      throw new Error('Daemon-side FDA probe disagreed with the terminal reads')
    }
    client.disconnect()
    await client.ensureConnectedWithin(5000)
    if (client.getDaemonIdentity()?.launchNonce !== identity?.launchNonce) {
      throw new Error('Reconnect replaced the live daemon')
    }
    await probe('persistent-Desktop', 'reconnect', 'Desktop')
    await writeFile(
      join(dirname(source), 'results.json'),
      JSON.stringify({ passed: true, launchMs, identity, observations }, null, 2)
    )
  } finally {
    client.disconnect()
    handle.releaseAdoptionLease?.()
    await handle.shutdown()
    for (const witness of witnesses) {
      await rm(witness, { recursive: true, force: true })
    }
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
