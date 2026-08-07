import type { AppSettings } from "../../lib/settings";
import type { SettingsSaveState } from "../../lib/settings/storage";

export type SetSettingsFn = (updater: (prev: AppSettings) => AppSettings) => void;

export type SectionId =
  | "system"
  | "shortcuts"
  | "systemTools"
  | "providers"
  | "agents"
  | "ssh"
  | "memory"
  | "usage"
  | "conductor"
  | "capabilities"
  | "connectors"
  | "hooks"
  | "cron"
  | "commandPacks"
  | "services"
  | "about";

export type SettingsPageProps = {
  settings: AppSettings;
  setSettings: SetSettingsFn;
  saveState: SettingsSaveState;
  onBack: () => void;
  initialSection?: SectionId;
  hiddenSections?: SectionId[];
};

export type SettingsSectionProps = {
  settings: AppSettings;
  setSettings: SetSettingsFn;
  saveState?: SettingsSaveState;
};
