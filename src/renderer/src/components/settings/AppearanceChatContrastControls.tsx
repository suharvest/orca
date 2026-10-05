import type { NativeChatAppearanceSettings } from '../../../../shared/native-chat-appearance-settings'
import { getChatContrastSearchEntries } from './chat-appearance-search'
import { translate } from '@/i18n/i18n'
import { Slider } from '../ui/slider'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow, SettingsSwitchRow } from './SettingsFormControls'

type ChatContrastControlsProps = {
  appearance: Required<NativeChatAppearanceSettings>
  onChange: (updates: NativeChatAppearanceSettings) => void
  forceVisiblePrimary?: boolean
}

export function AppearanceChatContrastControls({
  appearance,
  onChange,
  forceVisiblePrimary
}: ChatContrastControlsProps): React.JSX.Element {
  const entries = getChatContrastSearchEntries()
  const { contrast, matchTerminalInterface: matching } = appearance
  return (
    <>
      <SearchableSetting {...entries[0]} forceVisible={forceVisiblePrimary}>
        <SettingsSwitchRow
          label={entries[0].title}
          description={entries[0].description}
          checked={matching}
          onChange={() => onChange({ matchTerminalInterface: !matching })}
        />
      </SearchableSetting>
      <SearchableSetting {...entries[1]} forceVisible={forceVisiblePrimary}>
        <SettingsRow
          label={entries[1].title}
          description={entries[1].description}
          control={
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {translate('settings.appearance.chat.softer', 'Softer')}
              </span>
              <div className="w-40">
                <Slider
                  min={50}
                  max={150}
                  step={1}
                  value={[contrast]}
                  thumbLabels={[entries[1].title]}
                  onValueChange={([value]) => onChange({ contrast: value })}
                />
              </div>
              <span className="text-xs text-muted-foreground">
                {translate('settings.appearance.chat.sharper', 'Sharper')}
              </span>
              <span className="w-8 text-right text-xs text-muted-foreground tabular-nums">
                {contrast}
              </span>
            </div>
          }
        />
      </SearchableSetting>
    </>
  )
}
