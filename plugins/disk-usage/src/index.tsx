import type { PluginAPI } from "@voltius/plugin-types";
import { messages } from "./i18n";
import { createDiskPanel, createMobileDiskScreen } from "./DiskPanel";
import { ScanStore } from "./store";

export default function register(api: PluginAPI): () => void {
  api.i18n.register(messages);
  const store = new ScanStore(api);
  const off = api.ui.registerRightPanelSection({
    id: "disk-usage",
    label: () => api.i18n.t("title"),
    icon: "lucide:hard-drive",
    component: createDiskPanel(api, store),
    order: 45,
  });
  const offMobile = api.ui.registerMobileScreen({
    id: "disk-usage",
    kind: "disk-usage",
    render: createMobileDiskScreen(api, store),
  });
  return () => {
    off();
    offMobile();
    store.dispose();
  };
}
