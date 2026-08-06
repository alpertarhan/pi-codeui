import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import codeui from "../src/index.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type CommandContext = Parameters<Command["handler"]>[1];

test("/codeui-doctor only notifies in TUI mode", async () => {
  let doctor: Command | undefined;
  codeui({
    registerCommand(name, command) {
      assert.equal(name, "codeui-doctor");
      doctor = command;
    },
  } as ExtensionAPI);

  assert.ok(doctor);
  const notifications: string[] = [];
  const context = (hasUI: boolean, mode: CommandContext["mode"]) => ({
    hasUI,
    mode,
    ui: { notify: (message: string) => { notifications.push(message); } },
  }) as unknown as CommandContext;

  await doctor.handler("", context(false, "print"));
  await doctor.handler("", context(true, "rpc"));
  assert.deepEqual(notifications, []);

  await doctor.handler("", context(true, "tui"));
  assert.match(notifications[0] ?? "", /scaffold loaded/i);
  assert.match(notifications[0] ?? "", /host terminal/i);
});
