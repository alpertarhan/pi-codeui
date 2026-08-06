import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import codeui from "../src/index.ts";

test("/codeui-doctor is safe outside TUI and reports customization ownership in TUI", async () => {
  let doctor: any;
  codeui({
    on: () => {},
    registerCommand(name: string, command: unknown) {
      assert.equal(name, "codeui-doctor");
      doctor = command;
    },
  } as unknown as ExtensionAPI);

  const notifications: string[] = [];
  const context = (hasUI: boolean, mode: string) => ({
    cwd: process.cwd(), hasUI, mode,
    isProjectTrusted: () => false,
    ui: { notify: (message: string) => notifications.push(message) },
  });
  await doctor.handler("", context(false, "print"));
  await doctor.handler("", context(true, "rpc"));
  assert.deepEqual(notifications, []);

  await doctor.handler("", context(true, "tui"));
  assert.match(notifications[0] ?? "", /Global config:/);
  assert.match(notifications[0] ?? "", /Project config:.*untrusted\/ignored/);
  assert.match(notifications[0] ?? "", /Glyph preset: nerd/);
  assert.match(notifications[0] ?? "", /Samples:/);
  assert.match(notifications[0] ?? "", /host terminal/);
});
