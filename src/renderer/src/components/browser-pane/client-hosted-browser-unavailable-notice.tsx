import { Globe } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { readBrowserClientHostId } from '@/runtime/browser-client-host-identity'
import {
  ReopenBrowserPageOnServerButton,
  reopenOnServerCaveat
} from './ReopenBrowserPageOnServerButton'

/**
 * What a client-hosted page shows when its guest is not here: the page belongs to another desktop,
 * or the host that owned it is gone. There is nothing to retry locally, so the only way forward
 * offered is reopening the page on the server.
 */
export function ClientHostedBrowserUnavailableNotice({
  runtimeEnvironmentId,
  worktreeId,
  lastCommittedUrl,
  placementHostClientId
}: {
  runtimeEnvironmentId: string
  worktreeId: string
  lastCommittedUrl: string
  placementHostClientId: string | null
}): React.JSX.Element {
  // Why a null status only: an entry not yet probed is not evidence the host is offline.
  const offlineHostName = useAppStore((s) =>
    s.runtimeStatusByEnvironmentId.get(runtimeEnvironmentId)?.status === null
      ? (s.runtimeEnvironments.find((environment) => environment.id === runtimeEnvironmentId)
          ?.name ?? null)
      : null
  )
  const ownHostClientId = readBrowserClientHostId()
  const description =
    placementHostClientId && ownHostClientId && placementHostClientId !== ownHostClientId
      ? translate(
          'browser.clientHosted.unavailableOtherDesktopDescription',
          'This page is open on another desktop.'
        )
      : offlineHostName
        ? translate(
            'browser.clientHosted.unavailableHostOfflineDescription',
            '{{host}} is offline. This page will reload here once it reconnects.',
            { host: offlineHostName }
          )
        : translate(
            'browser.clientHosted.unavailableDescription',
            "This page isn't available on this desktop right now."
          )
  return (
    <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
      <div className="flex max-w-sm flex-col items-center gap-2">
        <Globe className="size-5 text-muted-foreground" />
        <div className="text-sm font-medium text-foreground">
          {translate('browser.clientHosted.unavailableTitle', 'Client-hosted browser unavailable')}
        </div>
        <div className="text-xs leading-5 text-muted-foreground">{description}</div>
        <div className="text-xs leading-5 text-muted-foreground">{reopenOnServerCaveat()}</div>
        <ReopenBrowserPageOnServerButton
          environmentId={runtimeEnvironmentId}
          worktreeId={worktreeId}
          lastCommittedUrl={lastCommittedUrl}
        />
      </div>
    </div>
  )
}
