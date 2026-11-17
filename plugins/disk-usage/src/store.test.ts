import { expect, test, vi } from "vitest";
import type { PluginAPI } from "@voltius/plugin-types";
import { ScanStore } from "./store";
import { PROBE_COMMAND } from "./scan";

function fakeApi(probe: string) {
  const exec = vi.fn(async (_id: string, command: string) => ({
    stdout: command === PROBE_COMMAND ? probe : "",
    stderr: "",
    code: 0,
  }));
  const streamed: string[] = [];
  const stream = vi.fn((_id: string, command: string) => {
    streamed.push(command);
    return { done: new Promise(() => {}), cancel: () => {} };
  });
  const api = { host: { exec, stream } } as unknown as PluginAPI;
  return { api, exec, streamed };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test("a PowerShell session is scanned with the PowerShell script", async () => {
  const { api, streamed } = fakeApi("%OS%\r\nC:\\Windows\\System32\\WindowsPowerShell\\v1.0\r\n");
  const store = new ScanStore(api);
  store.start("s", "C:\\Users\\me");
  await settle();
  expect(streamed).toHaveLength(1);
  expect(streamed[0]).toMatch(/^powershell -NoProfile/);
  expect(store.get("s")!.tree.root.path).toBe("C:/Users/me");
});

test("a POSIX session keeps du", async () => {
  const { api, streamed } = fakeApi("%OS%\n");
  const store = new ScanStore(api);
  store.start("s", "/var");
  await settle();
  expect(streamed[0]).toMatch(/^sh -c /);
});

test("a POSIX path on a Windows session is refused without running anything", async () => {
  const { api, streamed } = fakeApi("Windows_NT $PSHOME\r\n");
  const store = new ScanStore(api);
  store.start("s", "/");
  await settle();
  expect(streamed).toHaveLength(0);
  expect(store.get("s")).toMatchObject({ phase: "error", lastError: "windowsPath" });
});

test("cancelling while the shell is still being probed stops the scan before it starts", async () => {
  const { api, streamed } = fakeApi("%OS%\n");
  const store = new ScanStore(api);
  store.start("s", "/var");
  store.cancel("s");
  await settle();
  expect(streamed).toHaveLength(0);
  expect(store.get("s")!.phase).toBe("cancelled");
});

test("the shell is probed once per session", async () => {
  const { api, exec } = fakeApi("%OS%\n");
  const store = new ScanStore(api);
  store.start("s", "/var");
  await settle();
  store.start("s", "/home");
  await settle();
  expect(exec.mock.calls.filter(([, c]) => c === PROBE_COMMAND)).toHaveLength(1);
});
