import type { PluginAPI } from "@voltius/plugin-types";
import { messages } from "./i18n";
import { createSettingsPage } from "./SettingsPage";
import { init, isConfigured, syncNow, startPoll, stopPoll, push } from "./sync-engine";

/** Same expose contract as gist-sync — host SyncDropdown may call syncNow if present. */
export type CloudflareSyncPublicApi = {
  syncNow(opts?: { showProgress?: boolean }): Promise<void>;
};

export default function register(api: PluginAPI): () => void {
  api.i18n.register(messages);
  init(api);

  api.ui.registerSettingsPage({
    id: "cloudflare-sync-settings",
    label: () => api.i18n.t("settingsLabel"),
    icon: "lucide:cloud",
    component: createSettingsPage(api),
  });

  api.plugins.expose({ syncNow } satisfies CloudflareSyncPublicApi);

  let offBeforeQuit: (() => void) | null = null;
  if (api.isActive()) {
    void (async () => {
      if (!(await isConfigured())) return;
      await syncNow();
      const interval = (await api.storage.get<number>("pollIntervalSeconds")) ?? 60;
      startPoll(interval);
    })();

    offBeforeQuit = api.lifecycle.onBeforeQuit(async () => {
      if (await isConfigured()) await push().catch(() => {});
    });
  }

  return () => {
    stopPoll();
    offBeforeQuit?.();
  };
}
