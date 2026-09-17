import type { PluginAPI } from "@voltius/plugin-types";
import { createCloudflareEngine } from "./engine";
import { messages } from "./i18n";
import { createSettingsPage } from "./SettingsPage";

export default function register(api: PluginAPI): () => void {
  api.i18n.register(messages);
  const engine = createCloudflareEngine(api);
  api.ui.registerSettingsPage({
    id: "cloudflare-sync-settings",
    label: () => api.i18n.t("settingsLabel"),
    icon: "simple-icons:cloudflare",
    component: createSettingsPage(api, engine),
  });
  return engine.activate();
}
