import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

test("extension module loads when the host pi-tui omits optional helper exports", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-codeui-legacy-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL("../src", import.meta.url), join(root, "src"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));

  const packageDir = async (name: string, source: string) => {
    const directory = join(root, "node_modules", ...name.split("/"));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ name, type: "module", exports: "./index.js" }));
    await writeFile(join(directory, "index.js"), source);
  };
  const piTui = import.meta.resolve("@earendil-works/pi-tui");
  const codingAgent = import.meta.resolve("@earendil-works/pi-coding-agent");
  await packageDir("@earendil-works/pi-tui", `export { Key, matchesKey } from ${JSON.stringify(piTui)};\n`);
  await packageDir("@earendil-works/pi-coding-agent", `export * from ${JSON.stringify(codingAgent)};\n`);

  const extension = await import(`${pathToFileURL(join(root, "src/index.ts")).href}?legacy-host=${Date.now()}`);
  assert.equal(typeof extension.default, "function");
});
