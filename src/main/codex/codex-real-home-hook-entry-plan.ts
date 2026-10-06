import type { HookCommandConfig, HookDefinition } from '../agent-hooks/installer-utils'
import {
  buildCodexManagedHook,
  CODEX_EVENT_LABEL,
  type CodexManagedHookInstallMaterial
} from './codex-hook-definition'
import { CODEX_HOOK_COMMAND_FORM, readCodexHookCommandForm } from './codex-hook-command-form'
import { createCodexHookTrustEntry } from './codex-hook-identity'
import type { CodexEventLabel, CodexTrustEntry } from './config-toml-trust'

type HooksByEvent = Record<string, HookDefinition[]>

/**
 * Orca's entry in ~/.codex lives alone, in a group with no matcher, once per
 * event: Codex hashes the group's matcher, so a copy inside a user's group
 * would wait for review forever.
 */
export type RealHomeCodexHookEntryPlan = {
  /** Every Orca copy but the one kept is gone; user hooks may shift, so their approvals move. */
  pruned: HooksByEvent
  /** `pruned` with Orca's entry rewritten in place or appended last; no user hook moves. */
  hooks: HooksByEvent
  prunedChanged: boolean
  changed: boolean
  /** Events whose hooks this plan changed; an approval read before the write may no longer fit them. */
  changedLabels: ReadonlySet<CodexEventLabel>
  /** Orca's entry in each planned event, keyed by `sourcePath`. */
  managedEntries: CodexTrustEntry[]
  /** Events left as they are: a newer build's entry, or an older one not up for conversion. */
  untouchedLabels: ReadonlySet<CodexEventLabel>
}

type OrcaHandler = {
  groupIndex: number
  handlerIndex: number
  hook: HookCommandConfig
  form: number
}

type OrcaUnit = { groupIndex: number; handlerIndex: number } | { groupIndex: number; key: string }

const DIRECT_COMMAND_KEYS = ['command', 'bash', 'powershell'] as const

function findOrcaHandlers(
  definitions: HookDefinition[],
  isOrcaCommand: (command: string | undefined) => boolean,
  command: string
): OrcaHandler[] {
  return definitions.flatMap((definition, groupIndex) =>
    Array.isArray(definition.hooks)
      ? definition.hooks.flatMap((hook, handlerIndex) =>
          isOrcaCommand(hook.command)
            ? [
                {
                  groupIndex,
                  handlerIndex,
                  hook,
                  form: readCodexHookCommandForm(hook.command, command)
                }
              ]
            : []
        )
      : []
  )
}

/** A group that holds only Orca's handlers, with no matcher and nothing else of the user's. */
function isOrcaOnlyGroup(
  definition: HookDefinition,
  isOrcaCommand: (command: string | undefined) => boolean
): boolean {
  return (
    Object.keys(definition).every((key) => key === 'hooks') &&
    Array.isArray(definition.hooks) &&
    definition.hooks.every((hook) => isOrcaCommand(hook.command))
  )
}

function hasCommand(definition: HookDefinition): boolean {
  return (
    DIRECT_COMMAND_KEYS.some((key) => typeof definition[key] === 'string') ||
    (Array.isArray(definition.hooks) && definition.hooks.length > 0)
  )
}

function withoutOrcaUnit(definitions: HookDefinition[], unit: OrcaUnit): HookDefinition[] {
  const definition: HookDefinition = { ...definitions[unit.groupIndex]! }
  if ('key' in unit) {
    delete definition[unit.key]
  } else {
    definition.hooks = definition.hooks!.filter((_, index) => index !== unit.handlerIndex)
    if (definition.hooks.length === 0) {
      delete definition.hooks
    }
  }
  const next = [...definitions]
  if (hasCommand(definition)) {
    next[unit.groupIndex] = definition
  } else {
    next.splice(unit.groupIndex, 1)
  }
  return next
}

function locateHandler(
  definitions: HookDefinition[],
  hook: HookCommandConfig
): { groupIndex: number; handlerIndex: number } {
  for (const [groupIndex, definition] of definitions.entries()) {
    const handlerIndex = definition.hooks?.indexOf(hook) ?? -1
    if (handlerIndex !== -1) {
      return { groupIndex, handlerIndex }
    }
  }
  throw new Error('kept Codex hook handler is missing from its plan')
}

// Why every field: Codex hashes command, type, timeout, async and statusMessage, so an
// edited copy kept in place would sit beside an approval for what Orca wrote.
function isSameHook(left: HookCommandConfig, right: HookCommandConfig): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  return [...keys].every((key) => JSON.stringify(left[key]) === JSON.stringify(right[key]))
}

export function planRealHomeCodexHookEntries(args: {
  hooks: HooksByEvent
  sourcePath: string
  material: Pick<CodexManagedHookInstallMaterial, 'events' | 'command'>
  isOrcaCommand: (command: string | undefined) => boolean
  /** App start and the setting turning on; a launch never fights a running older build. */
  convertOlderForms: boolean
}): RealHomeCodexHookEntryPlan {
  const { material, isOrcaCommand, sourcePath } = args
  const command = material.command
  // Why: events this build does not plan keep their Orca entries; a newer build
  // may subscribe to them, and Codex lists no hash for them here.
  const pruned: HooksByEvent = { ...args.hooks }
  const hooks: HooksByEvent = { ...args.hooks }
  const changedLabels = new Set<CodexEventLabel>()
  const untouchedLabels = new Set<CodexEventLabel>()
  let prunedChanged = false

  for (const eventName of material.events) {
    const current = Array.isArray(args.hooks[eventName]) ? args.hooks[eventName] : []
    const handlers = findOrcaHandlers(current, isOrcaCommand, command)
    const directOrcaUnits: OrcaUnit[] = current.flatMap((definition, groupIndex) =>
      DIRECT_COMMAND_KEYS.filter((key) => isOrcaCommand(definition[key])).map((key) => ({
        groupIndex,
        key
      }))
    )
    const holdsOlderForm =
      directOrcaUnits.length > 0 || handlers.some((handler) => handler.hook.command !== command)
    if (
      handlers.some((handler) => handler.form > CODEX_HOOK_COMMAND_FORM) ||
      (holdsOlderForm && !args.convertOlderForms)
    ) {
      // Why: a newer build owns this event's entry, and an older build's may still be running.
      untouchedLabels.add(CODEX_EVENT_LABEL[eventName])
      continue
    }
    const wanted = buildCodexManagedHook(command, eventName)
    const keeper = handlers.find((handler) =>
      isOrcaOnlyGroup(current[handler.groupIndex]!, isOrcaCommand)
    )
    const others: OrcaUnit[] = [
      ...handlers.filter((handler) => handler !== keeper),
      ...directOrcaUnits
    ]
    others.sort((a, b) =>
      a.groupIndex !== b.groupIndex
        ? b.groupIndex - a.groupIndex
        : ('handlerIndex' in b ? b.handlerIndex : -1) - ('handlerIndex' in a ? a.handlerIndex : -1)
    )
    let definitions = current
    for (const unit of others) {
      definitions = withoutOrcaUnit(definitions, unit)
    }
    if (definitions !== current) {
      pruned[eventName] = definitions
      prunedChanged = true
    }
    if (!keeper) {
      // Why last: no user hook's positional approval key moves.
      definitions = [...definitions, { hooks: [wanted] }]
    } else if (!isSameHook(keeper.hook, wanted)) {
      // Why in place: the slot keeps its position, so no user approval key moves.
      const { groupIndex } = locateHandler(definitions, keeper.hook)
      definitions = [...definitions]
      definitions[groupIndex] = { hooks: [wanted] }
    }
    if (definitions !== current) {
      hooks[eventName] = definitions
      changedLabels.add(CODEX_EVENT_LABEL[eventName])
    }
  }

  const managedEntries = material.events.flatMap((eventName) =>
    untouchedLabels.has(CODEX_EVENT_LABEL[eventName])
      ? []
      : hooks[eventName]!.flatMap((definition, groupIndex) =>
          (definition.hooks ?? []).flatMap((hook, handlerIndex) => {
            const entry =
              hook.command === command
                ? createCodexHookTrustEntry(
                    sourcePath,
                    eventName,
                    groupIndex,
                    handlerIndex,
                    definition,
                    hook
                  )
                : null
            return entry ? [entry] : []
          })
        )
  )
  return {
    pruned,
    hooks,
    prunedChanged,
    changed: changedLabels.size > 0,
    changedLabels,
    managedEntries,
    untouchedLabels
  }
}
