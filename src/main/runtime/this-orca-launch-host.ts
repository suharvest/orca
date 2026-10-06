import { cachedPwshAvailability, isPwshAvailableAsync } from '../pwsh'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { localLaunchArtifactsWritable } from '../providers/local-launch-artifact-directory'
import {
  resolveWslLaunchDirectory,
  wslLaunchDirectoryKnownBroken
} from '../providers/wsl-launch-directory-resolution'
import { typedStartupLineFits } from '../../shared/typed-startup-line'
import {
  describeLaunchHost,
  spawnedWindowsShell,
  type LaunchHost,
  type WindowsShellSettings
} from '../../shared/launch-host'

type ThisOrcaLaunchHostArgs = {
  launchPlatform: NodeJS.Platform
  isRemote: boolean
  settings: WindowsShellSettings
  /** The shell this launch asked for (`--shell`), which outranks the setting. */
  windowsShellOverride?: string | null
  /** Where the pane opens; a WSL path names the distro its line and file are written into. */
  workspacePath?: string
}

/** The host facts for a launch this Orca runs itself, locally or over its own SSH connection. */
export function thisOrcaLaunchHost(args: ThisOrcaLaunchHostArgs): LaunchHost {
  const local = !args.isRemote && args.launchPlatform === 'win32' && process.platform === 'win32'
  return describeLaunchHost({
    launchPlatform: args.launchPlatform,
    isRemote: args.isRemote,
    hostPlatform: process.platform,
    paired: false,
    windowsPaneShell: local
      ? spawnedWindowsShell({
          settings: args.settings,
          windowsShellOverride: args.windowsShellOverride,
          pwshAvailable: cachedPwshAvailability()
        })
      : null,
    writesLaunchArtifacts: writesLaunchArtifacts(args)
  })
}

/**
 * Probes the WSL distro a prompt too long to type would be staged into, before the launch is
 * planned, so a first launch into an unusable folder is planned for main's delivery as later ones
 * are. The spawn would await the same probe for such a line; a prompt short enough to type skips it.
 */
export async function probeWslLaunchFolderBeforePlanning(args: {
  launchPlatform: NodeJS.Platform
  isRemote: boolean
  workspacePath?: string
  prompt?: string
}): Promise<void> {
  const distro = wslLaunchDistro(args)
  if (distro && args.prompt && !typedStartupLineFits(args.prompt.trim())) {
    await resolveWslLaunchDirectory(distro)
  }
}

/**
 * Learns which PowerShell a local PowerShell pane will be before the launch is planned. Unknown, the
 * pane is planned as a shell nothing proves alone, so every guarded paste into it is refused.
 */
async function probePwshBeforePlanning(args: ThisOrcaLaunchHostArgs): Promise<void> {
  if (args.isRemote || args.launchPlatform !== 'win32' || process.platform !== 'win32') {
    return
  }
  const shellFor = (pwshAvailable: boolean | null) =>
    spawnedWindowsShell({
      settings: args.settings,
      windowsShellOverride: args.windowsShellOverride,
      pwshAvailable
    })
  if (shellFor(null) === null && shellFor(true) !== null && cachedPwshAvailability() === null) {
    await isPwshAvailableAsync()
  }
}

/** `thisOrcaLaunchHost` for a launch of `prompt`, once its WSL folder and PowerShell are probed when
 *  they may be. */
export async function probedThisOrcaLaunchHost(
  args: ThisOrcaLaunchHostArgs & { prompt?: string }
): Promise<LaunchHost> {
  await probeWslLaunchFolderBeforePlanning(args)
  await probePwshBeforePlanning(args)
  return thisOrcaLaunchHost(args)
}

function wslLaunchDistro(args: {
  launchPlatform: NodeJS.Platform
  isRemote: boolean
  workspacePath?: string
}): string | undefined {
  if (args.isRemote || process.platform !== 'win32' || args.launchPlatform === 'win32') {
    return undefined
  }
  return args.workspacePath ? parseWslUncPath(args.workspacePath)?.distro : undefined
}

/** Whether this host can write the folder a staged line and a launch file go in. An SSH host's is
 *  the relay's, which this client cannot check. */
function writesLaunchArtifacts(args: {
  launchPlatform: NodeJS.Platform
  isRemote: boolean
  workspacePath?: string
}): boolean {
  if (args.isRemote) {
    return true
  }
  if (process.platform === 'win32' && args.launchPlatform !== 'win32') {
    const distro = wslLaunchDistro(args)
    return !distro || !wslLaunchDirectoryKnownBroken(distro)
  }
  return localLaunchArtifactsWritable()
}
