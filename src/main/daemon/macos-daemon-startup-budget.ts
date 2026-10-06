/** Never bootstrap a late daemon after the desktop startup gate has already failed open. */
export function remainingMacDaemonStartupMs(deadlineMs: number, stageCapMs: number): number {
  const remaining = deadlineMs - Date.now()
  if (remaining <= 0) {
    throw new Error('The macOS terminal service startup deadline expired')
  }
  return Math.min(remaining, stageCapMs)
}
