import React from 'react'
import { createRoot } from 'react-dom/client'
import { DeveloperPermissionsPane } from '../../../../src/renderer/src/components/settings/DeveloperPermissionsPane'
import type { DeveloperPermissionState } from '../../../../src/shared/developer-permissions-types'
import { TooltipProvider } from '../../../../src/renderer/src/components/ui/tooltip'
import './fixture.css'

const status = new URLSearchParams(location.search).get('terminal')
const terminalHostStatus = status === 'granted' || status === 'denied' ? status : 'unknown'
Object.assign(window, {
  api: {
    developerPermissions: {
      getStatus: async (): Promise<DeveloperPermissionState[]> => [
        { id: 'full-disk-access', status: 'granted', terminalHostStatus }
      ],
      request: async () => {
        throw new Error('Privacy requests are disabled in this fixture')
      },
      openSettings: async () => {
        throw new Error('System Settings are disabled in this fixture')
      }
    },
    pty: { management: { macTccAttribution: async () => ({ health: 'intact' }) } }
  }
})
const root = document.getElementById('root')
if (!root) {
  throw new Error('Missing fixture root')
}
createRoot(root).render(
  <TooltipProvider>
    <main className="mx-auto max-w-4xl p-6">
      <DeveloperPermissionsPane />
    </main>
  </TooltipProvider>
)
