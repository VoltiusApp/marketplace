import type { PluginAPI } from "@voltius/plugin-types";
import { createS3Engine } from "./engine";
import { messages } from "./i18n";
import { createSettingsPage } from "./SettingsPage";

export default function register(api: PluginAPI): () => void {
  api.i18n.register(messages);
  const engine = createS3Engine(api);
  api.ui.registerSettingsPage({
    id: "s3-sync-settings",
    label: () => api.i18n.t("settingsLabel"),
    icon: "lucide:database",
    component: createSettingsPage(api, engine),
  });
  return engine.activate();
}
