import type { PluginAPI } from "@voltius/plugin-types";
import { copyText } from "../../shared/vault-sync/src/ui/components";

export async function copyToken(api: PluginAPI, token: string | null): Promise<void> {
  if (!token) throw new Error("No sync token is stored on this device.");
  await copyText(token);
  api.notifications.toast("Sync token copied", { severity: "success" });
}
