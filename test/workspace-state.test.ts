import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceStateStore } from "../src/workspace-state.ts";

test("workspace state persists isolated repo UI preferences atomically", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-codeui-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  const first = new WorkspaceStateStore(path, 60_000);
  first.update("/repo/a", { panelWidthPercent: 44, scope: "staged", widgetDock: "collapsed" });
  first.update("/repo/b", { panelWidthPercent: 31 });
  first.flushSync();

  const disk = JSON.parse(await readFile(path, "utf8"));
  assert.equal(disk.version, 1);
  assert.equal(disk.workspaces["/repo/a"].panelWidthPercent, 44);
  const second = new WorkspaceStateStore(path);
  assert.deepEqual(second.get("/repo/a"), { panelWidthPercent: 44, scope: "staged", widgetDock: "collapsed" });
  assert.deepEqual(second.get("/repo/b"), { panelWidthPercent: 31 });
  second.clear("/repo/a");
  second.flushSync();
  assert.deepEqual(new WorkspaceStateStore(path).get("/repo/a"), {});
  second.dispose();
});

test("workspace state clamps values and ignores malformed files safely", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-codeui-state-bad-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  await writeFile(path, "{broken", "utf8");
  const malformed = new WorkspaceStateStore(path);
  assert.match(malformed.warning ?? "", /Unexpected token|JSON/);
  assert.deepEqual(malformed.get("/repo"), {});
  malformed.update("/repo", { panelWidthPercent: 99, scope: "working", widgetDock: "expanded" });
  malformed.flushSync();
  assert.deepEqual(new WorkspaceStateStore(path).get("/repo"), { panelWidthPercent: 70, scope: "working", widgetDock: "expanded" });
});
